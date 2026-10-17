// Finds the card in a photo, so the name and number can be read at fixed
// spots on the card. Pure function: takes RGBA pixels, returns a box.

const CARD_RATIO = 63 / 88; // width / height of a Pokémon card

// rgba: Uint8ClampedArray, w/h: size (use a small image, ~400px wide).
// Returns {x, y, w, h} in pixels, or null when no card-shaped area is found.
export function detectCard(input, w, h, threshold = 90) {
  const rgba = blur(input, w, h);
  // Background per row: median colour at the left and right ends of the row.
  // This copes with light that changes across the photo.
  const k = Math.max(2, Math.round(w * 0.04));
  const median = (vals) => vals.sort((a, b) => a - b)[vals.length >> 1];
  const L = new Int32Array(h).fill(-1);
  const R = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    const ends = [[], [], [], [], [], []];
    for (let x = 0; x < k; x++) {
      const i = (y * w + x) * 4, j = (y * w + (w - 1 - x)) * 4;
      for (let c = 0; c < 3; c++) { ends[c].push(rgba[i + c]); ends[3 + c].push(rgba[j + c]); }
    }
    const lb = ends.slice(0, 3).map(median), rb = ends.slice(3).map(median);
    // First and last spot with 3 "card" pixels in a row.
    let streak = 0;
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1), i = (y * w + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(rgba[i + c] - (lb[c] * (1 - t) + rb[c] * t));
      streak = d > threshold ? streak + 1 : 0;
      if (streak === 3) { if (L[y] < 0) L[y] = x - 2; R[y] = x + 1; }
      else if (streak > 3) R[y] = x + 1;
    }
  }
  // Longest block of rows where the card spans at least a quarter of the photo.
  let best = null, start = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && L[y] >= 0 && R[y] - L[y] > 0.25 * w;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (!best || y - start > best[1] - best[0]) best = [start, y];
      start = -1;
    }
  }
  if (!best) return null;
  const ls = [], rs = [];
  for (let y = best[0]; y < best[1]; y++) { ls.push(L[y]); rs.push(R[y]); }
  const box = { x: median(ls), y: best[0], w: median(rs) - median(ls), h: best[1] - best[0] };
  // Every card has the same shape. When the box is too tall (shadow, floor or
  // another card below it), trust the width and the top edge.
  if (box.w / box.h < CARD_RATIO - 0.03) box.h = Math.min(h - box.y, Math.round(box.w / CARD_RATIO));
  const ratio = box.w / box.h;
  const area = (box.w * box.h) / (w * h);
  if (area < 0.08 || Math.abs(ratio - CARD_RATIO) > 0.12) return null;
  return box;
}

// 5x5 box blur, so textured backgrounds (wood, fabric) do not look like edges.
function blur(src, w, h) {
  const tmp = new Float32Array(w * h * 3);
  const out = new Uint8ClampedArray(w * h * 4);
  const r = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0, n = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx)), i = (y * w + xx) * 4;
        a += src[i]; b += src[i + 1]; c += src[i + 2]; n++;
      }
      const o = (y * w + x) * 3;
      tmp[o] = a / n; tmp[o + 1] = b / n; tmp[o + 2] = c / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)), o = (yy * w + x) * 3;
        a += tmp[o]; b += tmp[o + 1]; c += tmp[o + 2]; n++;
      }
      const i = (y * w + x) * 4;
      out[i] = a / n; out[i + 1] = b / n; out[i + 2] = c / n; out[i + 3] = 255;
    }
  }
  return out;
}
