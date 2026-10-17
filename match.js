// Pure helpers: parse OCR text and rank card candidates. No DOM, no network.

const NAME_STOPWORDS = new Set([
  'base', 'basic', 'de', 'niveau', 'stage', 'pv', 'hp', 'pokemon', 'evolue',
  'evolves', 'from', 'trainer', 'dresseur', 'supporter', 'objet', 'item',
  'stade', 'outil', 'tool', 'energie', 'energy', 'ex', 'gx', 'v', 'vmax',
  'vstar', 'tera', 'niv', 'lv', 'du', 'of', 'the',
]);

export function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Finds collector numbers like "136/189", "TG05/TG30" or "SV045/SV094".
// OCR often reads "/" as "l", "I" or "|", and "O" for "0".
export function parseNumbers(text) {
  if (!text) return [];
  const cleaned = text
    .toUpperCase()
    .replace(/(\d)\s*[|\\IL!]\s*(\d)/g, '$1/$2');
  const re = /([A-Z]{0,3}?)\s?([0-9O]{1,3})\s*\/\s*([A-Z]{0,3}?)\s?([0-9O]{2,3})(?![0-9])/g;
  const out = [];
  let m;
  while ((m = re.exec(cleaned))) {
    const num = m[2].replace(/O/g, '0');
    const total = m[4].replace(/O/g, '0');
    const prefix = m[1] && m[1] === m[3] ? m[1] : '';
    const cand = { number: prefix + num, numeric: parseInt(num, 10), total: parseInt(total, 10), prefix };
    if (cand.total > 0) out.push(cand);
  }
  return out;
}

export function parseNumber(text) {
  const all = parseNumbers(text);
  return all.find((c) => c.numeric <= c.total) || all[0] || null;
}

// Keeps only numbers whose total matches a real set, best guess first.
export function pickNumber(cands, sets) {
  const totals = new Set();
  for (const s of sets || []) {
    if (s.cardCount?.official) totals.add(s.cardCount.official);
    if (s.cardCount?.total) totals.add(s.cardCount.total);
  }
  const known = cands.filter((c) => totals.has(c.total));
  const pool = known.length ? known : sets && sets.length ? [] : cands;
  return pool.find((c) => c.numeric <= c.total) || pool[0] || null;
}

export function formatNumber(p) {
  if (!p) return '';
  return p.promo ? p.label : `${p.number}/${p.prefix}${p.total}`;
}

// Black Star Promo numbers have no "/total": SM57, SWSH123, XY45, BW12, DP03,
// HGSS10. Scarlet & Violet and Mega Evolution promos print "SVP 045" / "MEP 012".
const PROMO_SETS = [
  ['SWSH', 'swshp', true], ['HGSS', 'hgssp', true], ['SVP', 'svp', false], ['MEP', 'mep', false],
  ['SM', 'smp', true], ['XY', 'xyp', true], ['BW', 'bwp', true], ['DP', 'dpp', true],
];

export function parsePromo(text) {
  if (!text) return null;
  const t = text.toUpperCase().replace(/[O](?=\d)/g, '0');
  for (const [prefix, setId, keepPrefix] of PROMO_SETS) {
    const m = t.match(new RegExp(`(?:^|[^A-Z])${prefix}\\s?(?:(?:EN|FR|DE|IT|ES|PT|NL)\\s)?([0-9O]{1,3})(?![0-9/])`));
    if (m) {
      const digits = m[1].replace(/O/g, '0');
      const numeric = parseInt(digits, 10);
      return {
        promo: true, setId, numeric, prefix: keepPrefix ? prefix : '', total: null,
        number: (keepPrefix ? prefix : '') + digits, label: `${prefix}${keepPrefix ? '' : ' '}${digits}`,
      };
    }
  }
  return null;
}

// Picks the most likely card name from the text at the top of the card.
// `input` is plain text, or OCR lines as [{text, height}] so the biggest
// printed text (the name) wins over small labels.
export function parseName(input) {
  if (!input) return '';
  const lines = (typeof input === 'string'
    ? input.split(/\n+/).map((t) => ({ text: t, height: 1 }))
    : input
  ).filter((l) => l.text && l.text.trim() && !/evolu|evolves|[ée]volue/i.test(normalize(l.text) + l.text));
  const maxH = Math.max(1, ...lines.map((l) => l.height || 1));
  let best = '';
  let bestScore = 0;
  for (const { text: line, height } of lines) {
    const words = line
      .replace(/[^A-Za-zÀ-ÿ'’\- ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !NAME_STOPWORDS.has(normalize(w)));
    const cand = words.join(' ').trim();
    const letters = cand.replace(/\s/g, '').length;
    if (letters < 3) continue;
    const score = (letters + (/^[A-ZÀ-Ý]/.test(cand) ? 2 : 0)) * ((height || 1) / maxH);
    if (score > bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  return best;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 0..1, where 1 is identical. Also rewards the OCR text containing the name.
export function similarity(a, b) {
  const x = normalize(a).replace(/\s/g, '');
  const y = normalize(b).replace(/\s/g, '');
  if (!x || !y) return 0;
  if (x.includes(y) || y.includes(x)) return 0.9 + 0.1 * (Math.min(x.length, y.length) / Math.max(x.length, y.length));
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// Sets whose printed total matches the number after the slash.
export function setsForTotal(sets, total) {
  return sets.filter((s) => s.cardCount && (s.cardCount.official === total || s.cardCount.total === total));
}

export function sameLocalId(localId, parsed) {
  const a = String(localId).toUpperCase();
  const b = parsed.number.toUpperCase();
  if (a === b) return true;
  const am = a.match(/^([A-Z]*)0*(\d+)$/);
  const bm = b.match(/^([A-Z]*)0*(\d+)$/);
  return !!(am && bm && am[1] === bm[1] && am[2] === bm[2]);
}

// Sorts candidates by how well their name matches the OCR name.
export function rankCandidates(cards, ocrName) {
  return cards
    .map((c) => ({ ...c, score: ocrName ? similarity(c.name, ocrName) : 0 }))
    .sort((a, b) => b.score - a.score);
}

// Turns a list of known names into a lookup that tolerates OCR noise.
export function buildNameIndex(names) {
  return names
    .map((name) => ({ name, key: normalize(name).replace(/\s/g, '') }))
    .filter((n) => n.key.length >= 3);
}

// Finds the known name closest to noisy OCR text such as "F o Fouinor x PV 110".
// Tries every run of 1 to 4 words, so stray letters and labels are ignored.
export function bestNameMatch(text, index) {
  if (!text || !index || !index.length) return null;
  const words = normalize(text)
    .split(' ')
    .filter((w) => w.length >= 2 && !/\d/.test(w) && !NAME_STOPWORDS.has(w));
  const phrases = new Set();
  for (let i = 0; i < words.length; i++) {
    let p = '';
    for (let j = i; j < Math.min(words.length, i + 4); j++) {
      p += words[j];
      if (p.length >= 3) phrases.add(p);
    }
  }
  let best = null;
  for (const phrase of phrases) {
    for (const n of index) {
      if (Math.abs(n.key.length - phrase.length) > Math.max(2, n.key.length * 0.3)) continue;
      const score = 1 - levenshtein(phrase, n.key) / Math.max(phrase.length, n.key.length);
      if (!best || score > best.score || (score === best.score && n.key.length > best.key.length)) {
        best = { name: n.name, key: n.key, score };
      }
    }
  }
  return best && best.score >= 0.6 ? { name: best.name, score: best.score } : null;
}

// Collection price: 30-day average of the normal version. A 0 in the data
// means "no sales", so it counts as no price. Cards that only
// exist as holo (variants.normal === false) use the holo price instead.
export function collectionPrice(cm, variants) {
  if (!cm) return null;
  const holoOnly = variants && variants.normal === false && (variants.holo || variants.reverse);
  const normal = [['avg30', false], ['trend', false], ['avg', false]];
  const holo = [['avg30-holo', true], ['trend-holo', true], ['avg-holo', true]];
  const order = holoOnly ? [...holo, ...normal] : [normal[0], holo[0], normal[1], holo[1], normal[2]];
  for (const [k, isHolo] of order) if (typeof cm[k] === 'number' && cm[k] > 0) return { value: cm[k], source: k, holo: isHolo };
  return null;
}

export function collectionTotal(items) {
  let total = 0, priced = 0, unpriced = 0, count = 0;
  for (const it of items) {
    count += it.qty;
    if (it.price && it.price.value > 0) { total += it.price.value * it.qty; priced += it.qty; }
    else unpriced += it.qty;
  }
  return { total: Math.round(total * 100) / 100, priced, unpriced, count };
}
