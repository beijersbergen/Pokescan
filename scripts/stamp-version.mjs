// Gives every publish a new version label, so phones never mix old and new files.
// Run before each commit: node scripts/stamp-version.mjs
import { readFile, writeFile } from 'node:fs/promises';

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const version = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const root = new URL('../', import.meta.url);

async function edit(file, fn) {
  const path = new URL(file, root);
  const before = await readFile(path, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`${file}: nothing to stamp`);
  await writeFile(path, after);
}

// Local files that are loaded with a ?v= label.
const files = /((?:app|match|vision)\.js|names-\$\{lang\}\.json)(\?v=[\w-]*)?(['"`])/g;
await edit('index.html', (s) => s
  .replace(/<meta name="app-version" content="[^"]*">/, `<meta name="app-version" content="${version}">`)
  .replace(files, `$1?v=${version}$3`));
await edit('app.js', (s) => s.replace(files, `$1?v=${version}$3`));
await writeFile(new URL('version.json', root), JSON.stringify({ version }) + '\n');
console.log('version', version);
