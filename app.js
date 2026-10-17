import {
  parseNumbers, parseLooseNumbers, parsePromo, pickNumber, formatNumber, parseName, setsForTotal,
  buildNameIndex, bestNameMatch, scoreCandidates, isConfident, collectionPrice, collectionTotal,
} from './match.js';
import { detectCard } from './vision.js';

const API = 'https://api.tcgdex.net/v2';
const OCR_LANG = { fr: 'fra', en: 'eng' };
const STORE_KEY = 'collection-v1';

// Where the name and number sit on a card, as fractions of the card size.
// The number is at the bottom left on newer cards and bottom right on older ones,
// so each half of the bottom strip is read on its own.
const CARD_REGIONS = {
  name: { x: 0.03, y: 0.01, w: 0.8, h: 0.12 },
  numbers: [{ x: 0, y: 0.875, w: 0.55, h: 0.12 }, { x: 0.45, y: 0.875, w: 0.55, h: 0.12 }],
};
// For uploaded photos that are not cropped to the card.
const LOOSE_REGIONS = {
  loose: true,
  name: { x: 0, y: 0, w: 1, h: 0.22 },
  numbers: [{ x: 0, y: 0.76, w: 0.55, h: 0.24 }, { x: 0.45, y: 0.76, w: 0.55, h: 0.24 }],
};

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), still: $('still'), frame: $('frame'), finder: $('finder'), finderMsg: $('finder-msg'), hint: $('hint'),
  scan: $('btn-scan'), file: $('file'), status: $('status'), bar: $('bar'), barFill: $('bar-fill'),
  form: $('search-form'), name: $('name'), num: $('num'), manual: $('manual'),
  scrim: $('scrim'), sheet: $('sheet'), sheetInner: $('sheet-inner'),
  viewScan: $('view-scan'), viewCol: $('view-collection'), tabScan: $('tab-scan'), tabCol: $('tab-collection'), badge: $('badge'),
  total: $('total'), totalSub: $('total-sub'), refresh: $('btn-refresh'), refreshBar: $('refresh-bar'), refreshFill: $('refresh-fill'),
  unpriced: $('unpriced'), sort: $('sort'), list: $('list'), exportBtn: $('btn-export'), importInput: $('import'), toast: $('toast'),
};

const state = {
  lang: load('lang', 'fr') === 'en' ? 'en' : 'fr',
  sort: load('sort', 'value'),
  stream: null, worker: null, workerLang: null, busy: false, seq: 0,
  match: null, // { cands, selected, card, qty }
  collection: loadCollection(),
};
const cache = new Map();
const nameIndex = {};

// ---------- Storage ----------
function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function loadCollection() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (!Array.isArray(data)) return [];
    const items = data.filter(validItem);
    for (const it of items) if (it.price && !(it.price.value > 0)) it.price = null; // old versions stored 0
    return items;
  } catch { return []; }
}
function validItem(it) {
  return it && typeof it.id === 'string' && (it.lang === 'fr' || it.lang === 'en') && Number.isFinite(it.qty) && it.qty > 0;
}
function saveCollection() {
  if (!save(STORE_KEY, JSON.stringify(state.collection))) toast('Could not save. Is private browsing on?');
}
const keyOf = (it) => `${it.lang}:${it.id}`;

// ---------- Small UI helpers ----------
function setStatus(text, progress) {
  els.status.textContent = text;
  els.bar.hidden = progress == null;
  if (progress != null) els.barFill.style.width = Math.round(progress * 100) + '%';
}
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
  return n;
}
let toastTimer;
function toast(text, action) {
  clearTimeout(toastTimer);
  els.toast.replaceChildren(el('span', {}, text));
  if (action) els.toast.append(el('button', { type: 'button', onclick: () => { els.toast.hidden = true; action.run(); } }, action.label));
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, action ? 5000 : 3000);
}
const locale = () => (state.lang === 'fr' ? 'fr-FR' : 'en-IE');
const eur = (x) => (x == null ? '–' : new Intl.NumberFormat(locale(), { style: 'currency', currency: 'EUR' }).format(x));
const fmtDate = (d) => new Date(d).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
const imgFor = (image, q) => (image ? `${image}/${q}.webp` : null);
const cardImg = (image, q, alt = '') => {
  const src = imgFor(image, q);
  return src ? el('img', { src, alt, loading: 'lazy' }) : el('div', { class: 'noimg' });
};

function renderLang() {
  for (const b of document.querySelectorAll('.lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
  document.documentElement.lang = state.lang;
}

// ---------- Tabs ----------
function showTab(which) {
  const col = which === 'collection';
  els.viewScan.hidden = col;
  els.viewCol.hidden = !col;
  els.tabScan.setAttribute('aria-selected', String(!col));
  els.tabCol.setAttribute('aria-selected', String(col));
  if (col) renderCollection();
  location.hash = col ? 'collection' : '';
}

// ---------- Data ----------
async function api(lang, path, { fresh = false } = {}) {
  const url = `${API}/${lang}${path}`;
  if (!fresh && cache.has(url)) return cache.get(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const p = fetch(url, { cache: fresh ? 'no-store' : 'default', signal: ctrl.signal })
    .then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Card database error (${r.status})`);
      return r.json();
    })
    .catch((e) => { throw e.name === 'AbortError' ? new Error('The card database is slow to answer. Try again.') : e; })
    .finally(() => clearTimeout(timer));
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

async function getNameIndex(lang) {
  if (!nameIndex[lang]) {
    nameIndex[lang] = fetch(`data/names-${lang}.json`).then((r) => r.json()).then(buildNameIndex).catch(() => []);
  }
  return nameIndex[lang];
}

// Sets from the digital game Pokémon TCG Pocket. They have no physical cards
// and no Cardmarket prices, so they are left out of matching.
const POCKET_FALLBACK = ['A1', 'P-A', 'A1a', 'A2', 'A2a', 'A2b', 'A3', 'A3a', 'A3b', 'A4', 'A4a', 'B1', 'B1a', 'B2', 'B2a'];
let pocketSets;
function getPocketSets() {
  if (!pocketSets) {
    pocketSets = api('en', '/series/tcgp')
      .then((s) => new Set([...POCKET_FALLBACK, ...((s && s.sets) || []).map((x) => x.id)]))
      .catch(() => new Set(POCKET_FALLBACK));
  }
  return pocketSets;
}
const setIdOf = (cardId) => cardId.slice(0, cardId.lastIndexOf('-'));

async function physicalSets(lang) {
  const [sets, pocket] = await Promise.all([api(lang, '/sets'), getPocketSets()]);
  return (sets || []).filter((s) => !pocket.has(s.id));
}

// Builds a short list of cards from what was read and cross-checks each one.
// signals: { numbers: [{ parsed, votes }], promo, texts: [name readings], guess }
async function lookup(lang, signals) {
  const { promo = null, texts = [], guess = '' } = signals;
  const numbers = [...(signals.numbers || [])];
  const pocket = await getPocketSets();
  const pool = new Map();
  const add = (c, set, exact) => { if (!pool.has(c.id)) pool.set(c.id, { ...c, setName: set?.name || c.setName, official: set ? set.cardCount?.official ?? null : c.official, exact, setSizeMatch: !!set }); };

  // 1. Number first: every card with a read number (or one digit off) in sets of that size.
  //    Cards in those sets whose name matches are kept too, in case the number was misread.
  if (promo) {
    const set = await api(lang, `/sets/${promo.setId}`).catch(() => null);
    for (const c of set?.cards || []) add(c, { ...set, cardCount: { official: null } }, true);
    numbers.push({ parsed: promo, votes: 1 });
  }
  // Slash-less readings ("42264") only count when no clean number was read,
  // and only cards whose name matches are kept from them.
  const loose = numbers.length ? [] : (signals.looseNumbers || []);
  numbers.push(...loose);
  const totals = [...new Set(numbers.filter((n) => !n.parsed.promo).map((n) => n.parsed.total))].slice(0, 4);
  if (totals.length) {
    const all = await physicalSets(lang);
    const sets = totals.flatMap((t) => setsForTotal(all, t).map((s) => ({ s, exact: s.cardCount.official === t }))).slice(0, 12);
    const full = await Promise.all(sets.map(({ s }) => api(lang, `/sets/${encodeURIComponent(s.id)}`).catch(() => null)));
    full.forEach((set, i) => { for (const c of set?.cards || []) add(c, set, sets[i].exact); });
  }
  let ranked = scoreCandidates([...pool.values()], { numbers, texts }).filter((c) => c.numScore >= 0.6 || c.nameMatch >= 0.75 || (c.numScore > 0 && c.nameMatch >= 0.55));

  // 2. Nothing convincing from the number: search the database by the best name guess.
  //    Also when only a slash-less reading was found: a chance match there
  //    must compete with every card of that name.
  const onlyLoose = !(signals.numbers || []).length && !promo;
  // The name was read clearly but the number points to a differently named
  // card: the number is probably wrong, so the name gets a say too.
  const contradiction = !!ranked.length && ranked[0].nameMatch < 0.5 && (signals.guessScore || 0) >= 0.85;
  if ((!ranked.length || ranked[0].agree === 'weak' || onlyLoose || contradiction) && guess && guess.length >= 3) {
    const list = ((await api(lang, `/cards?name=${encodeURIComponent(guess)}`)) || [])
      .filter((c) => !pocket.has(setIdOf(c.id)) && !pool.has(c.id)).slice(0, 60);
    ranked = scoreCandidates([...ranked, ...list], { numbers, texts: texts.length ? texts : [guess] });
    // A clearly read name rules out cards with a different name.
    if (contradiction) ranked = ranked.filter((c) => c.nameMatch >= 0.5);
  }
  ranked.contradiction = contradiction;
  window.__lastLookup = { signals, ranked: ranked.slice(0, 12).map((c) => [c.name, c.localId, +c.score.toFixed(2), +c.numScore.toFixed(2), +c.nameMatch.toFixed(2), c.agree]) };
  const top = ranked.slice(0, 12);
  top.contradiction = contradiction;
  return top;
}

// Signals from the two text fields (manual search).
function signalsFromFields(name, num) {
  const parsed = parseNumbers(num);
  return {
    numbers: parsed.map((p) => ({ parsed: p, votes: 1 })),
    promo: parsed.length ? null : parsePromo(num),
    texts: name ? [name] : [],
    guess: name,
    guessScore: name ? 1 : 0,
  };
}

// ---------- Camera ----------
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('This browser has no camera access here. Use Upload photo instead.');
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    els.video.srcObject = state.stream;
    await els.video.play();
    showLive();
    setStatus('Hold the card flat inside the frame, then tap Scan card.');
  } catch {
    setStatus('Camera blocked. Allow camera access for this site, or use Upload photo.');
  }
}
function showLive() {
  els.video.hidden = false; els.still.hidden = true; els.frame.hidden = false;
  els.finderMsg.hidden = true; els.hint.hidden = false;
  els.scan.textContent = 'Scan card';
}

// Copies the part of the video inside the on-screen frame to a canvas.
function grabFrame() {
  const v = els.video;
  const vw = v.videoWidth, vh = v.videoHeight;
  const box = els.finder.getBoundingClientRect();
  const fr = els.frame.getBoundingClientRect();
  const s = Math.max(box.width / vw, box.height / vh);
  const ox = (box.width - vw * s) / 2, oy = (box.height - vh * s) / 2;
  const sx = (fr.left - box.left - ox) / s, sy = (fr.top - box.top - oy) / s;
  const sw = fr.width / s, sh = fr.height / s;
  const c = document.createElement('canvas');
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

// ---------- OCR ----------
async function getWorker() {
  const want = OCR_LANG[state.lang];
  if (state.worker && state.workerLang === want) return state.worker;
  if (state.worker) { await state.worker.terminate(); state.worker = null; }
  if (!window.Tesseract) throw new Error('The text reader did not load. Check your connection and reload.');
  setStatus('Loading the text reader (first time only)…', 0);
  state.worker = await Tesseract.createWorker(want, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') setStatus('Reading card…', m.progress);
      else if (m.progress != null) setStatus('Loading the text reader (first time only)…', m.progress);
    },
  });
  state.workerLang = want;
  return state.worker;
}

// Crops a region and scales it so text is a size the reader likes.
// mode: 'gray' (contrast stretch), 'adapt' (each pixel compared with its
// surroundings: best for small print), 'dark' (keeps only dark, uncoloured
// pixels: black text on a holo or patterned background).
function prep(src, r, { mode = 'gray', targetH = 0, invert = false } = {}) {
  const W = src.width, H = src.height;
  const sx = r.x * W, sy = r.y * H, sw = r.w * W, sh = r.h * H;
  const scale = targetH ? targetH / sh : Math.min(4, Math.max(1, 1600 / sw));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data, n = d.length / 4, cw = c.width, ch = c.height;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let out = g;
  if (mode === 'dark') {
    out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      out[i] = mx < 90 && mx - mn < 60 ? 0 : 255;
    }
  } else if (mode === 'adapt') {
    // Integral image for fast local means.
    const I = new Float64Array((cw + 1) * (ch + 1));
    for (let y = 0; y < ch; y++) {
      let row = 0;
      for (let x = 0; x < cw; x++) { row += g[y * cw + x]; I[(y + 1) * (cw + 1) + x + 1] = I[y * (cw + 1) + x + 1] + row; }
    }
    const rad = Math.max(4, Math.round(ch * 0.5));
    out = new Float32Array(n);
    for (let y = 0; y < ch; y++) {
      const y0 = Math.max(0, y - rad), y1 = Math.min(ch, y + rad);
      for (let x = 0; x < cw; x++) {
        const x0 = Math.max(0, x - rad), x1 = Math.min(cw, x + rad);
        const sum = I[y1 * (cw + 1) + x1] - I[y0 * (cw + 1) + x1] - I[y1 * (cw + 1) + x0] + I[y0 * (cw + 1) + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const dark = g[y * cw + x] < mean * 0.8;
        out[y * cw + x] = (invert ? !dark : dark) ? 0 : 255;
      }
    }
  } else {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[g[i] | 0]++;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
    acc = 0;
    for (; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
    const span = Math.max(1, hi - lo);
    out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.min(255, Math.max(0, ((g[i] - lo) * 255) / span));
      out[i] = invert ? 255 - v : v;
    }
  }
  for (let i = 0; i < n; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = out[i];
  ctx.putImageData(img, 0, 0);
  return c;
}

function linesOf(data) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    out.push({ text: l.text, height: l.bbox ? l.bbox.y1 - l.bbox.y0 : 1 });
  }
  return out.length ? out : [{ text: data.text || '', height: 1 }];
}

// Debug trail of the last scan (read by tests).
window.__scanDebug = [];
async function ocr(worker, canvas, psm, label) {
  await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: '' });
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  window.__scanDebug.push({ label, text: data.text, img: window.__keepImages ? canvas.toDataURL('image/png') : null });
  return data;
}

// Small windows along the bottom of the card, most likely spots first.
// Newer cards print the number bottom left, older ones bottom right.
function numberWindows(regions) {
  if (regions.loose) {
    const out = [];
    for (const y of [0.8, 0.84, 0.88, 0.92]) for (const x of [0, 0.3, 0.6]) out.push({ x, y, w: 0.4, h: 0.05 });
    return out;
  }
  const out = [];
  for (const y of [0.925, 0.94, 0.91, 0.955, 0.895]) for (const x of [0, 0.6, 0.3]) out.push({ x, y, w: 0.4, h: 0.045 });
  return out;
}

async function readNumber(worker, canvas, regions, sets) {
  const votes = new Map();
  const loose = new Map();
  const seen = [];
  const take = (text) => {
    seen.push(text);
    for (const p of parseNumbers(text)) {
      if (!pickNumber([p], sets)) continue; // set size must exist
      const key = `${p.number}/${p.total}`;
      const v = votes.get(key) || { parsed: p, votes: 0 };
      v.votes++;
      votes.set(key, v);
    }
    for (const p of parseLooseNumbers(text)) {
      if (!pickNumber([p], sets)) continue;
      const key = `${p.number}/${p.total}`;
      if (!loose.has(key)) loose.set(key, { parsed: p, votes: 0.5 });
    }
  };
  const windows = numberWindows(regions);
  for (const r of windows) {
    take((await ocr(worker, prep(canvas, r, { mode: 'adapt', targetH: 140 }), '6', 'number')).text);
    if ([...votes.values()].some((v) => v.votes >= 2)) break; // read the same number twice
  }
  // Nothing clean: read the most likely windows again in plain grayscale.
  if (!votes.size) {
    for (const r of windows.slice(0, 6)) take((await ocr(worker, prep(canvas, r, { mode: 'gray', targetH: 140 }), '6', 'number')).text);
  }
  // Still nothing: promo numbers like SM57 are short words among graphics,
  // which the "sparse text" mode reads better.
  if (!votes.size && !parsePromo(seen.join(' '))) {
    for (const r of windows.slice(0, 6)) {
      take((await ocr(worker, prep(canvas, r, { mode: 'adapt', targetH: 140 }), '12', 'number')).text);
      if (parsePromo(seen.join(' '))) break;
    }
  }
  const numbers = [...votes.values()].sort((a, b) => b.votes - a.votes);
  return {
    numbers,
    looseNumbers: numbers.length ? [] : [...loose.values()],
    // No "136/189" style number: look for a promo number such as SM57.
    promo: numbers.length ? null : parsePromo(seen.join(' ')),
  };
}

// Reads the name line and returns the closest known card name.
async function readName(worker, canvas, regions, index) {
  const region = regions.loose ? { x: 0.05, y: 0.02, w: 0.8, h: 0.2 } : { x: 0.05, y: 0.025, w: 0.72, h: 0.07 };
  const psm = regions.loose ? '11' : '7';
  let best = null, raw = '';
  const texts = [];
  const mid = regions.loose ? region : { x: 0.12, y: 0.025, w: 0.5, h: 0.07 };
  const tries = [
    [region, { mode: 'gray', targetH: 120 }], [region, { mode: 'dark', targetH: 110 }], [mid, { mode: 'gray', targetH: 110 }],
    [mid, { mode: 'dark', targetH: 110 }], [region, { mode: 'adapt', targetH: 120, invert: true }],
  ];
  for (const [r, opts] of tries) {
    const data = await ocr(worker, prep(canvas, r, opts), psm, 'name');
    const lines = linesOf(data);
    texts.push(...lines.map((l) => l.text));
    for (const l of lines) {
      const hit = bestNameMatch(l.text, index);
      if (hit && (!best || hit.score > best.score)) best = hit;
    }
    if (!raw) raw = parseName(lines);
    if (best && best.score >= 0.9) break;
  }
  return { texts, guess: best && best.score >= 0.7 ? best.name : raw, guessScore: best && best.score >= 0.7 ? best.score : 0 };
}

async function readCard(canvas, regions) {
  window.__scanDebug = [];
  const lang = state.lang;
  const [worker, sets, index] = await Promise.all([getWorker(), physicalSets(lang).catch(() => null), getNameIndex(lang)]);
  setStatus('Reading card…', 0);
  const { numbers, looseNumbers, promo } = await readNumber(worker, canvas, regions, sets);
  const { texts, guess, guessScore } = await readName(worker, canvas, regions, index);
  return { numbers, looseNumbers, promo, texts, guess, guessScore };
}

// ---------- Scan flow ----------
// Finds the card in the picture and returns a canvas with just the card,
// or null when no card shape is found.
function cropToCard(src) {
  const small = document.createElement('canvas');
  const s = Math.min(1, 400 / src.width);
  small.width = Math.round(src.width * s); small.height = Math.round(src.height * s);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, small.width, small.height);
  const box = detectCard(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height);
  if (!box) return null;
  const out = document.createElement('canvas');
  out.width = Math.round(box.w / s); out.height = Math.round(box.h / s);
  out.getContext('2d').drawImage(src, box.x / s, box.y / s, box.w / s, box.h / s, 0, 0, out.width, out.height);
  return out;
}

async function runScan(canvas, regions) {
  if (state.busy) return;
  state.busy = true;
  els.scan.disabled = true;
  closeSheet();
  try {
    const signals = await readCard(canvas, regions);
    els.name.value = signals.guess || '';
    els.num.value = formatNumber(signals.numbers[0]?.parsed || signals.promo);
    if (!signals.guess && !signals.numbers.length && !signals.promo) {
      setStatus('Could not read the card. Try more light and less glare, or type the name or number.');
      els.manual.open = true;
      return;
    }
    await search(signals);
  } catch (e) {
    setStatus(e.message || 'Something went wrong while reading the card.');
  } finally {
    state.busy = false;
    els.scan.disabled = false;
  }
}

async function search(scanSignals) {
  const name = els.name.value.trim();
  const num = els.num.value.trim();
  if (!scanSignals && !name && !num) { setStatus('Type a name or a number like 136/189.'); return; }
  const signals = scanSignals || signalsFromFields(name, num);
  const seq = ++state.seq;
  const lang = state.lang;
  setStatus('Looking up the card…');
  try {
    const cands = await lookup(lang, signals);
    if (seq !== state.seq) return;
    if (!cands.length) {
      setStatus(`No ${lang === 'fr' ? 'French' : 'English'} card found for “${[name, num].filter(Boolean).join(' ')}”. Check FR/EN, or fix the name or number.`);
      els.manual.open = true;
      return;
    }
    const a = cands[0];
    const sure = isConfident(cands) && !(cands.contradiction && cands[0].agree !== 'both');
    state.match = { lang, cands, selected: 0, card: null, qty: 1, sure };
    setStatus(sure ? `Found ${a.name}.` : `${cands.length} possible cards. Pick yours.`);
    await selectCandidate(0, seq);
  } catch (e) {
    setStatus(e.message === 'Failed to fetch' ? 'No connection to the card database. Check your internet.' : e.message);
  }
}

async function selectCandidate(i, seq = ++state.seq) {
  const m = state.match;
  if (!m) return;
  m.selected = i;
  m.card = null;
  m.error = null;
  renderSheet();
  let card = null;
  try {
    card = await api(m.lang, `/cards/${encodeURIComponent(m.cands[i].id)}`);
    if (!card) m.error = 'This card has no details in the database.';
  } catch (e) {
    m.error = e.message === 'Failed to fetch' ? 'No connection to the card database.' : e.message;
  }
  if (seq !== state.seq || state.match !== m || m.selected !== i) return;
  m.card = card;
  renderSheet();
}

// ---------- Sheet ----------
function openSheet() {
  els.toast.hidden = true;
  els.scrim.hidden = false;
  els.sheet.hidden = false;
}
function closeSheet() {
  els.scrim.hidden = true;
  els.sheet.hidden = true;
}

function renderSheet() {
  const m = state.match;
  if (!m) return;
  const c = m.cands[m.selected];
  const card = m.card;
  const price = card ? collectionPrice(card.pricing?.cardmarket, card.variants) : null;
  const cmk = card?.pricing?.cardmarket;
  const trend = price?.holo ? cmk?.['trend-holo'] : cmk?.trend ?? cmk?.['trend-holo'];
  const owned = state.collection.find((it) => keyOf(it) === `${m.lang}:${c.id}`);
  const qtyOut = el('output', {}, m.qty);
  const setQty = (q) => { m.qty = Math.max(1, Math.min(99, q)); qtyOut.textContent = m.qty; };

  els.sheetInner.replaceChildren(...[
    el('div', { class: 'grab' }),
    el('div', { class: 'sheet-head' },
      el('div', { class: 'label', id: 'sheet-title' }, m.sure ? 'Match' : 'Is this your card?'),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: closeSheet }, '×')),
    el('div', { class: 'match' },
      cardImg(card?.image || c.image, 'high', c.name),
      el('div', { class: 'meta' },
        el('h2', {}, card?.name || c.name),
        el('div', {}, card?.set?.name || c.setName || ''),
        el('div', { class: 'num' }, `${c.localId}${c.official ? '/' + c.official : ''}`),
        card?.rarity ? el('div', {}, card.rarity) : null,
        el('div', { class: 'price-big' }, card ? (price ? eur(price.value) : 'No price') : m.error ? '?' : '…'),
        el('div', {}, card
          ? (price ? `30-day average${price.holo ? ' (holo)' : ''}${trend > 0 ? ` · trend ${eur(trend)}` : ''}` : 'Cardmarket has no recent sales for this card.')
          : m.error ? m.error : 'Loading price…'),
        m.error ? el('button', { type: 'button', class: 'btn small quiet', onclick: () => selectCandidate(m.selected) }, 'Try again') : null,
        owned ? el('div', { class: 'num' }, `You have ${owned.qty}`) : null,
        c.agree ? el('div', { class: 'check' }, {
          both: '✓ Number and name match', number: '✓ Number matches · name unclear',
          name: '✓ Name matches · number unclear', weak: 'Unsure: check the picture',
        }[c.agree]) : null)),
    el('div', { class: 'add-row' },
      el('div', { class: 'stepper' },
        el('button', { type: 'button', 'aria-label': 'One less', onclick: () => setQty(m.qty - 1) }, '−'),
        qtyOut,
        el('button', { type: 'button', 'aria-label': 'One more', onclick: () => setQty(m.qty + 1) }, '+')),
      el('button', { type: 'button', class: 'btn primary', onclick: addToCollection }, 'Add to collection')),
    m.cands.length > 1 ? el('div', { class: 'label' }, 'Not this card? Pick another') : null,
    m.cands.length > 1 ? el('div', { class: 'alts' }, m.cands.map((x, i) => el('button', {
      type: 'button', class: 'alt', 'aria-current': String(i === m.selected), onclick: () => selectCandidate(i),
    }, cardImg(x.image, 'low'), el('b', {}, x.name), el('small', {}, `${x.setName || setIdOf(x.id)} · ${x.localId}`)))) : null,
    el('p', { class: 'note' }, 'Cardmarket lists one price for a card across all languages, so French and English copies show the same price.'),
  ].filter(Boolean));
  openSheet();
}

function addToCollection() {
  const m = state.match;
  // Close first, so the sheet never stays open, whatever happens next.
  closeSheet();
  if (!m) return;
  const c = m.cands[m.selected];
  const card = m.card;
  const key = `${m.lang}:${c.id}`;
  const added = m.qty;
  let item = state.collection.find((it) => keyOf(it) === key);
  if (item) {
    item.qty += added;
  } else {
    item = {
      id: c.id, lang: m.lang, name: card?.name || c.name, setName: card?.set?.name || c.setName || '', localId: card?.localId || c.localId,
      official: 'official' in c ? c.official : card?.set?.cardCount?.official || null, image: card?.image || c.image || null, qty: added, added: Date.now(),
      price: null, priceUpdated: null,
    };
    state.collection.push(item);
  }
  if (card) {
    const cm = card.pricing?.cardmarket;
    item.price = collectionPrice(cm, card.variants);
    item.priceUpdated = cm?.updated || item.priceUpdated;
  } else {
    // Price was not loaded yet: fetch it in the background.
    api(m.lang, `/cards/${encodeURIComponent(c.id)}`).then((full) => {
      if (!full) return;
      const cm = full.pricing?.cardmarket;
      item.price = collectionPrice(cm, full.variants);
      item.priceUpdated = cm?.updated || null;
      saveCollection();
      if (!els.viewCol.hidden) renderCollection();
    }).catch(() => {});
  }
  saveCollection();
  renderBadge();
  state.match = null;
  setStatus('Ready for the next card.');
  toast(`Added ${added}× ${item.name}`, {
    label: 'Undo',
    run: () => {
      const it = state.collection.find((x) => keyOf(x) === key);
      if (!it) return;
      it.qty -= added;
      if (it.qty <= 0) state.collection = state.collection.filter((x) => x !== it);
      saveCollection(); renderBadge(); renderCollection();
    },
  });
}

// ---------- Collection ----------
function renderBadge() {
  const n = state.collection.reduce((s, it) => s + it.qty, 0);
  els.badge.textContent = n;
  els.badge.hidden = n === 0;
}

function sortedItems() {
  const items = [...state.collection];
  if (state.sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
  else if (state.sort === 'added') items.sort((a, b) => (b.added || 0) - (a.added || 0));
  else items.sort((a, b) => (b.price?.value ?? -1) * b.qty - (a.price?.value ?? -1) * a.qty);
  return items;
}

function renderCollection() {
  const t = collectionTotal(state.collection);
  els.total.textContent = eur(t.total);
  const unique = state.collection.length;
  const dates = state.collection.map((it) => it.priceUpdated).filter(Boolean).sort();
  els.totalSub.textContent = t.count
    ? `${t.count} card${t.count === 1 ? '' : 's'} · ${unique} different${dates.length ? ` · prices from ${fmtDate(dates[0])}` : ''}`
    : 'No cards yet';
  els.unpriced.hidden = !t.unpriced;
  els.unpriced.textContent = `${t.unpriced} card${t.unpriced === 1 ? ' has' : 's have'} no Cardmarket price and ${t.unpriced === 1 ? 'is' : 'are'} not counted.`;
  els.refresh.disabled = !unique;
  els.exportBtn.disabled = !unique;
  els.sort.value = state.sort;

  if (!unique) {
    els.list.replaceChildren(el('div', { class: 'empty' }, 'Your collection is empty. Scan a card and tap Add to collection.'));
    return;
  }
  els.list.replaceChildren(...sortedItems().map((it) => {
    const qty = el('output', {}, it.qty);
    const change = (d) => {
      it.qty += d;
      if (it.qty <= 0) {
        state.collection = state.collection.filter((x) => x !== it);
        toast(`Removed ${it.name}`, { label: 'Undo', run: () => { it.qty = 1; state.collection.push(it); saveCollection(); renderBadge(); renderCollection(); } });
      }
      saveCollection(); renderBadge(); renderCollection();
    };
    return el('div', { class: 'row' },
      cardImg(it.image, 'low'),
      el('div', { class: 'row-main' },
        el('b', {}, it.name),
        el('small', {}, el('span', { class: 'chip' }, it.lang.toUpperCase()), `${it.setName} · ${it.localId}${it.official ? '/' + it.official : ''}`),
        el('small', {}, it.price ? `${eur(it.price.value)} each${it.price.holo ? ' (holo)' : ''}` : 'No recent sales on Cardmarket')),
      el('div', { class: 'row-side' },
        el('strong', {}, it.price ? eur(it.price.value * it.qty) : '–'),
        el('div', { class: 'stepper' },
          el('button', { type: 'button', 'aria-label': `One less ${it.name}`, onclick: () => change(-1) }, '−'),
          qty,
          el('button', { type: 'button', 'aria-label': `One more ${it.name}`, onclick: () => change(1) }, '+'))));
  }));
}

async function refreshPrices() {
  const items = state.collection;
  if (!items.length) return;
  els.refresh.disabled = true;
  els.refreshBar.hidden = false;
  let done = 0, failed = 0;
  const queue = [...items];
  const work = async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        const card = await api(it.lang, `/cards/${encodeURIComponent(it.id)}`, { fresh: true });
        if (card) {
          const cm = card.pricing?.cardmarket;
          it.price = collectionPrice(cm, card.variants);
          it.priceUpdated = cm?.updated || it.priceUpdated;
          if (card.image) it.image = card.image;
        }
      } catch { failed++; }
      done++;
      els.refreshFill.style.width = Math.round((done / items.length) * 100) + '%';
      els.refresh.textContent = `Updating ${done}/${items.length}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, work));
  saveCollection();
  els.refresh.textContent = 'Refresh prices';
  els.refreshBar.hidden = true;
  renderCollection();
  toast(failed ? `Updated, but ${failed} card${failed === 1 ? '' : 's'} failed. Try again later.` : 'Prices updated');
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: 'card-scan', version: 1, exported: new Date().toISOString(), cards: state.collection }, null, 1)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `card-collection-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const cards = (Array.isArray(data) ? data : data.cards || []).filter(validItem);
    if (!cards.length) { toast('No cards found in that file.'); return; }
    let added = 0, updated = 0;
    for (const c of cards) {
      const ex = state.collection.find((it) => keyOf(it) === keyOf(c));
      if (ex) { ex.qty = c.qty; updated++; } else { state.collection.push(c); added++; }
    }
    saveCollection(); renderBadge(); renderCollection();
    toast(`Imported: ${added} new, ${updated} updated.`);
  } catch {
    toast('That file is not a valid backup.');
  }
}

// ---------- Events ----------
els.scan.addEventListener('click', () => {
  if (!state.stream) return startCamera();
  if (els.video.hidden) { showLive(); return; }
  const frame = grabFrame();
  runScan(cropToCard(frame) || frame, CARD_REGIONS);
});

els.file.addEventListener('change', async () => {
  const f = els.file.files?.[0];
  if (!f) return;
  setStatus('Reading photo…');
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { setStatus('That file is not an image I can read.'); return; }
  els.still.src = url;
  els.still.hidden = false; els.video.hidden = true; els.frame.hidden = true; els.finderMsg.hidden = true; els.hint.hidden = true;
  if (state.stream) els.scan.textContent = 'Back to camera';
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  els.file.value = '';
  const card = cropToCard(c);
  const cropped = card || Math.abs(c.width / c.height - 63 / 88) < 0.08 ? (card || c) : null;
  await runScan(cropped || c, cropped ? CARD_REGIONS : LOOSE_REGIONS);
});

els.form.addEventListener('submit', (e) => { e.preventDefault(); search(); });
els.scrim.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.sheet.hidden) closeSheet(); });
els.tabScan.addEventListener('click', () => showTab('scan'));
els.tabCol.addEventListener('click', () => { closeSheet(); showTab('collection'); });
els.refresh.addEventListener('click', refreshPrices);
els.sort.addEventListener('change', () => { state.sort = els.sort.value; save('sort', state.sort); renderCollection(); });
els.exportBtn.addEventListener('click', exportBackup);
els.importInput.addEventListener('change', () => { const f = els.importInput.files?.[0]; els.importInput.value = ''; if (f) importBackup(f); });

for (const b of document.querySelectorAll('.lang button')) {
  b.addEventListener('click', () => {
    if (state.lang === b.dataset.lang) return;
    state.lang = b.dataset.lang;
    save('lang', state.lang);
    renderLang();
    closeSheet();
    setStatus(`Scanning ${state.lang === 'fr' ? 'French' : 'English'} cards.`);
    getNameIndex(state.lang);
  });
}

// Show unexpected errors on screen, so they can be reported.
window.addEventListener('error', (e) => toast(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => toast(`Error: ${e.reason?.message || e.reason}`));

renderLang();
renderBadge();
getNameIndex(state.lang);
showTab(location.hash === '#collection' ? 'collection' : 'scan');
