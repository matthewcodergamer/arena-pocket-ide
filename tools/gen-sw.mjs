// Regenerates the VERSION + PRECACHE lists in sw.js from the files that make up the app.
// Run after changing any app file: `node tools/gen-sw.mjs` (the GitHub Pages workflow runs it on deploy).
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await walk(rel));
    else out.push(rel);
  }
  return out;
}

const files = [
  'index.html', 'manifest.webmanifest',
  ...(await walk('css')), ...(await walk('src')), ...(await walk('vendor')), ...(await walk('icons')),
  'docs/RELEASE_NOTES.md'
].filter(f => !/(^|\/)\.|\.map$|README|manifest\.json$/.test(f) || f === 'manifest.webmanifest');

const existing = [];
const hash = createHash('sha256');
for (const f of [...new Set(files)].sort()) {
  const s = await stat(join(root, f)).catch(() => null);
  if (!s?.isFile()) continue;
  existing.push(f);
  hash.update(f);
  hash.update(await readFile(join(root, f)));
}
const version = `xcoder-${pkg.version}-${hash.digest('hex').slice(0, 12)}`;
const swPath = join(root, 'sw.js');
let sw = await readFile(swPath, 'utf8');
sw = sw.replace(/const VERSION = .*?; \/\/ @generated/, `const VERSION = '${version}'; // @generated`);
sw = sw.replace(/const PRECACHE = [\s\S]*?; \/\/ @generated/, `const PRECACHE = ${JSON.stringify(existing.map(f => `./${f}`), null, 0).replace(/","/g, '",\n  "')}; // @generated`);
await writeFile(swPath, sw);
console.log(`sw.js → ${version} (${existing.length} files precached)`);
