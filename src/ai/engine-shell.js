// Built-in, read-only shell for the agent's <run_command/> tool. X Coder has no real shell in the browser,
// so common inspection commands are implemented over the project file system (no side effects):
//   pwd, ls [-a -l -R] [paths], cat, head/tail [-n N], wc [-l -w -c], grep [-r -n -i -l -c -w -E -F -v --include=glob],
//   find [path] [-name/-iname glob] [-type f|d] [-maxdepth N], tree [-L N] [path], echo, sort, uniq
// Commands can be chained with && / ; and piped with | (grep/head/tail/wc/sort/uniq read stdin).
// `node file.js` / `python file.py` are reported back to the caller as { runScript } so it can run them.
//
//   runShell(commandLine, { fs, isDenied }) → { ok, output, runScript?: { path, args } }

import { globToRegExp } from './engine-match.js';

const MAX_OUTPUT = 12000;
const SIDE_EFFECT = /^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee|sed|awk|dd|truncate)$/;
const UNAVAILABLE = {
  npm: 'npm is not available: X Coder runs in the browser, so packages cannot be installed. Bare imports in the preview are loaded from esm.sh automatically.',
  npx: 'npx is not available in the browser. Build tools cannot run; the preview transpiles TS/JSX on the fly.',
  yarn: 'yarn is not available in the browser (no package installation).', pnpm: 'pnpm is not available in the browser (no package installation).',
  pip: 'pip is not available here. Pyodide can load pure-Python packages at runtime with micropip inside your program.',
  git: 'The git CLI is not available. Use the git_diff tool, or the Source Control view for commit/push/pull.',
  curl: 'curl is not available. Use the fetch_url tool instead.', wget: 'wget is not available. Use the fetch_url tool instead.',
  cd: 'cd is not needed: every path is relative to the project root.'
};

function tokenize(line) {
  const out = []; let cur = '', q = null, has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < line.length) cur += line[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    if (c === '|' || c === ';' || c === '&') {
      if (cur || has) out.push(cur); cur = ''; has = false;
      if (c === '&' && line[i + 1] === '&') { out.push({ op: '&&' }); i++; }
      else if (c === '|' && line[i + 1] === '|') { out.push({ op: '||' }); i++; }
      else if (c === '&') out.push({ op: '&' });
      else out.push({ op: c });
      continue;
    }
    if (c === '>' || c === '<') { if (cur || has) out.push(cur); cur = ''; has = false; out.push({ op: c }); continue; }
    cur += c;
  }
  if (q) throw new Error('unterminated quote');
  if (cur || has) out.push(cur);
  return out;
}

const clean = p => String(p || '').replace(/^\.\/?/, '').replace(/^\/+/, '').replace(/\/+$/, '');

function flags(args, known = '') {
  const f = new Set(), rest = [], opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }
    if (/^--[\w-]+=/.test(a)) { const [k, v] = a.slice(2).split(/=(.*)/s); opts[k] = v; continue; }
    if (/^--[\w-]+$/.test(a)) { f.add(a.slice(2)); continue; }
    if (/^-\d+$/.test(a)) { opts.n = a.slice(1); continue; }
    const attached = /^-([A-Za-z])(\d+)$/.exec(a);
    if (attached && known.includes(attached[1] + ':')) { opts[attached[1]] = attached[2]; continue; }
    if (/^-[A-Za-z]+$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (known.includes(ch + ':')) opts[ch] = args[++i];
        else f.add(ch);
      }
      continue;
    }
    rest.push(a);
  }
  return { f, rest, opts };
}

export function runShell(commandLine, { fs, isDenied = () => false } = {}) {
  let tokens;
  try { tokens = tokenize(String(commandLine || '').trim()); }
  catch (err) { return { ok: false, output: `sh: ${err.message}` }; }
  if (!tokens.length) return { ok: false, output: 'No command given.' };
  // split into pipelines separated by && ; ||
  const chains = []; let pipeline = [[]], sep = null;
  for (const t of tokens) {
    if (typeof t === 'object') {
      if (t.op === '|') { pipeline.push([]); continue; }
      if (t.op === '>' || t.op === '<') return { ok: false, output: 'Redirection is not supported: the built-in shell is read-only. Use write_file to create files.' };
      if (t.op === '&') continue;
      chains.push({ pipeline, sep }); pipeline = [[]]; sep = t.op; continue;
    }
    pipeline[pipeline.length - 1].push(t);
  }
  chains.push({ pipeline, sep });
  const outputs = [];
  let lastOk = true;
  for (const { pipeline: pl, sep: s } of chains) {
    if (s === '&&' && !lastOk) continue;
    if (s === '||' && lastOk) continue;
    let stdin = null, ok = true;
    for (const argv of pl.filter(a => a.length)) {
      const [cmd, ...args] = argv;
      if (/^(node|python3?|deno|bun)$/.test(cmd)) {
        if (!args[0]) return { ok: false, output: `${cmd}: an interactive REPL is not available. Pass a file, e.g. \`${cmd} main.${cmd.startsWith('python') ? 'py' : 'js'}\`.` };
        return { ok: true, output: outputs.join('\n'), runScript: { path: clean(args[0]), args: args.slice(1) } };
      }
      const r = runOne(cmd, args, stdin, fs, isDenied);
      ok = r.ok; stdin = r.output;
      if (!ok) break;
    }
    lastOk = ok;
    if (stdin != null && stdin !== '') outputs.push(stdin);
  }
  let output = outputs.join('\n');
  if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + `\n… (output truncated, ${output.length - MAX_OUTPUT} more characters)`;
  return { ok: lastOk, output: output || '(no output)' };
}

function readable(fs, isDenied, p) {
  const path = clean(p);
  if (isDenied(path)) throw new Error(`${p}: access to this path is blocked`);
  return path;
}
function textOf(fs, isDenied, p) {
  const path = readable(fs, isDenied, p);
  if (!path || fs.isFolder(path)) throw new Error(`${p}: Is a directory`);
  if (!fs.exists(path)) throw new Error(`${p}: No such file or directory`);
  const t = fs.peekText(path);
  if (t == null) throw new Error(`${p}: binary file (${fs.size(path)} bytes)`);
  return t;
}
const splitLines = t => { const l = t.replace(/\r\n?/g, '\n').split('\n'); if (l.length && l[l.length - 1] === '') l.pop(); return l; };

function children(fs, dir) { return fs.list(dir); }

function runOne(cmd, args, stdin, fs, isDenied) {
  try {
    if (SIDE_EFFECT.test(cmd)) return { ok: false, output: `${cmd}: not available — the built-in shell is read-only. Use write_file, edit_file, delete_file or rename_file to change files.` };
    if (UNAVAILABLE[cmd]) return { ok: false, output: UNAVAILABLE[cmd] };
    switch (cmd) {
      case 'pwd': return { ok: true, output: '/ (project root)' };
      case 'echo': return { ok: true, output: args.filter(a => a !== '-n' && a !== '-e').join(' ') };
      case 'ls': case 'dir': {
        const { f, rest } = flags(args);
        const targets = rest.length ? rest : [''];
        const out = [];
        for (const t of targets) {
          const path = readable(fs, isDenied, t);
          if (path && !fs.exists(path)) { out.push(`ls: ${t}: No such file or directory`); continue; }
          if (path && fs.isFile(path)) { out.push(f.has('l') ? `${String(fs.size(path)).padStart(8)}  ${path}` : path); continue; }
          const walk = (dir, prefix) => {
            const kids = children(fs, dir).filter(r => (f.has('a') || !r.path.split('/').pop().startsWith('.')) && !isDenied(r.path));
            if (targets.length > 1 || f.has('R')) out.push(`${dir || '.'}:`);
            for (const r of kids) {
              const name = r.path.split('/').pop() + (r.type === 'folder' ? '/' : '');
              out.push(f.has('l') ? `${r.type === 'folder' ? 'd' : '-'} ${String(r.type === 'folder' ? '-' : fs.size(r.path)).padStart(8)}  ${name}` : name);
            }
            if (f.has('R')) for (const r of kids.filter(k => k.type === 'folder')) { out.push(''); walk(r.path, prefix); }
          };
          walk(path, '');
        }
        return { ok: true, output: out.join('\n') };
      }
      case 'cat': {
        if (!args.length) return { ok: true, output: stdin ?? '' };
        const { f, rest } = flags(args);
        return { ok: true, output: rest.map(p => { const t = textOf(fs, isDenied, p); return f.has('n') ? splitLines(t).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') : t; }).join('\n') };
      }
      case 'head': case 'tail': {
        const { rest, opts } = flags(args, 'n:c:');
        const n = Math.max(0, parseInt(opts.n ?? '10', 10) || 10);
        const pick = t => { const l = splitLines(t); return (cmd === 'head' ? l.slice(0, n) : l.slice(-n)).join('\n'); };
        if (!rest.length) return { ok: true, output: pick(stdin ?? '') };
        return { ok: true, output: rest.map(p => (rest.length > 1 ? `==> ${p} <==\n` : '') + pick(textOf(fs, isDenied, p))).join('\n') };
      }
      case 'wc': {
        const { f, rest } = flags(args);
        const stat = t => ({ l: splitLines(t).length, w: (t.match(/\S+/g) || []).length, c: new Blob([t]).size });
        const fmt = (s, name) => {
          const cols = f.size ? ['l', 'w', 'c'].filter(k => f.has(k)) : ['l', 'w', 'c'];
          return cols.map(k => String(s[k]).padStart(7)).join('') + (name ? ` ${name}` : '');
        };
        if (!rest.length) return { ok: true, output: fmt(stat(stdin ?? '')) };
        return { ok: true, output: rest.map(p => fmt(stat(textOf(fs, isDenied, p)), p)).join('\n') };
      }
      case 'sort': {
        const { f } = flags(args);
        let l = splitLines(stdin ?? '');
        l.sort(f.has('n') ? (a, b) => parseFloat(a) - parseFloat(b) : undefined);
        if (f.has('r')) l.reverse();
        if (f.has('u')) l = [...new Set(l)];
        return { ok: true, output: l.join('\n') };
      }
      case 'uniq': {
        const l = splitLines(stdin ?? '');
        return { ok: true, output: l.filter((x, i) => i === 0 || x !== l[i - 1]).join('\n') };
      }
      case 'grep': case 'rg': case 'egrep': {
        const { f, rest, opts } = flags(args, 'e:m:');
        let pattern = opts.e ?? rest.shift();
        if (pattern == null) return { ok: false, output: 'grep: missing pattern' };
        const fixed = f.has('F');
        let src = fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
        if (!fixed && !f.has('E') && cmd === 'grep') src = src.replace(/\\\|/g, '|').replace(/\\\(/g, '(').replace(/\\\)/g, ')');
        if (f.has('w')) src = `\\b(?:${src})\\b`;
        let re;
        try { re = new RegExp(src, f.has('i') ? 'i' : ''); } catch (err) { return { ok: false, output: `grep: invalid pattern: ${err.message}` }; }
        const invert = f.has('v');
        const include = opts.include ? globToRegExp(opts.include) : null;
        const max = opts.m ? parseInt(opts.m, 10) : Infinity;
        const out = [];
        const scanText = (t, name) => {
          let count = 0;
          const lines = splitLines(t);
          for (let i = 0; i < lines.length && count < max; i++) {
            if (re.test(lines[i]) !== invert) {
              count++;
              if (f.has('l') || f.has('c')) continue;
              out.push(`${name ? `${name}:` : ''}${f.has('n') || cmd === 'rg' ? `${i + 1}:` : ''}${lines[i].slice(0, 300)}`);
              if (out.length > 400) break;
            }
          }
          if (f.has('l') && count) out.push(name);
          if (f.has('c')) out.push(`${name ? `${name}:` : ''}${count}`);
          return count;
        };
        if (!rest.length && stdin != null && !f.has('r') && cmd !== 'rg') { const n = scanText(stdin, ''); return { ok: n > 0, output: out.join('\n') }; }
        const targets = rest.length ? rest : [''];
        const recursive = f.has('r') || f.has('R') || cmd === 'rg' || !rest.length;
        let total = 0;
        for (const t of targets) {
          const path = readable(fs, isDenied, t);
          if (path && fs.isFile(path)) { total += scanText(textOf(fs, isDenied, path), targets.length > 1 || recursive ? path : ''); continue; }
          if (path && !fs.exists(path)) { out.push(`grep: ${t}: No such file or directory`); continue; }
          if (!recursive) { out.push(`grep: ${t}: Is a directory`); continue; }
          for (const r of fs.files()) {
            if (path && !r.path.startsWith(path + '/')) continue;
            if (isDenied(r.path) || r.binary instanceof Blob) continue;
            if (include && !include.test(r.path)) continue;
            total += scanText(r.content || '', r.path);
            if (out.length > 400) { out.push('… (more matches omitted)'); break; }
          }
        }
        return { ok: total > 0, output: out.join('\n') || '' };
      }
      case 'find': {
        let root = '', i = 0;
        if (args[0] && !args[0].startsWith('-')) { root = clean(args[0]); i = 1; }
        let name = null, type = null, maxdepth = Infinity;
        for (; i < args.length; i++) {
          if (args[i] === '-name' || args[i] === '-iname') { name = globToRegExp(args[++i] || '*'); }
          else if (args[i] === '-type') type = args[++i];
          else if (args[i] === '-maxdepth') maxdepth = parseInt(args[++i], 10);
        }
        if (root && !fs.exists(root)) return { ok: false, output: `find: ${root}: No such file or directory` };
        const baseDepth = root ? root.split('/').length : 0;
        const out = fs.entries().filter(r => (!root || r.path === root || r.path.startsWith(root + '/')) && !isDenied(r.path))
          .filter(r => r.path.split('/').length - baseDepth <= maxdepth)
          .filter(r => !type || (type === 'f' ? r.type === 'file' : r.type === 'folder'))
          .filter(r => !name || name.test(r.path.split('/').pop()))
          .map(r => `./${r.path}`);
        return { ok: true, output: out.slice(0, 1000).join('\n') + (out.length > 1000 ? `\n… ${out.length - 1000} more` : '') };
      }
      case 'tree': {
        const { rest, opts } = flags(args, 'L:');
        const root = clean(rest[0] || '');
        const depth = opts.L ? parseInt(opts.L, 10) : Infinity;
        const out = [root || '.'];
        const walk = (dir, prefix, d) => {
          if (d > depth) return;
          const kids = children(fs, dir).filter(r => !isDenied(r.path) && !/(^|\/)(node_modules|\.git)$/.test(r.path));
          kids.forEach((r, idx) => {
            const last = idx === kids.length - 1;
            out.push(`${prefix}${last ? '└── ' : '├── '}${r.path.split('/').pop()}${r.type === 'folder' ? '/' : ''}`);
            if (r.type === 'folder') walk(r.path, prefix + (last ? '    ' : '│   '), d + 1);
          });
        };
        walk(root, '', 1);
        return { ok: true, output: out.slice(0, 1500).join('\n') };
      }
      case 'stat': case 'du': {
        return { ok: true, output: args.filter(a => !a.startsWith('-')).map(p => { const path = readable(fs, isDenied, p); if (!fs.exists(path)) return `${p}: No such file or directory`; return `${path}\t${fs.isFolder(path) ? 'directory' : `${fs.size(path)} bytes`}`; }).join('\n') };
      }
      case 'which': case 'type': return { ok: false, output: `${args[0] || cmd}: X Coder has no system binaries; built-in commands are ls, cat, head, tail, wc, grep, find, tree, pwd, echo, node, python.` };
      default:
        return { ok: false, output: `${cmd}: command not found. Built-in read-only commands: ls, cat, head, tail, wc, grep, find, tree, pwd, echo, sort, uniq; run programs with \`node file.js\` or \`python file.py\`.` };
    }
  } catch (err) {
    return { ok: false, output: `${cmd}: ${err.message}` };
  }
}
