// Builds data/names-<lang>.json: every unique card name in TCGdex.
// Run with: node scripts/build-names.mjs
import { writeFile } from 'node:fs/promises';

for (const lang of ['fr', 'en']) {
  const res = await fetch(`https://api.tcgdex.net/v2/${lang}/cards`);
  if (!res.ok) throw new Error(`${lang}: HTTP ${res.status}`);
  const cards = await res.json();
  const names = [...new Set(cards.map((c) => c.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, lang));
  await writeFile(new URL(`../data/names-${lang}.json`, import.meta.url), JSON.stringify(names));
  console.log(`${lang}: ${names.length} names from ${cards.length} cards`);
}
