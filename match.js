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

// Finds a collector number like "136/189", "TG05/TG30" or "SV045/SV094".
// OCR often reads "/" as "l", "I" or "|", and "O" for "0".
export function parseNumber(text) {
  if (!text) return null;
  const cleaned = text
    .toUpperCase()
    .replace(/(\d)\s*[|\\IL!]\s*(\d)/g, '$1/$2');
  const re = /([A-Z]{0,3}?)\s?([0-9O]{1,3})\s*\/\s*([A-Z]{0,3}?)\s?([0-9O]{2,3})(?![0-9])/g;
  let best = null;
  let m;
  while ((m = re.exec(cleaned))) {
    const num = m[2].replace(/O/g, '0');
    const total = m[4].replace(/O/g, '0');
    const prefix = m[1] && m[1] === m[3] ? m[1] : '';
    const cand = { number: prefix + num, numeric: parseInt(num, 10), total: parseInt(total, 10), prefix };
    if (cand.total > 0 && (!best || cand.numeric <= cand.total)) best = cand;
  }
  return best;
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
