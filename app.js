import { parseNumber, parseName, setsForTotal, sameLocalId, rankCandidates } from './match.js';

const API = 'https://api.tcgdex.net/v2';
const OCR_LANG = { fr: 'fra', en: 'eng' };

// Where the name and number sit on a card, as fractions of the card size.
const REGIONS = {
  name: { x: 0.03, y: 0.015, w: 0.8, h: 0.11 },
  number: { x: 0.0, y: 0.89, w: 1.0, h: 0.1 },
};

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), still: $('still'), frame: $('frame'), finder: $('finder'), finderMsg: $('finder-msg'),
  hint: $('hint'), scan: $('btn-scan'), file: $('file'), status: $('status'), bar: $('bar'), barFill: $('bar-fill'),
  form: $('search-form'), name: $('name'), num: $('num'), candsPanel: $('cands-panel'), cands: $('cands'),
  candsTitle: $('cands-title'), result: $('result-panel'),
};

const state = { lang: loadLang(), stream: null, worker: null, workerLang: null, busy: false, cardId: null, seq: 0 };
const cache = new Map();

function loadLang() {
  try { return localStorage.getItem('lang') === 'en' ? 'en' : 'fr'; } catch { return 'fr'; }
}
function saveLang(l) {
  try { localStorage.setItem('lang', l); } catch { /* storage blocked */ }
}

// ---------- UI helpers ----------
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
    else if (v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
  return n;
}
function renderLang() {
  for (const b of document.querySelectorAll('.lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
  document.documentElement.lang = state.lang;
}

// ---------- Data ----------
async function api(path) {
  const url = `${API}/${state.lang}${path}`;
  if (cache.has(url)) return cache.get(url);
  const p = fetch(url).then(async (r) => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Card database error (${r.status})`);
    return r.json();
  });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

async function findCandidates(name, numText) {
  const parsed = parseNumber(numText);
  let cards = [];
  if (parsed) {
    const sets = setsForTotal((await api('/sets')) || [], parsed.total).slice(0, 10);
    const full = await Promise.all(sets.map((s) => api(`/sets/${encodeURIComponent(s.id)}`).catch(() => null)));
    for (const set of full) {
      if (!set || !set.cards) continue;
      for (const c of set.cards) if (sameLocalId(c.localId, parsed)) cards.push({ ...c, setName: set.name, official: set.cardCount?.official });
    }
  }
  if (!cards.length && name && name.trim().length >= 3) {
    const list = (await api(`/cards?name=${encodeURIComponent(name.trim())}`)) || [];
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
    els.scan.textContent = 'Scan card';
    setStatus('Hold the card flat inside the frame, then tap Scan card.');
  } catch (e) {
    setStatus('Camera blocked. Allow camera access for this site, or use Upload photo.');
  }
}
function showLive() {
  els.video.hidden = false; els.still.hidden = true; els.frame.hidden = false;
  els.finderMsg.hidden = true; els.hint.hidden = false;
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

async function readCard(canvas, regions = REGIONS) {
  const worker = await getWorker();
  setStatus('Reading card…', 0);
  let numData = await ocr(worker, prep(canvas, regions.number), 'number');
  let parsed = parseNumber(numData.text);
  if (!parsed) {
    numData = await ocr(worker, prep(canvas, regions.number, true), 'number');
    parsed = parseNumber(numData.text);
  }
  let nameData = await ocr(worker, prep(canvas, regions.name), 'name');
  let name = parseName(linesOf(nameData));
  if (!name) {
    nameData = await ocr(worker, prep(canvas, regions.name, true), 'name');
    name = parseName(linesOf(nameData));
  }
  // Last try for loose photos: read the whole image.
  if (!parsed || !name) {
    const all = await ocr(worker, prep(canvas, { x: 0, y: 0, w: 1, h: 1 }), 'name');
    if (!parsed) parsed = parseNumber(all.text);
    if (!name) name = parseName(linesOf(all));
  }
  return { name, number: parsed ? `${parsed.number}/${parsed.prefix}${parsed.total}` : '' };
}

// ---------- Flow ----------
async function runScan(canvas, regions) {
  if (state.busy) return;
  state.busy = true;
  els.scan.disabled = true;
  els.result.hidden = true;
  els.candsPanel.hidden = true;
  state.cardId = null;
  try {
    const { name, number } = await readCard(canvas, regions);
    els.name.value = name;
    els.num.value = number;
    if (!name && !number) {
      setStatus('Could not read the card. Try more light, less glare, or type the name or number below.');
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
  setStatus('Looking up the card…');
  els.result.hidden = true;
  try {
    const cands = await findCandidates(name, num);
    if (seq !== state.seq) return;
    renderCandidates(cands);
    if (!cands.length) {
      setStatus(`No ${state.lang === 'fr' ? 'French' : 'English'} card found. Check the language switch, or fix the name or number.`);
      return;
    }
    const [a, b] = cands;
    const sure = cands.length === 1 || (a.score >= 0.75 && (!b || a.score - b.score >= 0.15));
    if (sure) await showCard(a.id, seq);
    else setStatus(`${cands.length} possible cards. Tap the one you have.`);
  } catch (e) {
    setStatus(e.message === 'Failed to fetch' ? 'No connection to the card database. Check your internet.' : e.message);
  }
}

function imgFor(card, quality) {
  return card.image ? `${card.image}/${quality}.webp` : null;
}

function renderCandidates(cands) {
  els.cands.replaceChildren();
  els.candsPanel.hidden = !cands.length;
  els.candsTitle.textContent = cands.length === 1 ? 'Match' : `${cands.length} possible matches`;
  cands.forEach((c, i) => {
    const src = imgFor(c, 'low');
    els.cands.append(el('button', {
      type: 'button', class: 'cand' + (i === 0 && c.score >= 0.75 ? ' best' : ''), onclick: () => showCard(c.id),
      'aria-label': `${c.name}, ${c.setName || c.id}`,
    },
    src ? el('img', { src, alt: '', loading: 'lazy' }) : el('div', { class: 'noimg' }),
    el('b', {}, c.name),
    el('small', {}, `${c.setName ? c.setName + ' · ' : ''}${c.localId}${c.official ? '/' + c.official : ''}`)));
  });
}

const money = () => new Intl.NumberFormat(state.lang === 'fr' ? 'fr-FR' : 'en-IE', { style: 'currency', currency: 'EUR' });

async function showCard(id, seq = ++state.seq) {
  setStatus('Loading price…');
  const card = await api(`/cards/${encodeURIComponent(id)}`).catch(() => null);
  if (seq !== state.seq) return;
  if (!card) {
    els.result.hidden = true;
    setStatus(`This card is not in the ${state.lang === 'fr' ? 'French' : 'English'} database.`);
    return;
  }
  state.cardId = id;
  const cm = card.pricing?.cardmarket;
  const fmt = money();
  const v = (x) => (x == null ? '–' : fmt.format(x));
  const hasHolo = cm && ['trend-holo', 'avg-holo', 'low-holo'].some((k) => cm[k] != null);
  const hasNormal = cm && ['trend', 'avg', 'low'].some((k) => cm[k] != null);
  const headline = cm ? (cm.trend ?? cm['trend-holo'] ?? cm.avg ?? cm['avg-holo']) : null;
  const rows = [
    ['Trend', 'trend'], ['Average sale', 'avg'], ['Lowest offer', 'low'],
    ['Avg. last day', 'avg1'], ['Avg. 7 days', 'avg7'], ['Avg. 30 days', 'avg30'],
  ];
  const updated = cm?.updated ? new Date(cm.updated).toLocaleDateString(state.lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  const cmSearch = `https://www.cardmarket.com/${state.lang}/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name)}`;
  const src = imgFor(card, 'high');

  els.result.replaceChildren(
    el('div', { class: 'result' },
      src ? el('img', { src, alt: card.name }) : el('div', { class: 'noimg' }),
      el('div', { class: 'meta' },
        el('div', { class: 'label' }, state.lang === 'fr' ? 'French card' : 'English card'),
        el('h2', {}, card.name),
        el('div', {}, card.set?.name || ''),
        el('div', { class: 'num' }, `${card.localId}${card.set?.cardCount?.official ? '/' + card.set.cardCount.official : ''}`),
        card.rarity ? el('div', {}, card.rarity) : null)),
    cm
      ? el('div', {},
        el('div', { class: 'label' }, 'Cardmarket trend'),
        el('div', { class: 'price-main' }, el('strong', {}, v(headline)), updated ? el('span', { class: 'note' }, `updated ${updated}`) : null))
      : el('p', { class: 'empty' }, 'No Cardmarket price is listed for this card in the database.'),
    cm ? el('div', { style: 'overflow-x:auto' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, ''), hasNormal ? el('th', {}, 'Normal') : null, hasHolo ? el('th', {}, 'Holo / reverse') : null)),
      el('tbody', {}, rows.map(([label, k]) => el('tr', {},
        el('td', {}, label),
        hasNormal ? el('td', {}, v(cm[k])) : null,
        hasHolo ? el('td', {}, v(cm[k + '-holo'])) : null))))) : null,
    el('p', { class: 'note warn' }, 'Cardmarket gives one price for this card across all languages. French and English copies can sell for different amounts, so check the listings before you buy or sell.'),
    el('a', { class: 'btn', href: cmSearch, target: '_blank', rel: 'noopener' }, 'Search on Cardmarket'),
  );
  els.result.hidden = false;
  setStatus(`Found ${card.name}.`);
  els.result.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ---------- Events ----------
els.scan.addEventListener('click', () => {
  if (!state.stream) return startCamera();
  if (els.video.hidden) { showLive(); return; }
  runScan(grabFrame());
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
  // An uploaded photo may not be cropped to the card, so use wider bands.
  const ratio = c.width / c.height;
  const cropped = Math.abs(ratio - 63 / 88) < 0.08;
  await runScan(c, cropped ? REGIONS : { name: { x: 0, y: 0, w: 1, h: 0.2 }, number: { x: 0, y: 0.78, w: 1, h: 0.22 } });
  if (state.stream && !els.video.hidden) els.scan.textContent = 'Scan card';
});

els.form.addEventListener('submit', (e) => { e.preventDefault(); search(); });

for (const b of document.querySelectorAll('.lang button')) {
  b.addEventListener('click', async () => {
    if (state.lang === b.dataset.lang) return;
    state.lang = b.dataset.lang;
    saveLang(state.lang);
    renderLang();
    // Same card, other language: TCGdex uses the same card ids in both.
    if (state.cardId && !els.result.hidden) await showCard(state.cardId);
    else setStatus(`Switched to ${state.lang === 'fr' ? 'French' : 'English'} cards.`);
  });
}

renderLang();
