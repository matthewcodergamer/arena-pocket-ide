// xsh builtins: files and folders, text processing and shell commands.
// Each command: { name, summary, usage, category, run(ctx) → exit status }.
// ctx (see Shell.context): { args, stdin, hasStdin, out, err, println, isTTY, columns, fs, cwd, resolve, shell, signal, run, exec }

import { posix } from '../core/path.js';
import { sgr, stripAnsi } from './ansi.js';

export const BUILTINS = new Map();
export const CATEGORIES = ['Files and folders', 'Text processing', 'Shell', 'Project and tools', 'Extensions'];

function def(name, category, usage, summary, run, extra = {}) {
  const cmd = { name, category, usage, summary, run, ...extra };
  for (const n of [name, ...(extra.aliases || [])]) BUILTINS.set(n, n === name ? cmd : { ...cmd, name: n, hidden: true });
  return cmd;
}

// ---------------------------------------------------------------- helpers

export class UsageError extends Error { constructor(message, status = 1) { super(message); this.status = status; } }

/**
 * Parses short options. spec: { flags: 'la1R', values: 'nL' } → { o: { l: true, n: '5' }, rest: [] }
 * Supports grouped flags (-la), attached values (-n5), '--' and long options listed in spec.long ({ '--all': 'a' }).
 */
export function getopts(args, { flags = '', values = '', long = {}, numeric = null } = {}) {
  const o = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const [k, v] = a.split(/=(.*)/s);
      const mapped = long[k];
      if (!mapped) throw new UsageError(`unrecognized option '${a}'`, 2);
      if (values.includes(mapped)) o[mapped] = v ?? args[++i];
      else o[mapped] = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (numeric && /^-\d+$/.test(a)) { o[numeric] = a.slice(1); continue; }
      let j = 1;
      for (; j < a.length; j++) {
        const f = a[j];
        if (values.includes(f)) {
          const v = a.slice(j + 1) || args[++i];
          if (v == null) throw new UsageError(`option requires an argument -- '${f}'`, 2);
          o[f] = v; break;
        }
        if (!flags.includes(f)) throw new UsageError(`invalid option -- '${f}'`, 2);
        o[f] = true;
      }
      continue;
    }
    rest.push(a);
  }
  return { o, rest };
}

const noEntry = (name, arg) => new UsageError(`${arg}: No such file or directory`);

/** Reads each named file (or stdin when none / '-') → [{ name, text }]. Reports unreadable files on stderr. */
async function inputs(ctx, files) {
  if (!files.length) return [{ name: '', text: ctx.stdin, stdin: true }];
  const out = [];
  for (const f of files) {
    if (f === '-') { out.push({ name: '-', text: ctx.stdin, stdin: true }); continue; }
    const p = ctx.resolve(f);
    if (!ctx.shell.exists(p)) { ctx.err(`${ctx.name}: ${f}: No such file or directory\n`); ctx.failed = true; continue; }
    if (ctx.shell.isDir(p)) { ctx.err(`${ctx.name}: ${f}: Is a directory\n`); ctx.failed = true; continue; }
    out.push({ name: f, path: p, text: await ctx.fs.readText(p) });
  }
  return out;
}
const linesOf = text => { const l = String(text).split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
const joinLines = lines => lines.length ? lines.join('\n') + '\n' : '';
const visLen = s => [...stripAnsi(s)].length;
const padStart = (s, n) => ' '.repeat(Math.max(0, n - visLen(s))) + s;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - visLen(s)));

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['K', 'M', 'G'];
  let v = bytes / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[u]}`;
}

/** GNU ls-style column layout (column-major) for the terminal width. */
export function columnize(items, width) {
  if (!items.length) return '';
  const lens = items.map(visLen);
  for (let rows = 1; rows <= items.length; rows++) {
    const cols = Math.ceil(items.length / rows);
    const widths = [];
    for (let c = 0; c < cols; c++) {
      let w = 0;
      for (let r = 0; r < rows; r++) { const i = c * rows + r; if (i < items.length) w = Math.max(w, lens[i]); }
      widths.push(w);
    }
    const total = widths.reduce((a, w) => a + w, 0) + (cols - 1) * 2;
    if (total <= width || rows === items.length) {
      const lines = [];
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          const i = c * rows + r;
          if (i >= items.length) continue;
          const last = c === cols - 1 || (c + 1) * rows + r >= items.length;
          line += last ? items[i] : padEnd(items[i], widths[c] + 2);
        }
        lines.push(line);
      }
      return lines.join('\n') + '\n';
    }
  }
  return items.join('\n') + '\n';
}

function entryInfo(ctx, path) {
  const fs = ctx.fs;
  if (path === '') return { path, name: '.', dir: true, size: 4096, mtime: Date.now(), rec: null };
  const rec = fs.get(path);
  if (!rec) return null;
  const dir = rec.type === 'folder';
  return { path, name: posix.basename(path), dir, size: dir ? 4096 : fs.size(path), mtime: rec.updatedAt || rec.createdAt || Date.now(), rec, binary: fs.isBinary(path) };
}
function children(ctx, dir, { all = false } = {}) {
  return ctx.fs.list(dir)
    .filter(r => all || !posix.basename(r.path).startsWith('.'))
    .map(r => entryInfo(ctx, r.path))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}
function colorName(ctx, info, name = info.name, { classify = false } = {}) {
  const slash = info.dir && (classify || ctx.isTTY) && !name.endsWith('/') ? '/' : '';
  if (!ctx.isTTY) return name + slash;
  if (info.dir) return sgr.boldBlue(name + slash);
  if (/\.(zip|tar|gz|tgz|rar|7z)$/i.test(name)) return `\x1b[1;31m${name}\x1b[0m`;
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|mp4|mov|mp3|wav)$/i.test(name)) return `\x1b[1;35m${name}\x1b[0m`;
  if (/\.(sh|command)$/i.test(name)) return sgr.boldGreen(name);
  return name;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function lsDate(ts) {
  const d = new Date(ts);
  const recent = Math.abs(Date.now() - ts) < 182 * 24 * 3600 * 1000;
  const tail = recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${tail.padStart(5, ' ')}`;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}
export { sleep };

// ---------------------------------------------------------------- files and folders

def('ls', 'Files and folders', 'ls [-laAR1FhdrtS] [path…]', 'List directory contents', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'laAR1FhdrtSCG', long: { '--all': 'a', '--almost-all': 'A', '--recursive': 'R', '--human-readable': 'h', '--classify': 'F', '--color': 'G' } });
  const all = o.a || o.A;
  const targets = rest.length ? rest : ['.'];
  let status = 0;
  const files = [], dirs = [];
  for (const t of targets) {
    const info = entryInfo(ctx, ctx.resolve(t));
    if (!info) { ctx.err(`ls: ${t}: No such file or directory\n`); status = 1; continue; }
    if (info.dir && !o.d) dirs.push({ arg: t, info }); else files.push({ arg: t, info });
  }
  const sortList = list => {
    if (o.t) list.sort((a, b) => b.mtime - a.mtime);
    else if (o.S) list.sort((a, b) => b.size - a.size);
    if (o.r) list.reverse();
    return list;
  };
  const long = list => {
    const rows = list.map(i => ({
      mode: (i.dir ? 'drwxr-xr-x' : '-rw-r--r--'),
      links: i.dir ? String(2 + children(ctx, i.path, { all: true }).filter(c => c.dir).length) : '1',
      size: o.h ? humanSize(i.size) : String(i.size),
      date: lsDate(i.mtime), name: colorName(ctx, i, i.displayName || i.name, { classify: o.F })
    }));
    const w = k => Math.max(...rows.map(r => r[k].length));
    const [wl, ws] = [w('links'), w('size')];
    return rows.map(r => `${r.mode}  ${r.links.padStart(wl)} user  staff  ${r.size.padStart(ws)} ${r.date} ${r.name}`).join('\n') + (rows.length ? '\n' : '');
  };
  const render = list => {
    if (o.l) return long(list);
    const names = list.map(i => colorName(ctx, i, i.displayName || i.name, { classify: o.F }));
    if (o['1'] || !ctx.isTTY) return names.length ? names.join('\n') + '\n' : '';
    return columnize(names, ctx.columns);
  };
  if (files.length) ctx.out(render(sortList(files.map(f => ({ ...f.info, displayName: f.arg })))));
  const listDir = (arg, path, first) => {
    let kids = children(ctx, path, { all });
    if (o.a) {
      const dot = { ...entryInfo(ctx, path), name: '.', displayName: '.' };
      const parent = { ...entryInfo(ctx, posix.dirname(path)), name: '..', displayName: '..' };
      kids = [dot, parent, ...kids];
    }
    const header = (dirs.length + files.length > 1 || o.R) ? `${first && !files.length ? '' : '\n'}${arg}:\n` : '';
    const total = o.l ? `total ${kids.reduce((n, k) => n + Math.ceil((k.dir ? 0 : k.size) / 512), 0)}\n` : '';
    ctx.out(header + total + render(sortList(kids)));
    if (o.R) for (const k of kids) if (k.dir && k.name !== '.' && k.name !== '..') listDir(arg === '.' ? `./${k.name}` : `${arg.replace(/\/$/, '')}/${k.name}`, k.path, false);
  };
  dirs.forEach((d, i) => listDir(d.arg, d.info.path, i === 0));
  return status;
});

def('tree', 'Files and folders', 'tree [-L level] [-a] [-d] [path]', 'Show the folder tree', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'adf', values: 'L' });
  const max = o.L ? Math.max(1, parseInt(o.L, 10) || 1) : Infinity;
  const arg = rest[0] || '.';
  const root = ctx.resolve(arg);
  if (!ctx.shell.exists(root)) throw new UsageError(`${arg} [error opening dir]`);
  let nd = 0, nf = 0;
  const lines = [ctx.isTTY ? sgr.boldBlue(arg) : arg];
  const walk = (dir, prefix, depth) => {
    const kids = children(ctx, dir, { all: o.a }).filter(k => !o.d || k.dir);
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      const name = colorName(ctx, k, o.f ? posix.join(arg, posix.relative(root || '.', k.path)) : k.name);
      lines.push(`${prefix}${last ? '└── ' : '├── '}${ctx.isTTY ? name : name.replace(/\/$/, '')}`);
      if (k.dir) { nd++; if (depth < max) walk(k.path, prefix + (last ? '    ' : '│   '), depth + 1); }
      else nf++;
    });
  };
  if (!ctx.shell.isDir(root)) { ctx.println(arg); ctx.println('\n0 directories, 1 file'); return 0; }
  walk(root, '', 1);
  ctx.out(lines.join('\n') + `\n\n${nd} director${nd === 1 ? 'y' : 'ies'}${o.d ? '' : `, ${nf} file${nf === 1 ? '' : 's'}`}\n`);
});

def('pwd', 'Files and folders', 'pwd', 'Print the working directory', async ctx => { ctx.println(ctx.shell.pwd()); });

def('cd', 'Files and folders', 'cd [dir | - | ~ | ..]', 'Change the working directory', async ctx => {
  const arg = ctx.args[0] ?? '~';
  if (arg === '-') {
    ctx.shell.setCwd(ctx.shell.oldCwd);
    ctx.println(ctx.shell.pwd());
    return 0;
  }
  const p = ctx.resolve(arg);
  if (!ctx.shell.exists(p)) throw new UsageError(`${arg}: No such file or directory`);
  if (!ctx.shell.isDir(p)) throw new UsageError(`${arg}: Not a directory`);
  ctx.shell.setCwd(p);
});

def('cat', 'Files and folders', 'cat [-n] [file…]', 'Print files', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'nbsEAv' });
  let n = 0;
  for (const f of await inputs(ctx, rest)) {
    if (f.path && ctx.fs.isBinary(f.path)) { ctx.err(`cat: ${f.name}: binary file (${humanSize(ctx.fs.size(f.path))}) not shown\n`); ctx.failed = true; continue; }
    if (!o.n && !o.b) { ctx.out(f.text); continue; }
    ctx.out(joinLines(linesOf(f.text).map(l => (o.b && !l ? '' : `${String(++n).padStart(6)}\t`) + l)));
  }
  return ctx.failed ? 1 : 0;
}, { aliases: ['less', 'more'] });

async function headTail(ctx, tail) {
  const { o, rest } = getopts(ctx.args, { flags: 'qv', values: 'nc', numeric: 'n' });
  const spec = String(o.n ?? '10');
  const fromStart = tail && spec.startsWith('+');
  const n = Math.abs(parseInt(spec, 10));
  if (Number.isNaN(n)) throw new UsageError(`invalid number of lines: '${spec}'`);
  const list = await inputs(ctx, rest);
  list.forEach((f, i) => {
    if (list.length > 1 && !o.q) ctx.out(`${i ? '\n' : ''}==> ${f.name} <==\n`);
    if (o.c) { const c = parseInt(o.c, 10) || 0; ctx.out(tail ? f.text.slice(-c) : f.text.slice(0, c)); return; }
    const lines = linesOf(f.text);
    const pick = !tail ? lines.slice(0, n) : fromStart ? lines.slice(Math.max(0, n - 1)) : lines.slice(Math.max(0, lines.length - n));
    ctx.out(joinLines(pick));
  });
  return ctx.failed ? 1 : 0;
}
def('head', 'Text processing', 'head [-n N] [file…]', 'Print the first lines', ctx => headTail(ctx, false));
def('tail', 'Text processing', 'tail [-n N|+N] [file…]', 'Print the last lines', ctx => {
  if (ctx.args.includes('-f')) throw new UsageError('-f (follow) is not supported: project files do not stream');
  return headTail(ctx, true);
});

def('wc', 'Text processing', 'wc [-lwcm] [file…]', 'Count lines, words and bytes', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'lwcm' });
  const show = o.l || o.w || o.c || o.m ? o : { l: true, w: true, c: true };
  const rows = [];
  const tot = { l: 0, w: 0, c: 0, m: 0 };
  for (const f of await inputs(ctx, rest)) {
    const r = { l: (f.text.match(/\n/g) || []).length, w: (f.text.match(/\S+/g) || []).length, c: new TextEncoder().encode(f.text).length, m: [...f.text].length, name: f.stdin ? '' : f.name };
    for (const k of ['l', 'w', 'c', 'm']) tot[k] += r[k];
    rows.push(r);
  }
  if (rows.length > 1) rows.push({ ...tot, name: 'total' });
  const keys = ['l', 'w', 'm', 'c'].filter(k => show[k]);
  const width = rows.length === 1 && !rows[0].name ? 7 : Math.max(...rows.flatMap(r => keys.map(k => String(r[k]).length)));
  for (const r of rows) ctx.println(keys.map(k => String(r[k]).padStart(width)).join(' ') + (r.name ? ` ${r.name}` : ''));
  return ctx.failed ? 1 : 0;
});

def('touch', 'Files and folders', 'touch file…', 'Create files or update their timestamps', async ctx => {
  if (!ctx.args.length) throw new UsageError('missing file operand');
  let status = 0;
  for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
    const p = ctx.resolve(f);
    if (!p) continue;
    if (!ctx.shell.isDir(posix.dirname(p))) { ctx.err(`touch: ${f}: No such file or directory\n`); status = 1; continue; }
    if (ctx.fs.isFolder(p)) continue;
    const rec = ctx.fs.get(p);
    if (rec?.binary instanceof Blob) await ctx.fs.writeBinary(p, rec.binary, { source: 'terminal' });
    else await ctx.fs.writeText(p, rec ? rec.content || '' : '', { source: 'terminal' });
  }
  return status;
});

def('mkdir', 'Files and folders', 'mkdir [-p] dir…', 'Create folders', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'pv' });
  if (!rest.length) throw new UsageError('missing operand');
  let status = 0;
  for (const d of rest) {
    const p = ctx.resolve(d);
    if (!p || ctx.shell.exists(p)) {
      if (o.p && ctx.shell.isDir(p)) continue;
      ctx.err(`mkdir: ${d}: File exists\n`); status = 1; continue;
    }
    if (!o.p && !ctx.shell.isDir(posix.dirname(p))) { ctx.err(`mkdir: ${d}: No such file or directory\n`); status = 1; continue; }
    try { await ctx.fs.mkdir(p, { source: 'terminal' }); if (o.v) ctx.println(`mkdir: created directory '${d}'`); }
    catch (err) { ctx.err(`mkdir: ${d}: ${err.message}\n`); status = 1; }
  }
  return status;
});

def('rm', 'Files and folders', 'rm [-rf] path…', 'Remove files or folders', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'rRfivd', long: { '--recursive': 'r', '--force': 'f', '--verbose': 'v' } });
  if (!rest.length) { if (o.f) return 0; throw new UsageError('missing operand'); }
  let status = 0;
  for (const a of rest) {
    if (a === '.' || a === '..' || /\/\.\.?$/.test(a)) { ctx.err(`rm: "." and ".." may not be removed\n`); status = 1; continue; }
    const p = ctx.resolve(a);
    if (p === '') { ctx.err(`rm: refusing to remove the project root ('${a}')\n`); status = 1; continue; }
    if (!ctx.shell.exists(p)) { if (!o.f) { ctx.err(`rm: ${a}: No such file or directory\n`); status = 1; } continue; }
    if (ctx.shell.isDir(p) && !(o.r || o.R) && !(o.d && !ctx.fs.list(p).length)) { ctx.err(`rm: ${a}: is a directory\n`); status = 1; continue; }
    await ctx.fs.remove(p, { source: 'terminal' });
    if (o.v) ctx.println(a);
  }
  return status;
});

def('rmdir', 'Files and folders', 'rmdir dir…', 'Remove empty folders', async ctx => {
  let status = 0;
  for (const a of ctx.args) {
    const p = ctx.resolve(a);
    if (!ctx.shell.exists(p) || !p) { ctx.err(`rmdir: ${a}: No such file or directory\n`); status = 1; continue; }
    if (!ctx.shell.isDir(p)) { ctx.err(`rmdir: ${a}: Not a directory\n`); status = 1; continue; }
    if (ctx.fs.list(p).length) { ctx.err(`rmdir: ${a}: Directory not empty\n`); status = 1; continue; }
    await ctx.fs.remove(p, { source: 'terminal' });
  }
  return status;
});

async function copyFile(ctx, from, to) {
  const rec = ctx.fs.get(from);
  if (rec.binary instanceof Blob) await ctx.fs.writeBinary(to, rec.binary, { source: 'terminal', mime: rec.mime });
  else await ctx.fs.writeText(to, rec.content || '', { source: 'terminal' });
}

def('mv', 'Files and folders', 'mv [-fv] source… dest', 'Move or rename files and folders', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'fivn' });
  if (rest.length < 2) throw new UsageError(rest.length ? `missing destination file operand after '${rest[0]}'` : 'missing file operand');
  const destArg = rest.pop();
  const dest = ctx.resolve(destArg);
  const intoDir = ctx.shell.isDir(dest);
  if (rest.length > 1 && !intoDir) throw new UsageError(`${destArg}: Not a directory`);
  let status = 0;
  for (const s of rest) {
    const src = ctx.resolve(s);
    if (!src) { ctx.err(`mv: cannot move the project root\n`); status = 1; continue; }
    if (!ctx.shell.exists(src)) { ctx.err(`mv: ${s}: No such file or directory\n`); status = 1; continue; }
    const target = intoDir ? posix.join(dest, posix.basename(src)) : dest;
    if (target === src) continue;
    if (target.startsWith(src + '/')) { ctx.err(`mv: cannot move '${s}' to a subdirectory of itself\n`); status = 1; continue; }
    if (ctx.shell.exists(target)) {
      if (o.n) continue;
      if (ctx.shell.isDir(target)) { ctx.err(`mv: ${destArg}/${posix.basename(src)}: Directory not empty\n`); status = 1; continue; }
    }
    try { await ctx.fs.rename(src, target, { source: 'terminal', overwrite: true }); if (o.v) ctx.println(`${s} -> ${posix.relative(ctx.cwd || '.', target)}`); }
    catch (err) { ctx.err(`mv: ${err.message}\n`); status = 1; }
  }
  return status;
});

def('cp', 'Files and folders', 'cp [-rv] source… dest', 'Copy files and folders', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'rRfvnpa' });
  if (rest.length < 2) throw new UsageError(rest.length ? `missing destination file operand after '${rest[0]}'` : 'missing file operand');
  const destArg = rest.pop();
  const dest = ctx.resolve(destArg);
  const intoDir = ctx.shell.isDir(dest);
  if (rest.length > 1 && !intoDir) throw new UsageError(`${destArg}: Not a directory`);
  let status = 0;
  for (const s of rest) {
    const src = ctx.resolve(s);
    if (!ctx.shell.exists(src)) { ctx.err(`cp: ${s}: No such file or directory\n`); status = 1; continue; }
    if (!src) { ctx.err(`cp: cannot copy the project root ('${s}') into itself\n`); status = 1; continue; }
    const target = intoDir ? posix.join(dest, posix.basename(src)) : dest;
    if (ctx.shell.isDir(src)) {
      if (!(o.r || o.R || o.a)) { ctx.err(`cp: -r not specified; omitting directory '${s}'\n`); status = 1; continue; }
      if (target === src || target.startsWith(src + '/')) { ctx.err(`cp: cannot copy a directory, '${s}', into itself\n`); status = 1; continue; }
      if (ctx.shell.exists(target)) { ctx.err(`cp: ${destArg}: File exists\n`); status = 1; continue; }
      await ctx.fs.copy(src, target, { source: 'terminal' });
    } else {
      if (ctx.fs.isFolder(target)) { ctx.err(`cp: ${destArg}: Is a directory\n`); status = 1; continue; }
      if (o.n && ctx.shell.exists(target)) continue;
      await copyFile(ctx, src, target);
    }
    if (o.v) ctx.println(`'${s}' -> '${posix.relative(ctx.cwd || '.', target)}'`);
  }
  return status;
});

def('du', 'Files and folders', 'du [-shac] [path…]', 'Show disk usage', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'shac' });
  const fmt = b => (o.h ? humanSize(b) : String(Math.ceil(b / 1024)));
  const sizeOf = path => ctx.fs.files().filter(r => path === '' || r.path.startsWith(path + '/')).reduce((n, r) => n + ctx.fs.size(r.path), 0);
  const walk = (path, label) => {
    let sum = 0;
    for (const k of children(ctx, path, { all: true })) {
      const l = `${label}/${k.name}`;
      if (k.dir) sum += walk(k.path, l);
      else { sum += k.size; if (o.a) ctx.println(`${fmt(k.size)}\t${l}`); }
    }
    ctx.println(`${fmt(sum)}\t${label}`);
    return sum;
  };
  let grand = 0, status = 0;
  for (const a of rest.length ? rest : ['.']) {
    const p = ctx.resolve(a);
    const label = a.replace(/(.)\/+$/, '$1');
    if (!ctx.shell.exists(p)) { ctx.err(`du: ${a}: No such file or directory\n`); status = 1; continue; }
    if (!ctx.shell.isDir(p)) { const n = ctx.fs.size(p); grand += n; ctx.println(`${fmt(n)}\t${label}`); continue; }
    if (o.s) { const n = sizeOf(p); grand += n; ctx.println(`${fmt(n)}\t${label}`); continue; }
    grand += walk(p, label);
  }
  if (o.c) ctx.println(`${fmt(grand)}\ttotal`);
  return status;
});

def('stat', 'Files and folders', 'stat path…', 'Show file details', async ctx => {
  let status = 0;
  for (const a of ctx.args) {
    const info = entryInfo(ctx, ctx.resolve(a));
    if (!info) { ctx.err(`stat: ${a}: No such file or directory\n`); status = 1; continue; }
    const d = ts => new Date(ts).toISOString().replace('T', ' ').replace('Z', ' +0000');
    ctx.out(`  File: ${a}\n  Size: ${String(info.size).padEnd(12)} Type: ${info.dir ? 'directory' : info.binary ? 'regular file (binary)' : 'regular file'}\n` +
      (info.rec?.mime && !info.dir ? `  Mime: ${info.rec.mime}\n` : '') +
      `Access: (${info.dir ? '0755/drwxr-xr-x' : '0644/-rw-r--r--'})  Uid: (501/user)  Gid: (20/staff)\n` +
      `Modify: ${d(info.mtime)}\n Birth: ${d(info.rec?.createdAt || info.mtime)}\n`);
  }
  return status;
});

def('find', 'Files and folders', 'find [path…] [-name pat] [-iname pat] [-type f|d] [-maxdepth n]', 'Search for files by name', async ctx => {
  const starts = [];
  let i = 0;
  for (; i < ctx.args.length && !ctx.args[i].startsWith('-'); i++) starts.push(ctx.args[i]);
  const tests = [];
  let maxdepth = Infinity, mindepth = 0;
  const { globToRegExp } = await import('./shell.js');
  for (; i < ctx.args.length; i++) {
    const a = ctx.args[i], v = ctx.args[i + 1];
    const need = () => { if (v == null) throw new UsageError(`missing argument to \`${a}'`); i++; return v; };
    if (a === '-name' || a === '-iname') { const re = globToRegExp(need()); const ci = a === '-iname' ? new RegExp(re.source, 'i') : re; tests.push(e => ci.test(e.name)); }
    else if (a === '-path' || a === '-wholename') { const re = globToRegExp(need().replace(/^\.\//, '')); tests.push(e => re.test(e.rel) || re.test(e.shown)); }
    else if (a === '-type') { const t = need(); if (!['f', 'd'].includes(t)) throw new UsageError(`Unknown argument to -type: ${t}`); tests.push(e => (t === 'd') === e.dir); }
    else if (a === '-maxdepth') maxdepth = parseInt(need(), 10);
    else if (a === '-mindepth') mindepth = parseInt(need(), 10);
    else if (a === '-empty') tests.push(e => e.dir ? !ctx.fs.list(e.path).length : e.size === 0);
    else if (a === '-print') continue;
    else throw new UsageError(`unknown predicate \`${a}'`);
  }
  let status = 0;
  for (const s of starts.length ? starts : ['.']) {
    const root = ctx.resolve(s);
    if (!ctx.shell.exists(root)) { ctx.err(`find: ${s}: No such file or directory\n`); status = 1; continue; }
    const emit = (path, depth) => {
      const info = entryInfo(ctx, path);
      const rel = root ? (path === root ? '' : path.slice(root.length + 1)) : path;
      const shown = rel ? `${s.replace(/\/$/, '')}/${rel}` : s;
      const e = { ...info, name: rel ? posix.basename(path) : posix.basename(s) || s, rel, shown, path };
      if (depth >= mindepth && tests.every(t => t(e))) ctx.println(ctx.isTTY && info.dir ? sgr.boldBlue(shown) : shown);
      if (info.dir && depth < maxdepth) for (const r of ctx.fs.list(path)) emit(r.path, depth + 1);
    };
    emit(root, 0);
  }
  return status;
});

def('basename', 'Files and folders', 'basename path [suffix]', 'Strip the folder from a path', async ctx => {
  if (!ctx.args.length) throw new UsageError('missing operand');
  let b = posix.basename(ctx.args[0]) || '/';
  if (ctx.args[1] && b.endsWith(ctx.args[1]) && b !== ctx.args[1]) b = b.slice(0, -ctx.args[1].length);
  ctx.println(b);
});
def('dirname', 'Files and folders', 'dirname path', 'Strip the last component from a path', async ctx => {
  if (!ctx.args.length) throw new UsageError('missing operand');
  const a = ctx.args[0].replace(/\/+$/, '');
  const i = a.lastIndexOf('/');
  ctx.println(i < 0 ? '.' : i === 0 ? '/' : a.slice(0, i));
});

// ---------------------------------------------------------------- text processing

def('echo', 'Text processing', 'echo [-neE] [text…]', 'Print text', async ctx => {
  let n = false, e = false, i = 0;
  for (; i < ctx.args.length && /^-[neE]+$/.test(ctx.args[i]); i++) {
    for (const f of ctx.args[i].slice(1)) { if (f === 'n') n = true; else if (f === 'e') e = true; else e = false; }
  }
  let text = ctx.args.slice(i).join(' ');
  if (e) { const r = unescape(text); text = r.text; if (r.stop) n = true; }
  ctx.out(text + (n ? '' : '\n'));
});

function unescape(s) {
  let stop = false;
  const ci = s.indexOf('\\c');
  if (ci >= 0) { s = s.slice(0, ci); stop = true; }
  const text = s.replace(/\\(0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|[abefnrtv\\'"])/g, (m, c) => {
    if (c[0] === '0') return String.fromCharCode(parseInt(c.slice(1) || '0', 8));
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    if (c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
    return { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"' }[c];
  });
  return { text, stop };
}

export function printfFormat(fmt, args) {
  fmt = unescape(fmt).text;
  let out = '', ai = 0, consumed;
  do {
    consumed = false;
    out += fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([sdifxXocuegEGb%])/g, (m, flags, width, prec, conv) => {
      if (conv === '%') return '%';
      if (width === '*') { width = args[ai++]; consumed = true; }
      const arg = args[ai++]; if (arg !== undefined) consumed = true;
      let v;
      switch (conv) {
        case 's': v = String(arg ?? ''); if (prec != null) v = v.slice(0, +prec); break;
        case 'b': v = unescape(String(arg ?? '')).text; break;
        case 'c': v = String(arg ?? '').slice(0, 1); break;
        case 'd': case 'i': case 'u': v = String(Math.trunc(Number(arg ?? 0)) || 0); if (flags.includes('+') && !v.startsWith('-')) v = '+' + v; break;
        case 'f': case 'e': case 'E': case 'g': case 'G': {
          const num = Number(arg ?? 0) || 0;
          v = conv === 'f' ? num.toFixed(prec != null ? +prec : 6) : conv.toLowerCase() === 'e' ? num.toExponential(prec != null ? +prec : 6) : String(Number(num.toPrecision(prec != null ? +prec || 1 : 6)));
          if (conv === 'E' || conv === 'G') v = v.toUpperCase();
          break;
        }
        case 'x': v = (Math.trunc(Number(arg ?? 0)) >>> 0).toString(16); break;
        case 'X': v = (Math.trunc(Number(arg ?? 0)) >>> 0).toString(16).toUpperCase(); break;
        case 'o': v = (Math.trunc(Number(arg ?? 0)) >>> 0).toString(8); break;
      }
      const w = parseInt(width, 10) || 0;
      if (v.length < w) v = flags.includes('-') ? v.padEnd(w) : flags.includes('0') && /[dfixXoeg]/i.test(conv) ? v.padStart(w, '0') : v.padStart(w);
      return v;
    });
  } while (consumed && ai < args.length);
  return out;
}
def('printf', 'Text processing', 'printf format [args…]', 'Format and print text', async ctx => {
  if (!ctx.args.length) throw new UsageError('usage: printf format [arguments]', 2);
  ctx.out(printfFormat(ctx.args[0], ctx.args.slice(1)));
});

def('grep', 'Text processing', 'grep [-rinvlcwoEFH] pattern [path…]', 'Search text with a pattern', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'rRinvlLcwoEFHhqsI', values: 'em', long: { '--recursive': 'r', '--ignore-case': 'i', '--line-number': 'n', '--invert-match': 'v', '--count': 'c', '--files-with-matches': 'l', '--word-regexp': 'w' } });
  const patterns = o.e ? [o.e] : rest.length ? [rest.shift()] : null;
  if (!patterns) throw new UsageError('usage: grep [-rinvlcw] pattern [path…]', 2);
  let src = patterns.map(p => (o.F ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : p.replace(/\\([<>])/g, '\\b').replace(/\\([|(){}+?])/g, (m, c) => o.E ? m : c))).join('|');
  if (o.w) src = `\\b(?:${src})\\b`;
  let re;
  try { re = new RegExp(src, o.i ? 'gi' : 'g'); } catch (err) { throw new UsageError(`invalid regular expression: ${err.message}`, 2); }
  const recursive = o.r || o.R;
  const files = [];
  let useStdin = false;
  if (!rest.length) { if (recursive) rest.push('.'); else useStdin = true; }
  for (const a of rest) {
    const p = ctx.resolve(a);
    if (!ctx.shell.exists(p)) { if (!o.s) ctx.err(`grep: ${a}: No such file or directory\n`); ctx.failed = true; continue; }
    if (ctx.shell.isDir(p)) {
      if (!recursive) { if (!o.s) ctx.err(`grep: ${a}: Is a directory\n`); continue; }
      for (const r of ctx.fs.files()) if ((p === '' || r.path.startsWith(p + '/')) && !/(^|\/)(\.git|node_modules)\//.test(r.path)) {
        files.push({ label: a === '.' ? r.path.slice(p ? p.length + 1 : 0) : `${a.replace(/\/$/, '')}/${r.path.slice(p ? p.length + 1 : 0)}`, path: r.path });
      }
    } else files.push({ label: a, path: p });
  }
  const multi = o.H || (!o.h && (files.length > 1 || recursive));
  const color = ctx.isTTY;
  const max = o.m ? parseInt(o.m, 10) : Infinity;
  let matched = false;
  const scan = (label, text) => {
    let count = 0;
    const lines = linesOf(text);
    for (let i = 0; i < lines.length && count < max; i++) {
      re.lastIndex = 0;
      const hit = re.test(lines[i]);
      if (hit === !!o.v) continue;
      count++; matched = true;
      if (o.q || o.l || o.L || o.c) continue;
      const prefix = (multi ? (color ? `\x1b[35m${label}\x1b[0m\x1b[36m:\x1b[0m` : `${label}:`) : '') + (o.n ? (color ? `\x1b[32m${i + 1}\x1b[0m\x1b[36m:\x1b[0m` : `${i + 1}:`) : '');
      if (o.o && !o.v) {
        re.lastIndex = 0;
        for (const m of lines[i].matchAll(re)) if (m[0]) ctx.println(prefix + (color ? `\x1b[1;31m${m[0]}\x1b[0m` : m[0]));
        continue;
      }
      re.lastIndex = 0;
      ctx.println(prefix + (color && !o.v ? lines[i].replace(re, m => (m ? `\x1b[1;31m${m}\x1b[0m` : m)) : lines[i]));
    }
    if (o.c) ctx.println((multi ? `${label}:` : '') + count);
    if (o.l && count) ctx.println(color ? `\x1b[35m${label}\x1b[0m` : label);
    if (o.L && !count) ctx.println(label);
  };
  if (useStdin) scan('(standard input)', ctx.stdin);
  for (const f of files) {
    if (ctx.signal?.aborted) break;
    if (ctx.fs.isBinary(f.path)) continue;
    const text = ctx.fs.peekText(f.path) ?? '';
    if (o.I && /\u0000/.test(text)) continue;
    scan(f.label, text);
  }
  if (ctx.failed && !matched) return 2;
  return matched ? 0 : 1;
});

def('sort', 'Text processing', 'sort [-rnufh] [-k N] [-t sep] [file…]', 'Sort lines', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'rnufhbV', values: 'kto' });
  let lines = (await inputs(ctx, rest)).flatMap(f => linesOf(f.text));
  const key = l => {
    if (!o.k) return l;
    const n = parseInt(o.k, 10) - 1;
    const parts = o.t ? l.split(o.t) : l.trim().split(/\s+/);
    return parts.slice(n).join(o.t || ' ');
  };
  const num = s => { const m = String(s).trim().match(/^-?\d+(\.\d+)?([KMG])?/i); if (!m) return 0; return parseFloat(m[0]) * (o.h && m[2] ? 1024 ** ('KMG'.indexOf(m[2].toUpperCase()) + 1) : 1); };
  lines.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (o.n || o.h) return num(ka) - num(kb) || ka.localeCompare(kb);
    return o.f ? ka.toLowerCase().localeCompare(kb.toLowerCase()) : (ka < kb ? -1 : ka > kb ? 1 : 0);
  });
  if (o.r) lines.reverse();
  if (o.u) lines = lines.filter((l, i) => i === 0 || (o.f ? l.toLowerCase() !== lines[i - 1].toLowerCase() : l !== lines[i - 1]));
  if (o.o) { await ctx.fs.writeText(ctx.resolve(o.o), joinLines(lines), { source: 'terminal' }); return 0; }
  ctx.out(joinLines(lines));
});

def('uniq', 'Text processing', 'uniq [-cdui] [file]', 'Collapse repeated lines', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'cdui' });
  const lines = (await inputs(ctx, rest.slice(0, 1))).flatMap(f => linesOf(f.text));
  const groups = [];
  for (const l of lines) {
    const g = groups[groups.length - 1];
    if (g && (o.i ? g.line.toLowerCase() === l.toLowerCase() : g.line === l)) g.n++; else groups.push({ line: l, n: 1 });
  }
  const out = groups.filter(g => (!o.d || g.n > 1) && (!o.u || g.n === 1)).map(g => (o.c ? `${String(g.n).padStart(7)} ${g.line}` : g.line));
  const text = joinLines(out);
  if (rest[1]) await ctx.fs.writeText(ctx.resolve(rest[1]), text, { source: 'terminal' }); else ctx.out(text);
});

function parseRanges(spec) {
  return String(spec).split(',').map(part => {
    const m = part.match(/^(\d*)(-?)(\d*)$/);
    if (!m || (!m[1] && !m[3])) throw new UsageError(`invalid field value '${part}'`);
    const a = m[1] ? +m[1] : 1, b = m[2] ? (m[3] ? +m[3] : Infinity) : a;
    return [a, b];
  });
}
const inRanges = (ranges, n) => ranges.some(([a, b]) => n >= a && n <= b);
def('cut', 'Text processing', 'cut -d delim -f fields | -c chars [file…]', 'Select columns from each line', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 's', values: 'dfcb' });
  if (!o.f && !o.c && !o.b) throw new UsageError('you must specify a list of bytes, characters, or fields', 1);
  const d = o.d ?? '\t';
  const ranges = parseRanges(o.f || o.c || o.b);
  const out = [];
  for (const f of await inputs(ctx, rest)) for (const line of linesOf(f.text)) {
    if (o.f) {
      if (!line.includes(d)) { if (!o.s) out.push(line); continue; }
      out.push(line.split(d).filter((_, i) => inRanges(ranges, i + 1)).join(d));
    } else out.push([...line].filter((_, i) => inRanges(ranges, i + 1)).join(''));
  }
  ctx.out(joinLines(out));
});

function parseSed(script, ere) {
  const cmds = [];
  let i = 0;
  const readRe = delim => {
    let s = '';
    while (i < script.length && script[i] !== delim) { if (script[i] === '\\' && script[i + 1] === delim) { s += delim; i += 2; continue; } s += script[i++]; }
    if (script[i] !== delim) throw new UsageError(`unterminated address regex`);
    i++;
    return s;
  };
  const toJs = re => ere ? re : re.replace(/\\([(){}+?|])/g, '$1_ESC_').replace(/([(){}+?|])(?!_ESC_)/g, '\\$1').replace(/_ESC_/g, '');
  while (i < script.length) {
    while (/[\s;]/.test(script[i] || '')) i++;
    if (i >= script.length) break;
    let addr = null;
    if (/\d/.test(script[i])) { let n = ''; while (/\d/.test(script[i])) n += script[i++]; addr = { line: +n }; }
    else if (script[i] === '$') { addr = { last: true }; i++; }
    else if (script[i] === '/') { i++; addr = { re: new RegExp(toJs(readRe('/'))) }; }
    const c = script[i++];
    if (c === 's') {
      const delim = script[i++];
      const pat = readRe(delim), rep = readRe(delim);
      let flags = '';
      while (/[gIip\d]/.test(script[i] || '')) flags += script[i++];
      const jsRep = rep.replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$$$1').replace(/(^|[^\\])&/g, '$1$$&').replace(/\\&/g, '&').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      cmds.push({ addr, c: 's', re: new RegExp(toJs(pat), (flags.includes('g') ? 'g' : '') + (/[iI]/.test(flags) ? 'i' : '')), rep: jsRep, print: flags.includes('p') });
    } else if (c === 'd' || c === 'p' || c === 'q') cmds.push({ addr, c });
    else if (c === 'y') {
      const delim = script[i++]; const a = readRe(delim), b = readRe(delim);
      if (a.length !== b.length) throw new UsageError('strings for `y\' command are different lengths');
      cmds.push({ addr, c: 'y', a, b });
    } else throw new UsageError(`unknown command: \`${c ?? ''}'`);
  }
  return cmds;
}
function runSed(cmds, text, quiet) {
  const lines = linesOf(text), out = [];
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n], deleted = false, quit = false;
    for (const c of cmds) {
      const a = c.addr;
      if (a && !(a.line ? a.line === n + 1 : a.last ? n === lines.length - 1 : a.re.test(line))) continue;
      if (c.c === 's') { const before = line; line = line.replace(c.re, c.rep); if (c.print && before !== line) out.push(line); }
      else if (c.c === 'd') { deleted = true; break; }
      else if (c.c === 'p') out.push(line);
      else if (c.c === 'y') line = [...line].map(ch => { const k = c.a.indexOf(ch); return k >= 0 ? c.b[k] : ch; }).join('');
      else if (c.c === 'q') { quit = true; break; }
    }
    if (!deleted && !quiet) out.push(line);
    if (quit) break;
  }
  return joinLines(out);
}
def('sed', 'Text processing', "sed [-n] [-i] [-E] 's/find/replace/g' [file…]", 'Stream editor (s, d, p, y commands)', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'niErs', values: 'e' });
  const script = o.e ?? rest.shift();
  if (script == null) throw new UsageError('usage: sed [-n] [-i] script [file…]', 1);
  const cmds = parseSed(script, o.E || o.r);
  if (o.i) {
    if (!rest.length) throw new UsageError('no input files');
    for (const f of await inputs(ctx, rest)) await ctx.fs.writeText(f.path, runSed(cmds, f.text, o.n), { source: 'terminal' });
    return ctx.failed ? 1 : 0;
  }
  for (const f of await inputs(ctx, rest)) ctx.out(runSed(cmds, f.text, o.n));
  return ctx.failed ? 1 : 0;
});

function expandTrSet(set) {
  const classes = { '[:upper:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[:lower:]': 'abcdefghijklmnopqrstuvwxyz', '[:digit:]': '0123456789', '[:space:]': ' \t\n\r\f\v', '[:blank:]': ' \t', '[:punct:]': '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' };
  classes['[:alpha:]'] = classes['[:upper:]'] + classes['[:lower:]'];
  classes['[:alnum:]'] = classes['[:alpha:]'] + classes['[:digit:]'];
  let s = unescape(set).text;
  for (const [k, v] of Object.entries(classes)) s = s.split(k).join(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i + 1] === '-' && i + 2 < s.length) { for (let c = s.charCodeAt(i); c <= s.charCodeAt(i + 2); c++) out += String.fromCharCode(c); i += 2; }
    else out += s[i];
  }
  return out;
}
def('tr', 'Text processing', 'tr [-ds] set1 [set2]', 'Translate or delete characters', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'dsc' });
  if (!rest.length) throw new UsageError('missing operand');
  const a = expandTrSet(rest[0]), b = rest[1] != null ? expandTrSet(rest[1]) : '';
  let text = ctx.stdin;
  if (o.d) text = [...text].filter(c => !a.includes(c)).join('');
  else if (b) text = [...text].map(c => { const k = a.indexOf(c); return k < 0 ? c : b[Math.min(k, b.length - 1)]; }).join('');
  if (o.s) { const sq = b && !o.d ? b : a; text = text.replace(/(.)\1+/gs, (m, c) => (sq.includes(c) ? c : m)); }
  ctx.out(text);
});

def('tee', 'Text processing', 'tee [-a] file…', 'Copy input to files and the terminal', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'a' });
  for (const f of rest) {
    const p = ctx.resolve(f);
    const prev = o.a && ctx.fs.isFile(p) ? await ctx.fs.readText(p) : '';
    await ctx.fs.writeText(p, prev + stripAnsi(ctx.stdin), { source: 'terminal' });
  }
  ctx.out(ctx.stdin);
});

def('rev', 'Text processing', 'rev [file…]', 'Reverse each line', async ctx => {
  for (const f of await inputs(ctx, ctx.args)) ctx.out(joinLines(linesOf(f.text).map(l => [...l].reverse().join(''))));
});

// Myers-style line diff via LCS on the region that differs (common prefix/suffix trimmed first).
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const A = a.slice(start, endA), B = b.slice(start, endB);
  if (A.length * B.length > 4_000_000) throw new UsageError('files are too different to compare in the browser');
  const n = A.length, m = B.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * (m + 1) + j] = A[i] === B[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  }
  const ops = a.slice(0, start).map(l => ({ t: ' ', l }));
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push({ t: ' ', l: A[i] }); i++; j++; }
    // Deletions before insertions within a change, like diff(1).
    else if (i < n && (j >= m || dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1])) ops.push({ t: '-', l: A[i++] });
    else ops.push({ t: '+', l: B[j++] });
  }
  for (let k = endA; k < a.length; k++) ops.push({ t: ' ', l: a[k] });
  return ops;
}
export function unifiedDiff(nameA, nameB, textA, textB, { context = 3, color = false } = {}) {
  const ops = diffLines(linesOf(textA), linesOf(textB));
  if (!ops.some(o => o.t !== ' ')) return '';
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const out = [c('1', `--- ${nameA}`), c('1', `+++ ${nameB}`)];
  let ai = 0, bi = 0, k = 0;
  const pos = [];
  for (const o of ops) { pos.push({ ai, bi }); if (o.t !== '+') ai++; if (o.t !== '-') bi++; }
  while (k < ops.length) {
    while (k < ops.length && ops[k].t === ' ') k++;
    if (k >= ops.length) break;
    let s = Math.max(0, k - context), e = k;
    for (;;) {
      while (e < ops.length && ops[e].t !== ' ') e++;
      let next = e;
      while (next < ops.length && ops[next].t === ' ') next++;
      if (next < ops.length && next - e <= context * 2) { e = next; continue; }
      e = Math.min(ops.length, e + context);
      break;
    }
    const hunk = ops.slice(s, e);
    const aLen = hunk.filter(o => o.t !== '+').length, bLen = hunk.filter(o => o.t !== '-').length;
    out.push(c('36', `@@ -${pos[s].ai + (aLen ? 1 : 0)},${aLen} +${pos[s].bi + (bLen ? 1 : 0)},${bLen} @@`));
    for (const o of hunk) out.push(o.t === '-' ? c('31', `-${o.l}`) : o.t === '+' ? c('32', `+${o.l}`) : ` ${o.l}`);
    k = e;
  }
  return out.join('\n') + '\n';
}
def('diff', 'Text processing', 'diff [-uq] file1 file2', 'Compare two files line by line', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'uqNrs', values: 'U' });
  if (rest.length !== 2) throw new UsageError(`missing operand after '${rest[0] ?? 'diff'}'`, 2);
  const [fa, fb] = await inputs(ctx, rest);
  if (!fa || !fb) return 2;
  if (fa.text === fb.text) { if (o.s) ctx.println(`Files ${rest[0]} and ${rest[1]} are identical`); return 0; }
  if (o.q) { ctx.println(`Files ${rest[0]} and ${rest[1]} differ`); return 1; }
  ctx.out(unifiedDiff(rest[0], rest[1], fa.text, fb.text, { context: o.U ? parseInt(o.U, 10) : 3, color: ctx.isTTY }));
  return 1;
});

def('base64', 'Text processing', 'base64 [-d] [file]', 'Encode or decode Base64', async ctx => {
  const { o, rest } = getopts(ctx.args, { flags: 'dDiw', values: 'w' });
  if (o.d || o.D) {
    const bin = atob(ctx.stdin && !rest.length ? ctx.stdin.replace(/\s+/g, '') : (await inputs(ctx, rest))[0]?.text.replace(/\s+/g, '') ?? '');
    ctx.out(new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0))));
    return;
  }
  let bytes;
  if (rest.length) { const p = ctx.resolve(rest[0]); if (!ctx.fs.isFile(p)) throw new UsageError(`${rest[0]}: No such file or directory`); bytes = new Uint8Array(await (await ctx.fs.readBlob(p)).arrayBuffer()); }
  else bytes = new TextEncoder().encode(ctx.stdin);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  ctx.println(btoa(bin).replace(/.{76}(?=.)/g, '$&\n'));
});

async function hashCmd(ctx, algo) {
  const files = ctx.args.filter(a => !a.startsWith('-'));
  const list = files.length ? files.map(f => ({ name: f, path: ctx.resolve(f) })) : [{ name: '-', text: ctx.stdin }];
  let status = 0;
  for (const f of list) {
    let data;
    if (f.path != null) {
      if (!ctx.fs.isFile(f.path)) { ctx.err(`${ctx.name}: ${f.name}: No such file or directory\n`); status = 1; continue; }
      data = await (await ctx.fs.readBlob(f.path)).arrayBuffer();
    } else data = new TextEncoder().encode(f.text);
    if (!crypto.subtle) throw new UsageError('hashing needs a secure context (https)');
    const hex = [...new Uint8Array(await crypto.subtle.digest(algo, data))].map(b => b.toString(16).padStart(2, '0')).join('');
    ctx.println(`${hex}  ${f.name}`);
  }
  return status;
}
def('sha256sum', 'Text processing', 'sha256sum [file…]', 'Print SHA-256 checksums', ctx => hashCmd(ctx, 'SHA-256'));
def('sha1sum', 'Text processing', 'sha1sum [file…]', 'Print SHA-1 checksums', ctx => hashCmd(ctx, 'SHA-1'));

// ---------------------------------------------------------------- shell

def('help', 'Shell', 'help [command]', 'Show the available commands', async ctx => {
  const shell = ctx.shell;
  if (ctx.args[0]) {
    const cmd = shell.lookup(ctx.args[0]);
    if (!cmd) {
      if (shell.aliases.has(ctx.args[0])) { ctx.println(`${ctx.args[0]} is an alias for '${shell.aliases.get(ctx.args[0])}'`); return 0; }
      throw new UsageError(`no help topics match '${ctx.args[0]}'`);
    }
    ctx.println(`${sgr.bold(cmd.usage || cmd.name)}\n  ${cmd.summary || ''}`);
    return 0;
  }
  const b = s => (ctx.isTTY ? sgr.bold(s) : s);
  ctx.println(`${b('xsh')} — the X Coder shell. It runs in your browser against this project's files;`);
  ctx.println(`'~' and '/' are the project root. Pipes (|), redirects (> >> <), && || ;, globs (*, **) and $VARS work.`);
  const all = new Map();
  for (const name of shell.commandNames()) {
    const cmd = shell.lookup(name);
    if (!cmd || cmd.hidden || name.startsWith('__')) continue;
    const cat = cmd.category || 'Extensions';
    if (!all.has(cat)) all.set(cat, []);
    all.get(cat).push(cmd);
  }
  const width = Math.min(12, Math.max(...[...all.values()].flat().map(c => c.name.length)) + 2);
  for (const cat of [...CATEGORIES, ...[...all.keys()].filter(k => !CATEGORIES.includes(k))]) {
    const list = all.get(cat);
    if (!list?.length) continue;
    ctx.println(`\n${ctx.isTTY ? sgr.boldCyan(cat) : cat}`);
    for (const c of list.sort((x, y) => x.name.localeCompare(y.name))) ctx.println(`  ${ctx.isTTY ? sgr.green(c.name.padEnd(width)) : c.name.padEnd(width)}${c.summary || ''}`);
  }
  ctx.println(`\nType 'help <command>' or '<command> --help' for usage. Keys: Tab completes, ↑/↓ history, Ctrl+C cancels, Ctrl+L clears, Ctrl+R searches history.`);
}, { aliases: ['man'] });

def('clear', 'Shell', 'clear', 'Clear the terminal', async ctx => { ctx.shell.host.clear?.(); }, { aliases: ['reset'] });
def('exit', 'Shell', 'exit [code]', 'Close this terminal', async ctx => {
  const code = parseInt(ctx.args[0] ?? '0', 10) || 0;
  ctx.shell.exitRequested = true;
  ctx.shell.host.exit?.(code);
  return code;
}, { aliases: ['logout'] });

def('history', 'Shell', 'history [-c] [n]', 'Show command history', async ctx => {
  if (ctx.args[0] === '-c') { ctx.shell.host.clearHistory?.(); return 0; }
  const list = ctx.shell.host.history?.() || [];
  const n = parseInt(ctx.args[0], 10);
  const start = Number.isFinite(n) ? Math.max(0, list.length - n) : 0;
  ctx.out(list.slice(start).map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`).join('\n') + (list.length ? '\n' : ''));
});

def('env', 'Shell', 'env', 'Print environment variables', async ctx => {
  if (ctx.args.length) {
    const assigns = [], rest = [...ctx.args];
    while (rest.length && /^[A-Za-z_]\w*=/.test(rest[0])) assigns.push(rest.shift());
    if (rest.length) {
      const saved = new Map();
      for (const a of assigns) { const [k, v] = a.split(/=(.*)/s); saved.set(k, ctx.shell.vars.get(k)); ctx.shell.vars.set(k, v); }
      try { return await ctx.exec(rest); } finally { for (const [k, v] of saved) v == null ? ctx.shell.vars.delete(k) : ctx.shell.vars.set(k, v); }
    }
  }
  for (const [k, v] of ctx.shell.env()) ctx.println(`${k}=${v}`);
});
BUILTINS.set('printenv', { ...BUILTINS.get('env'), name: 'printenv', usage: 'printenv [NAME…]', summary: 'Print environment variables', hidden: true, run: async ctx => {
  if (!ctx.args.length) { for (const [k, v] of ctx.shell.env()) ctx.println(`${k}=${v}`); return 0; }
  let status = 0;
  for (const k of ctx.args) { const v = ctx.shell.env().get(k); if (v == null) status = 1; else ctx.println(v); }
  return status;
} });

def('export', 'Shell', 'export [NAME[=value]…]', 'Set environment variables', async ctx => {
  if (!ctx.args.length || ctx.args[0] === '-p') {
    for (const [k, v] of ctx.shell.env()) ctx.println(`export ${k}="${v.replace(/(["\\$`])/g, '\\$1')}"`);
    return;
  }
  for (const a of ctx.args) {
    const [k, v] = a.split(/=(.*)/s);
    if (!/^[A-Za-z_]\w*$/.test(k)) { ctx.err(`export: \`${a}': not a valid identifier\n`); ctx.failed = true; continue; }
    if (v !== undefined) ctx.shell.vars.set(k, v);
    ctx.shell.exported.add(k);
  }
  return ctx.failed ? 1 : 0;
});
def('unset', 'Shell', 'unset NAME…', 'Remove variables', async ctx => {
  for (const k of ctx.args.filter(a => !a.startsWith('-'))) { ctx.shell.vars.delete(k); ctx.shell.exported.delete(k); }
});

const quoteAlias = v => `'${v.replace(/'/g, `'\\''`)}'`;
def('alias', 'Shell', "alias [name[='value']…]", 'Define or list aliases', async ctx => {
  const aliases = ctx.shell.aliases;
  if (!ctx.args.length) { for (const [k, v] of [...aliases].sort()) ctx.println(`alias ${k}=${quoteAlias(v)}`); return 0; }
  let status = 0;
  for (const a of ctx.args) {
    const eq = a.indexOf('=');
    if (eq < 0) { if (aliases.has(a)) ctx.println(`alias ${a}=${quoteAlias(aliases.get(a))}`); else { ctx.err(`alias: ${a}: not found\n`); status = 1; } continue; }
    aliases.set(a.slice(0, eq), a.slice(eq + 1));
  }
  ctx.shell.host.saveAliases?.();
  return status;
});
def('unalias', 'Shell', 'unalias [-a] name…', 'Remove aliases', async ctx => {
  if (ctx.args[0] === '-a') ctx.shell.aliases.clear();
  else for (const a of ctx.args) { if (!ctx.shell.aliases.delete(a)) { ctx.err(`unalias: ${a}: not found\n`); ctx.failed = true; } }
  ctx.shell.host.saveAliases?.();
  return ctx.failed ? 1 : 0;
});

function describe(shell, name) {
  if (shell.aliases.has(name)) return { kind: 'alias', text: shell.aliases.get(name) };
  const cmd = shell.lookup(name);
  if (!cmd) return null;
  return { kind: cmd.external ? 'extension' : 'builtin', cmd };
}
def('which', 'Shell', 'which command…', 'Locate a command', async ctx => {
  let status = 0;
  for (const n of ctx.args.filter(a => !a.startsWith('-'))) {
    const d = describe(ctx.shell, n);
    if (!d) { ctx.err(`${n} not found\n`); status = 1; }
    else if (d.kind === 'alias') ctx.println(`${n}: aliased to ${d.text}`);
    else ctx.println(d.kind === 'extension' ? `${n}: command contributed by an X Coder extension` : `${n}: shell built-in command`);
  }
  return status;
});
def('type', 'Shell', 'type command…', 'Describe how a command is interpreted', async ctx => {
  let status = 0;
  for (const n of ctx.args.filter(a => !a.startsWith('-'))) {
    const d = describe(ctx.shell, n);
    if (!d) { ctx.err(`type: ${n}: not found\n`); status = 1; }
    else if (d.kind === 'alias') ctx.println(`${n} is aliased to \`${d.text}'`);
    else ctx.println(`${n} is a shell ${d.kind === 'extension' ? 'function (X Coder extension)' : 'builtin'}`);
  }
  return status;
});
def('command', 'Shell', 'command [-v] name [args…]', 'Run a command, bypassing aliases', async ctx => {
  if (ctx.args[0] === '-v' || ctx.args[0] === '-V') {
    const n = ctx.args[1];
    const d = n && describe(ctx.shell, n);
    if (!d) return 1;
    ctx.println(d.kind === 'alias' ? `alias ${n}=${quoteAlias(d.text)}` : n);
    return 0;
  }
  return ctx.exec(ctx.args);
});

def('sleep', 'Shell', 'sleep seconds', 'Wait for a number of seconds', async ctx => {
  const s = parseFloat(ctx.args[0]);
  if (!Number.isFinite(s) || s < 0) throw new UsageError(`invalid time interval '${ctx.args[0] ?? ''}'`);
  await sleep(s * 1000, ctx.signal);
});
def('true', 'Shell', 'true', 'Do nothing, successfully', async () => 0, { aliases: [':'] });
def('false', 'Shell', 'false', 'Do nothing, unsuccessfully', async () => 1);

def('seq', 'Shell', 'seq [-s sep] [first [step]] last', 'Print a sequence of numbers', async ctx => {
  const { o, rest } = getopts(ctx.args.map(a => (/^-\d/.test(a) ? `\u0000${a}` : a)), { flags: 'w', values: 's' });
  const nums = rest.map(a => parseFloat(a.replace('\u0000', '')));
  if (!nums.length || nums.some(Number.isNaN)) throw new UsageError('usage: seq [first [step]] last');
  const [first, step, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
  if (!step) throw new UsageError('step must not be zero');
  const out = [];
  for (let v = first; step > 0 ? v <= last : v >= last; v += step) { out.push(String(+v.toFixed(10))); if (out.length > 100000) break; }
  const w = o.w ? Math.max(...out.map(s => s.length)) : 0;
  ctx.out(out.map(s => s.padStart(w, '0')).join(o.s ? unescape(o.s).text : '\n') + (out.length ? '\n' : ''));
});

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatDate(d, fmt, utc = false) {
  const g = k => (utc ? d[`getUTC${k}`]() : d[`get${k}`]());
  const p2 = n => String(n).padStart(2, '0');
  const tz = utc ? 'UTC' : (new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName')?.value || '');
  const map = {
    Y: () => g('FullYear'), y: () => p2(g('FullYear') % 100), m: () => p2(g('Month') + 1), d: () => p2(g('Date')), e: () => String(g('Date')).padStart(2),
    H: () => p2(g('Hours')), I: () => p2(g('Hours') % 12 || 12), M: () => p2(g('Minutes')), S: () => p2(g('Seconds')), p: () => (g('Hours') < 12 ? 'AM' : 'PM'),
    N: () => String(g('Milliseconds')).padStart(3, '0') + '000000', s: () => String(Math.floor(d.getTime() / 1000)),
    A: () => DAYS[g('Day')], a: () => DAYS[g('Day')].slice(0, 3), B: () => MONTHS_LONG[g('Month')], b: () => MONTHS_LONG[g('Month')].slice(0, 3), h: () => MONTHS_LONG[g('Month')].slice(0, 3),
    j: () => String(Math.floor((Date.UTC(g('FullYear'), g('Month'), g('Date')) - Date.UTC(g('FullYear'), 0, 0)) / 864e5)).padStart(3, '0'),
    Z: () => tz, z: () => { const off = utc ? 0 : -d.getTimezoneOffset(); return `${off >= 0 ? '+' : '-'}${p2(Math.floor(Math.abs(off) / 60))}${p2(Math.abs(off) % 60)}`; },
    T: () => `${map.H()}:${map.M()}:${map.S()}`, F: () => `${map.Y()}-${map.m()}-${map.d()}`, D: () => `${map.m()}/${map.d()}/${map.y()}`,
    R: () => `${map.H()}:${map.M()}`, n: () => '\n', t: () => '\t', '%': () => '%', u: () => String(g('Day') || 7), w: () => String(g('Day'))
  };
  return fmt.replace(/%([A-Za-z%])/g, (m, k) => (map[k] ? map[k]() : m));
}
def('date', 'Shell', 'date [-u] [+format]', 'Print the date and time', async ctx => {
  const utc = ctx.args.includes('-u');
  const fmt = ctx.args.find(a => a.startsWith('+'));
  ctx.println(formatDate(new Date(), fmt ? fmt.slice(1) : '%a %b %e %H:%M:%S %Z %Y', utc));
});
def('whoami', 'Shell', 'whoami', 'Print the user name', async ctx => { ctx.println(ctx.shell.vars.get('USER') || 'user'); });
def('hostname', 'Shell', 'hostname', 'Print the host name', async ctx => { ctx.println(ctx.shell.vars.get('HOSTNAME') || 'xcoder'); });
def('uname', 'Shell', 'uname [-a]', 'Print system information', async ctx => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  ctx.println(ctx.args.includes('-a') ? `XCoder ${ctx.shell.vars.get('HOSTNAME') || 'xcoder'} 6.0.0 xsh ${os} browser` : 'XCoder');
});

def('test', 'Shell', 'test expression | [ expression ]', 'Evaluate a condition (-f -d -e -z -n = != -eq -lt …)', async ctx => {
  let a = [...ctx.args];
  if (ctx.name === '[') { if (a[a.length - 1] !== ']') throw new UsageError("missing `]'", 2); a.pop(); }
  const fs = ctx.fs;
  const unary = (op, v) => {
    const p = ctx.resolve(v);
    switch (op) {
      case '-e': return ctx.shell.exists(p);
      case '-f': return fs.isFile(p);
      case '-d': return ctx.shell.isDir(p);
      case '-s': return fs.isFile(p) && fs.size(p) > 0;
      case '-r': case '-w': return ctx.shell.exists(p);
      case '-x': return false;
      case '-z': return v.length === 0;
      case '-n': return v.length > 0;
    }
    throw new UsageError(`${op}: unary operator expected`, 2);
  };
  const binary = (l, op, r) => {
    switch (op) {
      case '=': case '==': return l === r;
      case '!=': return l !== r;
      case '-eq': return +l === +r; case '-ne': return +l !== +r;
      case '-lt': return +l < +r; case '-le': return +l <= +r;
      case '-gt': return +l > +r; case '-ge': return +l >= +r;
    }
    throw new UsageError(`${op}: binary operator expected`, 2);
  };
  const evalExpr = x => {
    if (x[0] === '!') return !evalExpr(x.slice(1));
    const and = x.indexOf('-a'), or = x.indexOf('-o');
    if (or > 0) return evalExpr(x.slice(0, or)) || evalExpr(x.slice(or + 1));
    if (and > 0) return evalExpr(x.slice(0, and)) && evalExpr(x.slice(and + 1));
    if (x.length === 0) return false;
    if (x.length === 1) return x[0].length > 0;
    if (x.length === 2) return unary(x[0], x[1]);
    if (x.length === 3) return binary(x[0], x[1], x[2]);
    throw new UsageError('too many arguments', 2);
  };
  return evalExpr(a) ? 0 : 1;
}, { aliases: ['['] });

def('xargs', 'Shell', 'xargs [-n N] [-I str] [command [args…]]', 'Build command lines from input', async ctx => {
  const args = [...ctx.args];
  let n = Infinity, repl = null;
  while (args[0]?.startsWith('-')) {
    const f = args.shift();
    if (f === '-n') n = Math.max(1, parseInt(args.shift(), 10) || 1);
    else if (f === '-I') repl = args.shift();
    else if (f === '-0' || f === '-r' || f === '--no-run-if-empty') continue;
    else throw new UsageError(`invalid option -- '${f}'`);
  }
  const cmd = args.length ? args : ['echo'];
  let status = 0;
  if (repl != null) {
    for (const line of linesOf(ctx.stdin).filter(Boolean)) status = (await ctx.exec(cmd.map(a => a.split(repl).join(line)), { stdin: '' })) || status;
    return status;
  }
  const items = ctx.stdin.match(/"[^"]*"|'[^']*'|\S+/g)?.map(s => s.replace(/^["']|["']$/g, '')) || [];
  if (!items.length) return 0;
  for (let i = 0; i < items.length; i += n === Infinity ? items.length : n) {
    status = (await ctx.exec([...cmd, ...items.slice(i, i + (n === Infinity ? items.length : n))], { stdin: '' })) || status;
  }
  return status;
});

// Scripts: `sh file.sh`, `source file`, `./file.sh`
async function runScript(ctx, file, args, { subshell }) {
  const p = ctx.resolve(file);
  if (!ctx.fs.isFile(p)) throw new UsageError(`${file}: No such file or directory`, 127);
  const text = await ctx.fs.readText(p);
  const shell = ctx.shell;
  const saved = { cwd: shell.cwd, oldCwd: shell.oldCwd, vars: new Map(shell.vars), positional: shell.positional };
  shell.positional = args;
  let status = 0;
  try {
    const lines = text.replace(/\\\n/g, '').split('\n');
    for (const line of lines) {
      if (ctx.signal?.aborted) return 130;
      if (!line.trim() || line.trim().startsWith('#')) continue;
      status = await shell.run(line, { ...ctx.io, stdin: '' });
      if (shell.exitRequested) break;
    }
  } finally {
    shell.positional = saved.positional;
    if (subshell) { shell.cwd = saved.cwd; shell.oldCwd = saved.oldCwd; shell.vars = saved.vars; }
  }
  return status;
}
def('sh', 'Shell', 'sh script.sh [args…]', 'Run a shell script with xsh', async ctx => {
  if (!ctx.args.length) throw new UsageError('interactive sub-shells are not supported; pass a script file');
  if (ctx.args[0] === '-c') return ctx.shell.run(ctx.args.slice(1).join(' '), { ...ctx.io, stdin: ctx.stdin });
  return runScript(ctx, ctx.args[0], ctx.args.slice(1), { subshell: true });
}, { aliases: ['bash', 'zsh', 'xsh'] });
def('source', 'Shell', 'source file [args…]', 'Run a script in the current shell', async ctx => {
  if (!ctx.args.length) throw new UsageError('filename argument required', 2);
  return runScript(ctx, ctx.args[0], ctx.args.slice(1), { subshell: false });
}, { aliases: ['.'] });

// "./script.sh", "./app.js", "./main.py": run by extension.
BUILTINS.set('__exec_path', {
  name: '__exec_path', hidden: true, category: 'Shell',
  async run(ctx) {
    const file = ctx.name;
    const p = ctx.resolve(file);
    if (!ctx.shell.exists(p)) throw new UsageError('No such file or directory', 127);
    if (ctx.shell.isDir(p)) throw new UsageError('is a directory', 126);
    const ext = posix.ext(p);
    if (ext === '.sh' || ext === '.bash' || ext === '.zsh' || ext === '') return runScript(ctx, file, ctx.args, { subshell: true });
    if (['.js', '.mjs', '.cjs'].includes(ext)) return ctx.exec(['node', file, ...ctx.args]);
    if (ext === '.py') return ctx.exec(['python3', file, ...ctx.args]);
    throw new UsageError('permission denied (only .sh, .js and .py files can be executed)', 126);
  }
});
