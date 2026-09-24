// xsh project and developer tools: open/code, run/preview, node, python, npm/npx/yarn/pnpm,
// curl/wget, ai/xcoder, zip/unzip and the git fallback. These talk to other features through
// their cross-feature APIs (preview, ai, editors) and degrade with honest messages when a feature
// is unavailable.

import { posix } from '../core/path.js';
import { settings } from '../core/settings.js';
import { commands } from '../core/commands.js';
import { editors } from '../workbench/editors.js';
import { sgr } from './ansi.js';
import { UsageError, getopts, humanSize } from './builtins.js';
import { projectSlug } from './shell.js';

export const DEVTOOLS = new Map();
function def(name, usage, summary, run, extra = {}) {
  const cmd = { name, category: 'Project and tools', usage, summary, run, ...extra };
  DEVTOOLS.set(name, cmd);
  for (const a of extra.aliases || []) DEVTOOLS.set(a, { ...cmd, name: a, hidden: true });
}

const previewApi = () => import('../preview/api.js').then(m => m.preview);
const aiApi = () => import('../ai/api.js').then(m => m.ai);
const withNewline = t => (String(t).endsWith('\n') ? String(t) : `${t}\n`);

// ---------------------------------------------------------------- editor + preview

def('code', 'code [-r] <file|folder>…', 'Open files in the editor (creates missing files)', async ctx => {
  const targets = ctx.args.filter(a => !a.startsWith('-'));
  if (!targets.length) throw new UsageError('usage: code <file>… (code . reveals the project in the Explorer)');
  for (const t of targets) {
    const p = ctx.resolve(t);
    if (ctx.shell.isDir(p)) {
      try {
        const { files } = await import('../views/files-api.js');
        if (p) files.reveal(p); else await commands.execute('workbench.view.explorer');
      } catch { await commands.execute('workbench.view.explorer').catch(() => {}); }
      continue;
    }
    if (!ctx.fs.exists(p)) {
      if (!ctx.shell.isDir(posix.dirname(p))) throw new UsageError(`${t}: No such file or directory`);
      await ctx.fs.writeText(p, '', { source: 'terminal' });
    }
    await editors.open({ type: 'file', path: p }, { pinned: true });
  }
}, { aliases: ['open', 'edit', 'nano', 'vim', 'vi'] });

def('run', 'run [file]', 'Run the project (or a file) in the Live Preview', async ctx => {
  const preview = await previewApi();
  let entry;
  if (ctx.args[0]) {
    entry = ctx.resolve(ctx.args[0]);
    if (!ctx.fs.isFile(entry)) throw new UsageError(`${ctx.args[0]}: No such file or directory`);
  } else entry = preview.resolveEntry?.(editors.activePath || undefined);
  await preview.run(entry);
  ctx.println(`${sgr.green('✓')} Opened ${entry || 'the project'} in the Live Preview`);
}, { aliases: ['preview', 'serve'] });

async function runScript(ctx, runtime, file, args) {
  const p = ctx.resolve(file);
  if (!ctx.fs.isFile(p)) {
    if (runtime === 'node') { ctx.err(`Error: Cannot find module '/${p}'\n`); return 1; }
    ctx.err(`${ctx.name}: can't open file '/${p}': [Errno 2] No such file or directory\n`);
    return 2;
  }
  const preview = await previewApi();
  let result;
  try {
    result = await preview.runScript(p, {
      args, signal: ctx.signal,
      onOutput: (stream, text) => (stream === 'stderr' ? ctx.err : ctx.out)(withNewline(text))
    });
  } catch (err) {
    if (ctx.signal?.aborted || err?.name === 'AbortError') return 130;
    ctx.err(`${ctx.name}: ${err.message || err}\n`);
    return 1;
  }
  return Number.isInteger(result?.exitCode) ? result.exitCode : 0;
}

def('node', 'node <file.js> [args…]', 'Run a JavaScript file with the browser script runner', async ctx => {
  const a = ctx.args;
  if (a[0] === '-v' || a[0] === '--version') {
    ctx.println('X Coder script runner (browser JavaScript, not Node.js — Node built-ins like fs and http are unavailable)');
    return 0;
  }
  if (a[0] === '-e' || a[0] === '-p' || a[0] === '--eval') throw new UsageError(`${a[0]} is not supported; save the code to a file and run node <file>, or evaluate it in the Debug Console (⇧⌘Y)`);
  if (!a.length) throw new UsageError('the interactive REPL is not available in xsh; run a file (node app.js) or use the Debug Console (⇧⌘Y) to evaluate expressions in the running preview');
  return runScript(ctx, 'node', a[0], a.slice(1));
}, { aliases: ['deno', 'bun'] });

def('python', 'python <file.py> [args…]', 'Run a Python file with the browser script runner', async ctx => {
  const a = ctx.args;
  if (a[0] === '-V' || a[0] === '--version') { ctx.println('X Coder script runner (Python in the browser via Pyodide — needs a network connection the first time)'); return 0; }
  if (a[0] === '-c' || a[0] === '-m') throw new UsageError(`${a[0]} is not supported; save the code to a file and run python <file>`);
  if (!a.length) throw new UsageError('the interactive Python REPL is not available in xsh; run a file: python main.py');
  return runScript(ctx, 'python', a[0], a.slice(1));
}, { aliases: ['python3', 'py'] });

// ---------------------------------------------------------------- npm / yarn / pnpm / npx

const DEV_SERVERS = /^(vite|serve|http-server|live-server|next|react-scripts|parcel|webpack(-dev-server)?|astro|nuxt|svelte-kit|ng|vue-cli-service|browser-sync|lite-server|snowpack|wmr|es-dev-server|web-dev-server)$/;
const NO_INSTALL_NOTE = 'Packages are not installed in the browser (there is no node_modules). Bare imports such as `import confetti from "canvas-confetti"` load automatically from esm.sh when the preview runs.';

async function readPkg(ctx) {
  if (!ctx.fs.isFile('package.json')) return null;
  try { return JSON.parse(await ctx.fs.readText('package.json')); }
  catch (err) { throw new UsageError(`package.json: ${err.message}`); }
}
async function writePkg(ctx, pkg) { await ctx.fs.writeText('package.json', JSON.stringify(pkg, null, 2) + '\n', { source: 'terminal' }); }

async function npmRunScript(ctx, tool, name, extraArgs) {
  const pkg = await readPkg(ctx);
  if (!pkg) { ctx.err(`${tool === 'npm' ? 'npm ERR!' : 'error'} Could not read package.json (run '${tool} init -y' first)\n`); return 1; }
  const script = pkg.scripts?.[name];
  if (script == null) {
    if (tool === 'npm') ctx.err(`npm ERR! Missing script: "${name}"\nnpm ERR!\nnpm ERR! To see a list of scripts, run:\nnpm ERR!   npm run\n`);
    else ctx.err(`error Command "${name}" not found.\n`);
    return 1;
  }
  const line = [script, ...extraArgs].join(' ');
  ctx.println(`\n> ${pkg.name || 'project'}@${pkg.version || '0.0.0'} ${name}\n> ${line}\n`);
  const first = script.trim().split(/\s+/)[0];
  if (DEV_SERVERS.test(first)) {
    const preview = await previewApi();
    await preview.run(preview.resolveEntry?.());
    ctx.println(`${sgr.green('✓')} '${first}' is served by the X Coder Live Preview (dev servers can't run in the browser) — opened the preview.`);
    return 0;
  }
  return ctx.run(line, { stdin: '' });
}

async function packageManager(ctx, tool) {
  const [verb = '', ...rest] = ctx.args;
  const { o, rest: names } = getopts(rest, { flags: 'DSgEyfO', long: { '--save-dev': 'D', '--save': 'S', '--global': 'g', '--yes': 'y', '--dev': 'D', '--save-exact': 'E', '--force': 'f', '--legacy-peer-deps': 'f' } });
  const slug = projectSlug(ctx.shell.host.projectName?.());
  switch (verb) {
    case '':
    case 'help':
    case '-h':
    case '--help':
      ctx.println(`${tool} (xsh emulation) — supported: ${tool} init [-y], ${tool} ${tool === 'npm' ? 'install' : 'add'} <pkg>, ${tool} run <script>, ${tool} start, ${tool} test, ${tool} ls`);
      ctx.println(NO_INSTALL_NOTE);
      return 0;
    case '-v':
    case '--version':
    case 'version':
      ctx.println(`${tool} is emulated by xsh in X Coder (no Node.js runtime in the browser).`);
      return 0;
    case 'init':
    case 'create': {
      if (verb === 'create') throw new UsageError(`'${tool} create' downloads project generators, which can't run in the browser. Use File > New Project… (xcoder.project.new) for a template instead.`);
      if (ctx.fs.exists('package.json') && !o.y && !o.f) { ctx.println('package.json already exists.'); return 0; }
      const pkg = { name: slug, version: '1.0.0', description: '', main: ctx.fs.isFile('index.js') ? 'index.js' : ctx.fs.isFile('main.js') ? 'main.js' : 'index.js', type: 'module', scripts: { start: 'serve', test: 'echo "Error: no test specified" && exit 1' }, keywords: [], author: '', license: 'ISC' };
      await writePkg(ctx, pkg);
      ctx.println(`Wrote to /package.json:\n\n${JSON.stringify(pkg, null, 2)}\n`);
      return 0;
    }
    case 'i':
    case 'install':
    case 'add':
    case 'ci': {
      const pkgs = names.filter(n => !n.startsWith('-'));
      if (!pkgs.length) {
        const pkg = await readPkg(ctx);
        const deps = Object.keys({ ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) });
        ctx.println(`${deps.length ? `up to date, ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'} declared in package.json` : 'up to date'}`);
        ctx.println(sgr.gray(NO_INSTALL_NOTE));
        return 0;
      }
      if (o.g) throw new UsageError('global installs are not possible in the browser');
      const pkg = (await readPkg(ctx)) || { name: slug, version: '1.0.0', private: true };
      const key = o.D ? 'devDependencies' : 'dependencies';
      pkg[key] = pkg[key] || {};
      for (const spec of pkgs) {
        const at = spec.lastIndexOf('@');
        const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, 'latest'];
        pkg[key][name] = version;
      }
      pkg[key] = Object.fromEntries(Object.entries(pkg[key]).sort(([a], [b]) => a.localeCompare(b)));
      await writePkg(ctx, pkg);
      ctx.println(`added ${pkgs.length} package${pkgs.length === 1 ? '' : 's'} to ${key} in package.json: ${pkgs.join(', ')}`);
      ctx.println(sgr.gray(NO_INSTALL_NOTE));
      return 0;
    }
    case 'uninstall':
    case 'remove':
    case 'rm':
    case 'un': {
      const pkg = await readPkg(ctx);
      if (!pkg) throw new UsageError('no package.json');
      let removed = 0;
      for (const n of names) for (const k of ['dependencies', 'devDependencies']) if (pkg[k]?.[n] != null) { delete pkg[k][n]; removed++; }
      await writePkg(ctx, pkg);
      ctx.println(`removed ${removed} package${removed === 1 ? '' : 's'}`);
      return 0;
    }
    case 'ls':
    case 'list': {
      const pkg = await readPkg(ctx);
      ctx.println(`${pkg?.name || slug}@${pkg?.version || '0.0.0'} /`);
      const deps = Object.entries({ ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) });
      if (!deps.length) ctx.println('└── (empty)');
      deps.forEach(([n, v], i) => ctx.println(`${i === deps.length - 1 ? '└──' : '├──'} ${n}@${v} ${sgr.gray('(loaded from esm.sh at run time)')}`));
      return 0;
    }
    case 'run':
    case 'run-script': {
      if (!names.length) {
        const pkg = await readPkg(ctx);
        const scripts = Object.entries(pkg?.scripts || {});
        if (!scripts.length) { ctx.println('No scripts in package.json'); return 0; }
        ctx.println(`Scripts available in ${pkg.name || slug} via \`${tool} run\`:`);
        for (const [k, v] of scripts) ctx.println(`  ${k}\n    ${v}`);
        return 0;
      }
      return npmRunScript(ctx, tool, names[0], names.slice(1));
    }
    case 'start':
    case 'test':
    case 't':
    case 'dev':
    case 'build':
      if ((verb === 'dev' || verb === 'build') && tool === 'npm') break;
      return npmRunScript(ctx, tool, verb === 't' ? 'test' : verb, names);
    case 'exec':
    case 'x':
    case 'dlx':
      return npx(ctx, names);
  }
  if (tool !== 'npm') {
    const pkg = await readPkg(ctx);
    if (pkg?.scripts?.[verb] != null) return npmRunScript(ctx, tool, verb, names);
  }
  ctx.err(tool === 'npm' ? `Unknown command: "${verb}"\n\nTo see a list of supported npm commands, run:\n  npm help\n` : `error Command "${verb}" not found.\n`);
  return 1;
}

async function npx(ctx, args) {
  const cmd = args.find(a => !a.startsWith('-'));
  if (!cmd) throw new UsageError('usage: npx <command>');
  const bare = cmd.replace(/@[^/]*$/, '');
  if (DEV_SERVERS.test(bare)) {
    const preview = await previewApi();
    await preview.run(preview.resolveEntry?.());
    ctx.println(`${sgr.green('✓')} '${bare}' is served by the X Coder Live Preview — opened the preview.`);
    return 0;
  }
  ctx.err(`npx: can't download and run '${cmd}' — packages can't be installed or executed as programs in the browser.\n`);
  return 1;
}

for (const tool of ['npm', 'yarn', 'pnpm']) {
  def(tool, `${tool} <init|${tool === 'npm' ? 'install' : 'add'}|run|start|test|ls> [args…]`, tool === 'npm' ? 'Manage package.json (emulated: dependencies load from esm.sh)' : `${tool} (emulated like npm)`, ctx => packageManager(ctx, tool), tool === 'npm' ? {} : { hidden: false });
}
def('npx', 'npx <command>', 'Run a package binary (dev servers open the Live Preview)', ctx => npx(ctx, ctx.args), { aliases: ['pnpx'] });

// ---------------------------------------------------------------- curl / wget

async function fetchUrl(url, signal) {
  const router = String(settings.get('xcoder.ai.routerUrl', '') || '').trim().replace(/\/+$/, '');
  const errors = [];
  if (router) {
    try {
      const res = await fetch(`${router}/fetch?url=${encodeURIComponent(url)}`, { signal });
      if (!res.ok) throw new Error(`X Coder Worker returned HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return { status: data.status ?? 200, contentType: data.contentType || '', text: String(data.text ?? ''), via: 'worker' };
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(err.message);
    }
  }
  try {
    const res = await fetch(url, { signal });
    return { status: res.status, contentType: res.headers.get('content-type') || '', text: await res.text(), via: 'direct' };
  } catch (err) {
    if (signal?.aborted) throw err;
    errors.push(router ? `direct request blocked (${err.message})` : `the browser blocked the request (${err.message}); set xcoder.ai.routerUrl to an X Coder Worker to fetch any URL`);
  }
  throw new UsageError(`(6) Could not fetch ${url}: ${errors.join('; ')}`, 6);
}

def('curl', 'curl [-sSLio] [-o file] <url>', 'Fetch a URL (through the X Coder Worker)', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'sSLiIkfvO', values: 'oXHdAe', long: { '--silent': 's', '--location': 'L', '--include': 'i', '--output': 'o', '--head': 'I', '--fail': 'f', '--remote-name': 'O', '--request': 'X', '--header': 'H', '--data': 'd' } });
  const url = rest[0];
  if (!url) throw new UsageError("try 'curl --help' for more information", 2);
  if (o.X && o.X.toUpperCase() !== 'GET' || o.d) throw new UsageError('only GET requests are supported (requests go through the X Coder Worker fetch proxy)', 2);
  let full = url;
  if (!/^https?:\/\//i.test(full)) full = `https://${full}`;
  const r = await fetchUrl(full, ctx.signal);
  if (o.f && r.status >= 400) { ctx.err(`curl: (22) The requested URL returned error: ${r.status}\n`); return 22; }
  const head = `HTTP/1.1 ${r.status}\ncontent-type: ${r.contentType || 'text/plain'}\n\n`;
  if (o.I) { ctx.out(head); return 0; }
  const body = (o.i ? head : '') + r.text;
  const outName = o.o || (o.O ? (posix.basename(new URL(full).pathname) || 'index.html') : null);
  if (outName) {
    await ctx.fs.writeText(ctx.resolve(outName), r.text, { source: 'terminal' });
    if (!o.s) ctx.err(`  % Total    Received\n  ${humanSize(new TextEncoder().encode(r.text).length).padStart(7)}  100%   → ${outName}\n`);
    return 0;
  }
  ctx.out(withNewline(body));
  return 0;
});

def('wget', 'wget [-O file] [-q] <url>', 'Download a URL into the project', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'qc', values: 'OP', long: { '--quiet': 'q', '--output-document': 'O' } });
  const url = rest[0];
  if (!url) throw new UsageError('missing URL');
  let full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  if (!o.q) ctx.err(`--${new Date().toISOString().slice(0, 19).replace('T', ' ')}--  ${full}\n`);
  const r = await fetchUrl(full, ctx.signal);
  if (o.O === '-') { ctx.out(withNewline(r.text)); return 0; }
  let name = o.O || posix.basename(new URL(full).pathname) || 'index.html';
  if (!o.O && ctx.fs.exists(ctx.resolve(name))) { let n = 1; while (ctx.fs.exists(ctx.resolve(`${name}.${n}`))) n++; name = `${name}.${n}`; }
  const dest = o.P ? posix.join(o.P, name) : name;
  await ctx.fs.writeText(ctx.resolve(dest), r.text, { source: 'terminal' });
  if (!o.q) ctx.err(`HTTP request sent, awaiting response... ${r.status}\nLength: ${new TextEncoder().encode(r.text).length} [${(r.contentType || 'text/plain').split(';')[0]}]\nSaving to: '${dest}'\n\n'${dest}' saved\n`);
  return r.status >= 400 ? 8 : 0;
});

// ---------------------------------------------------------------- X Coder AI

async function askAi(ctx, prompt) {
  if (!prompt.trim()) throw new UsageError('usage: ai "question" (e.g. ai "why does npm start fail?")');
  const ai = await aiApi();
  try { await ai.open(); } catch {}
  ctx.println(`${sgr.cyan('✦')} Asking X Coder AI… the answer appears in the Chat view.`);
  const result = await ai.ask(prompt, { attachments: [{ type: 'terminal' }] });
  const text = typeof result === 'string' ? result : result?.text || result?.content || '';
  if (text) ctx.println(`\n${text.trim()}`);
  return 0;
}
def('ai', 'ai "question"', 'Ask X Coder AI (opens the Chat view)', ctx => askAi(ctx, ctx.args.join(' ')), { aliases: ['ask', 'claude', 'copilot', 'chatgpt'] });
def('xcoder', 'xcoder <ask|version|help> …', 'X Coder command line', async ctx => {
  const [sub, ...rest] = ctx.args;
  if (sub === 'ask' || sub === 'ai' || sub === 'chat') return askAi(ctx, rest.join(' '));
  if (sub === 'version' || sub === '--version' || sub === '-v') { ctx.println(`X Coder ${document.documentElement.dataset.xcoderVersion || '6'} (xsh)`); return 0; }
  if (sub === 'run' || sub === 'preview') return ctx.exec(['run', ...rest]);
  if (sub === 'open') return ctx.exec(['code', ...rest]);
  ctx.println('usage: xcoder ask "question" | xcoder run [file] | xcoder open <file> | xcoder version');
  return sub && sub !== 'help' ? 1 : 0;
});

// ---------------------------------------------------------------- zip / unzip

const loadZip = () => import('../../vendor/jszip.js').then(m => m.default);

def('zip', 'zip [-r] archive.zip path…', 'Create a ZIP archive', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'rq9' });
  if (rest.length < 2) throw new UsageError('usage: zip [-r] archive.zip path…');
  let [archive, ...paths] = rest;
  if (!/\.zip$/i.test(archive)) archive += '.zip';
  const JSZip = await loadZip();
  const zip = new JSZip();
  const archivePath = ctx.resolve(archive);
  let count = 0;
  const add = async (p, name) => {
    if (p === archivePath) return;
    const rec = ctx.fs.get(p);
    if (!rec) return;
    if (rec.type === 'folder') { zip.folder(name); if (!o.q) ctx.println(`  adding: ${name}/ (stored 0%)`); return; }
    zip.file(name, rec.binary instanceof Blob ? rec.binary : rec.content || '');
    count++;
    if (!o.q) ctx.println(`  adding: ${name} (deflated)`);
  };
  for (const a of paths) {
    const p = ctx.resolve(a);
    if (!ctx.shell.exists(p)) { ctx.err(`\tzip warning: name not matched: ${a}\n`); continue; }
    if (ctx.shell.isDir(p)) {
      if (!o.r) { await add(p, a.replace(/\/$/, '')); continue; }
      for (const r of ctx.fs.entries()) if (p === '' || r.path === p || r.path.startsWith(p + '/')) await add(r.path, posix.join(a === '.' ? '' : a.replace(/\/$/, ''), p ? r.path.slice(p.length + 1) : r.path) || r.path);
    } else await add(p, a);
  }
  if (!count && !paths.some(a => ctx.shell.exists(ctx.resolve(a)))) throw new UsageError('nothing to do!', 12);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  await ctx.fs.writeBinary(archivePath, blob, { source: 'terminal', mime: 'application/zip' });
  if (!o.q) ctx.println(`${sgr.green('✓')} ${archive} (${humanSize(blob.size)}, ${count} file${count === 1 ? '' : 's'})`);
});

def('unzip', 'unzip [-l] [-o] archive.zip [-d dir]', 'Extract a ZIP archive', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'loqn', values: 'd' });
  if (!rest.length) throw new UsageError('usage: unzip [-l] archive.zip [-d dir]');
  const p = ctx.resolve(rest[0]);
  if (!ctx.fs.isFile(p)) throw new UsageError(`cannot find or open ${rest[0]}`, 9);
  const JSZip = await loadZip();
  let zip;
  try { zip = await JSZip.loadAsync(await ctx.fs.readBlob(p)); } catch (err) { throw new UsageError(`${rest[0]}: not a valid zip file (${err.message})`, 9); }
  const entries = Object.values(zip.files);
  if (o.l) {
    ctx.println('  Length      Date    Time    Name\n---------  ---------- -----   ----');
    let total = 0;
    for (const e of entries) {
      const size = e._data?.uncompressedSize ?? 0; total += size;
      const d = e.date || new Date();
      ctx.println(`${String(size).padStart(9)}  ${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}   ${e.name}`);
    }
    ctx.println(`---------                     -------\n${String(total).padStart(9)}                     ${entries.length} files`);
    return 0;
  }
  const dest = o.d ? ctx.resolve(o.d) : ctx.cwd;
  ctx.println(`Archive:  ${rest[0]}`);
  const items = [];
  let skipped = 0;
  for (const e of entries) {
    const clean = posix.clean(e.name);
    if (!clean || clean.startsWith('..') || clean.startsWith('__MACOSX')) continue;
    const target = posix.join(dest, clean);
    if (e.dir) { items.push({ path: target, folder: true }); continue; }
    if (ctx.fs.exists(target) && !o.o) { if (o.n || !o.o) { skipped++; if (!o.q) ctx.println(`  skipping: ${clean} (already exists; use -o to overwrite)`); continue; } }
    items.push({ path: target, blob: await e.async('blob') });
    if (!o.q) ctx.println(`  inflating: ${clean}`);
  }
  // Store text files as text so the editor, search and git see them.
  const { isTextPath } = await import('../core/path.js');
  const prepared = await Promise.all(items.map(async it => (it.blob && isTextPath(it.path) ? { path: it.path, content: await it.blob.text() } : it)));
  if (prepared.length) await ctx.fs.writeMany(prepared, { source: 'terminal' });
  return skipped && !prepared.length ? 1 : 0;
});

// ---------------------------------------------------------------- git (fallback)

def('git', 'git <command>', 'Git (provided by Source Control)', async ctx => {
  ctx.err('git: the Source Control feature has not registered its git command in this session.\n');
  ctx.err('Use the Source Control view (⌃⇧G) to clone, commit, push and pull with GitHub.\n');
  return 127;
});
