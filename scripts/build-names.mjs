// Builds data/names-<lang>.json: every unique card name in TCGdex,
// leaving out the digital game Pokémon TCG Pocket (series "tcgp").
// Run with: node scripts/build-names.mjs
import { writeFile } from 'node:fs/promises';

const series = await (await fetch('https://api.tcgdex.net/v2/en/series/tcgp')).json();
const pocket = new Set(series.sets.map((s) => s.id));

for (const lang of ['fr', 'en']) {
  const res = await fetch(`https://api.tcgdex.net/v2/${lang}/cards`);
  if (!res.ok) throw new Error(`${lang}: HTTP ${res.status}`);
  const cards = await res.json();
  const physical = cards.filter((c) => !pocket.has(c.id.slice(0, c.id.lastIndexOf('-'))));
  const names = [...new Set(physical.map((c) => c.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, lang));
  await writeFile(new URL(`../data/names-${lang}.json`, import.meta.url), JSON.stringify(names));
  console.log(`${lang}: ${names.length} names from ${cards.length} cards`);
}
