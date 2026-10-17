import {
  parseNumbers, pickNumber, formatNumber, parseName, setsForTotal, sameLocalId, rankCandidates,
  buildNameIndex, bestNameMatch, collectionPrice, collectionTotal,
} from './match.js';

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
    return Array.isArray(data) ? data.filter(validItem) : [];
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
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, action ? 6000 : 3000);
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
  const p = fetch(url, fresh ? { cache: 'no-store' } : undefined).then(async (r) => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Card database error (${r.status})`);
    return r.json();
  });
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

async function findCandidates(lang, name, numText) {
  const parsed = pickNumber(parseNumbers(numText), null);
  let cards = [];
  if (parsed) {
    const sets = setsForTotal((await api(lang, '/sets')) || [], parsed.total).slice(0, 10);
    const full = await Promise.all(sets.map((s) => api(lang, `/sets/${encodeURIComponent(s.id)}`).catch(() => null)));
    for (const set of full) {
      if (!set || !set.cards) continue;
      for (const c of set.cards) if (sameLocalId(c.localId, parsed)) cards.push({ ...c, setName: set.name, official: set.cardCount?.official });
    }
  }
  if (!cards.length && name && name.trim().length >= 3) {
    const list = (await api(lang, `/cards?name=${encodeURIComponent(name.trim())}`)) || [];
    cards = list.slice(0, 60);
    if (parsed) {
      const sameNum = cards.filter((c) => sameLocalId(c.localId, parsed));
      if (sameNum.length) cards = sameNum;
    }
  }
  return rankCandidates(cards, name).slice(0, 12);
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

// Crops a region, enlarges it and boosts contrast so small print reads better.
function prep(src, r, invert = false) {
  const W = src.width, H = src.height;
  const sx = r.x * W, sy = r.y * H, sw = r.w * W, sh = r.h * H;
  const scale = Math.min(4, Math.max(1, 1600 / sw));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = g; hist[g]++;
  }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < total * 0.02; hi--);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let g = Math.min(255, Math.max(0, ((d[i] - lo) * 255) / span));
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
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

async function ocr(worker, canvas, mode) {
  await worker.setParameters({
    tessedit_pageseg_mode: mode === 'number' ? '11' : '6',
    tessedit_char_whitelist: mode === 'number' ? '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '',
  });
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  return data;
}

async function readNumber(worker, canvas, regions, sets) {
  for (const invert of [false, true]) {
    const found = [];
    for (const r of regions.numbers) found.push(...parseNumbers((await ocr(worker, prep(canvas, r, invert), 'number')).text));
    const pick = pickNumber(found, sets);
    if (pick) return pick;
  }
  return null;
}

// Picks the name: closest known card name first, raw OCR text as a fallback.
async function readName(worker, canvas, region, index) {
  for (const invert of [false, true]) {
    const lines = linesOf(await ocr(worker, prep(canvas, region, invert), 'name'));
    const byHeight = [...lines].sort((a, b) => b.height - a.height);
    for (const l of byHeight.slice(0, 3)) {
      const hit = bestNameMatch(l.text, index);
      if (hit && hit.score >= 0.7) return hit.name;
    }
    const hit = bestNameMatch(lines.map((l) => l.text).join(' '), index);
    if (hit) return hit.name;
    const raw = parseName(lines);
    if (raw) return raw;
  }
  return '';
}

async function readCard(canvas, regions) {
  const lang = state.lang;
  const [worker, sets, index] = await Promise.all([getWorker(), api(lang, '/sets').catch(() => null), getNameIndex(lang)]);
  setStatus('Reading card…', 0);
  let number = await readNumber(worker, canvas, regions, sets);
  let name = await readName(worker, canvas, regions.name, index);
  if (!number || !name) {
    // Last try for loose photos: read the whole image.
    const all = await ocr(worker, prep(canvas, { x: 0, y: 0, w: 1, h: 1 }), 'name');
    if (!number) number = pickNumber(parseNumbers(all.text), sets);
    if (!name) name = bestNameMatch(all.text, index)?.name || '';
  }
  return { name, number: formatNumber(number) };
}

// ---------- Scan flow ----------
async function runScan(canvas, regions) {
  if (state.busy) return;
  state.busy = true;
  els.scan.disabled = true;
  closeSheet();
  try {
    const { name, number } = await readCard(canvas, regions);
    els.name.value = name;
    els.num.value = number;
    if (!name && !number) {
      setStatus('Could not read the card. Try more light and less glare, or type the name or number.');
      els.manual.open = true;
      return;
    }
    await search();
  } catch (e) {
    setStatus(e.message || 'Something went wrong while reading the card.');
  } finally {
    state.busy = false;
    els.scan.disabled = false;
  }
}

async function search() {
  const name = els.name.value.trim();
  const num = els.num.value.trim();
  if (!name && !num) { setStatus('Type a name or a number like 136/189.'); return; }
  const seq = ++state.seq;
  const lang = state.lang;
  setStatus('Looking up the card…');
  try {
    const cands = await findCandidates(lang, name, num);
    if (seq !== state.seq) return;
    if (!cands.length) {
      setStatus(`No ${lang === 'fr' ? 'French' : 'English'} card found for “${[name, num].filter(Boolean).join(' ')}”. Check FR/EN, or fix the name or number.`);
      els.manual.open = true;
      return;
    }
    const [a, b] = cands;
    const sure = cands.length === 1 || (a.score >= 0.75 && (!b || a.score - b.score >= 0.15));
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
  renderSheet();
  const card = await api(m.lang, `/cards/${encodeURIComponent(m.cands[i].id)}`).catch(() => null);
  if (seq !== state.seq || state.match !== m || m.selected !== i) return;
  m.card = card;
  renderSheet();
}

// ---------- Sheet ----------
function openSheet() {
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

  els.sheetInner.replaceChildren(
    el('div', { class: 'grab' }),
    el('div', { class: 'sheet-head' },
      el('div', { class: 'label', id: 'sheet-title' }, m.sure ? 'Match' : 'Is this your card?'),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: closeSheet }, '×')),
    el('div', { class: 'match' },
      cardImg(card?.image || c.image, 'high', c.name),
      el('div', { class: 'meta' },
        el('h2', {}, card?.name || c.name),
        el('div', {}, card?.set?.name || c.setName || ''),
        el('div', { class: 'num' }, `${c.localId}${(card?.set?.cardCount?.official || c.official) ? '/' + (card?.set?.cardCount?.official || c.official) : ''}`),
        card?.rarity ? el('div', {}, card.rarity) : null,
        el('div', { class: 'price-big' }, card ? eur(price?.value) : '…'),
        el('div', {}, card
          ? (price ? `30-day average${price.holo ? ' (holo)' : ''} · trend ${eur(trend)}` : 'No Cardmarket price listed')
          : 'Loading price…'),
        owned ? el('div', { class: 'num' }, `You have ${owned.qty}`) : null)),
    el('div', { class: 'add-row' },
      el('div', { class: 'stepper' },
        el('button', { type: 'button', 'aria-label': 'One less', onclick: () => setQty(m.qty - 1) }, '−'),
        qtyOut,
        el('button', { type: 'button', 'aria-label': 'One more', onclick: () => setQty(m.qty + 1) }, '+')),
      el('button', { type: 'button', class: 'btn primary', disabled: !card, onclick: addToCollection }, 'Add to collection')),
    m.cands.length > 1 ? el('div', { class: 'label' }, 'Not this card? Pick another') : null,
    m.cands.length > 1 ? el('div', { class: 'alts' }, m.cands.map((x, i) => el('button', {
      type: 'button', class: 'alt', 'aria-current': String(i === m.selected), onclick: () => selectCandidate(i),
    }, cardImg(x.image, 'low'), el('b', {}, x.name), el('small', {}, `${x.setName ? x.setName + ' · ' : ''}${x.localId}`)))) : null,
    el('p', { class: 'note' }, 'Cardmarket lists one price for a card across all languages, so French and English copies show the same price.'),
  );
  openSheet();
}

function addToCollection() {
  const m = state.match;
  const card = m?.card;
  if (!card) return;
  const key = `${m.lang}:${card.id}`;
  const existing = state.collection.find((it) => keyOf(it) === key);
  const cm = card.pricing?.cardmarket;
  if (existing) {
    existing.qty += m.qty;
  } else {
    state.collection.push({
      id: card.id, lang: m.lang, name: card.name, setName: card.set?.name || '', localId: card.localId,
      official: card.set?.cardCount?.official || null, image: card.image || null, qty: m.qty, added: Date.now(),
      price: collectionPrice(cm, card.variants), priceUpdated: cm?.updated || null,
    });
  }
  saveCollection();
  renderBadge();
  const added = m.qty;
  closeSheet();
  setStatus('Ready for the next card.');
  toast(`Added ${added}× ${card.name}`, {
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
        el('small', {}, it.price ? `${eur(it.price.value)} each${it.price.holo ? ' (holo)' : ''}` : 'No price')),
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
  runScan(grabFrame(), CARD_REGIONS);
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
  const cropped = Math.abs(c.width / c.height - 63 / 88) < 0.08;
  await runScan(c, cropped ? CARD_REGIONS : LOOSE_REGIONS);
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

renderLang();
renderBadge();
getNameIndex(state.lang);
showTab(location.hash === '#collection' ? 'collection' : 'scan');
