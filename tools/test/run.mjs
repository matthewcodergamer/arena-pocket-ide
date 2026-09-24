// Runs every tools/test/*.test.mjs file (or the ones named on the command line) sequentially.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('.', import.meta.url));
const only = process.argv.slice(2);
const files = (await readdir(dir)).filter(f => f.endsWith('.test.mjs') && (!only.length || only.some(o => f.includes(o)))).sort();
let failed = 0;
for (const f of files) {
  const started = Date.now();
  const code = await new Promise(resolve => {
    const p = spawn(process.execPath, [join(dir, f)], { stdio: 'inherit' });
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve(124); }, 240000);
    p.on('exit', c => { clearTimeout(timer); resolve(c ?? 1); });
  });
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${f} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (code !== 0) failed++;
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
