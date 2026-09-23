// Builds the third-party browser bundles that X Coder serves from vendor/.
// The site itself has no build step: run `npm install && npm run build:vendor`
// only when upgrading a dependency, then commit the vendor/ output.
import { build } from 'esbuild';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor');
const src = join(root, 'tools', 'vendor-src');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: ['codemirror', 'cm-emmet', 'cm-minimap', 'jszip', 'acorn', 'markdown', 'seti']
    .map(name => ({ in: join(src, `${name}.js`), out: name })),
  outdir: out,
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  target: ['safari15', 'chrome100', 'firefox100'],
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
  loader: { '.json': 'json' },
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  logLevel: 'warning'
});

// VS Code's own icon font (codicons).
await mkdir(join(out, 'codicons'), { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  await cp(join(root, 'node_modules/@vscode/codicons/dist', file), join(out, 'codicons', file));
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}
const files = (await walk(out)).map(f => relative(root, f).split('\\').join('/')).sort();
let total = 0;
for (const f of files) total += (await stat(join(root, f))).size;
await writeFile(join(out, 'manifest.json'), JSON.stringify({ generated: 'tools/build-vendor.mjs', files }, null, 1) + '\n');
console.log(`vendor/: ${files.length} files, ${(total / 1024).toFixed(0)} KB`);
