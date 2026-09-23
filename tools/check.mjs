// Fast static checks: every JS module parses, both worker copies are identical, and every
// relative import in src/ points to an existing file with the named exports it expects.
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
async function walk(dir) {
  const out = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...await walk(rel)); else if (/\.m?js$/.test(e.name)) out.push(rel);
  }
  return out;
}
const files = [...await walk('src'), ...await walk('tools'), ...await walk('worker/src'), ...await walk('worker/test'), 'sw.js', 'index.js'];
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.error(`✗ syntax: ${f}\n${r.stderr}`); }
}
const a = await readFile(join(root, 'index.js'), 'utf8').catch(() => null);
const b = await readFile(join(root, 'worker/src/index.js'), 'utf8').catch(() => null);
if (a !== b) { failed++; console.error('✗ index.js and worker/src/index.js differ (they must be identical copies)'); }

// Import graph check for browser modules.
const exportCache = new Map();
async function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const src = await readFile(file, 'utf8').catch(() => null);
  let names = null;
  if (src != null) {
    names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
    if (/export\s+default\b/.test(src)) names.add('default');
    if (/export\s*\*\s*from/.test(src)) names.add('*');
  }
  exportCache.set(file, names);
  return names;
}
for (const f of files.filter(f => f.startsWith('src/'))) {
  const src = await readFile(join(root, f), 'utf8');
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+[\w$]+\s*)?from\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(join(root, f)), m[3]);
    const names = await exportsOf(target);
    if (!names) { failed++; console.error(`✗ ${f}: import target missing ${relative(root, target)}`); continue; }
    if (names.has('*')) continue;
    const wanted = (m[2] || '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    if (m[1]) wanted.push('default');
    for (const w of wanted) if (!names.has(w)) { failed++; console.error(`✗ ${f}: "${w}" is not exported by ${relative(root, target)}`); }
  }
}
console.log(`${files.length} files checked, ${failed} problem(s)`);
process.exit(failed ? 1 : 0);
