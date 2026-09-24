// xsh — the X Coder shell behind the integrated terminal.
//
// A small POSIX-flavoured shell that runs entirely in the browser against the project file system
// (workspace.fs). Paths are project-relative: '~' and '/' both mean the project root.
//
//   const shell = new Shell(host);            // host: see TerminalInstance in terminal.js
//   const status = await shell.run('ls | grep x > out.txt && cat out.txt', { stdout, stderr, signal });
//
// Language: words with '…' / "…" quoting and \ escapes, $VAR ${VAR} ${VAR:-default} $? $$ $#,
// $(command) substitution, globbing (* ? ** [abc] {a,b}), pipes |, lists ; && || (& runs in the
// foreground), redirects > >> < 2> 2>> &> 2>&1 >&2 (/dev/null works), VAR=value assignments,
// aliases (expanded at command position, like bash), comments (#).
// Commands come from builtins.js / devtools.js and from terminal.registerCommand (src/panel/api.js).

import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { stripAnsi } from './ansi.js';
import { BUILTINS } from './builtins.js';
import { DEVTOOLS } from './devtools.js';
import { externalCommands } from './registry.js';

export class ShellError extends Error {
  constructor(message, status = 1) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- tokenizer

const OPS = ['&&', '||', ';;', '|', ';', '&'];
const isSpace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * Tokens: { t: 'word', parts: [{ v, q } | { sub, q }], raw } — q: 0 unquoted, 1 literal ('…' or \x), 2 "…"
 *         { t: 'op', v: '|' | '&&' | '||' | ';' | '&' }
 *         { t: 'redir', op: '>' | '>>' | '<' | '2>' | '2>>' | '&>' | '2>&1' | '>&2', raw }
 */
export function tokenize(src) {
  const tokens = [];
  let word = null, start = 0, i = 0;
  const part = (v, q) => {
    if (!word) { word = { t: 'word', parts: [] }; start = i; }
    const last = word.parts[word.parts.length - 1];
    if (last && last.q === q && last.v != null && typeof v === 'string') last.v += v;
    else word.parts.push(typeof v === 'string' ? { v, q } : { ...v, q });
  };
  const end = () => { if (word) { word.raw = src.slice(start, i); tokens.push(word); word = null; } };
  while (i < src.length) {
    const c = src[i];
    if (isSpace(c)) { end(); i++; continue; }
    if (c === '#' && !word) break;
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < src.length) { part(src[i + 1], 1); i += 2; } else i++;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new ShellError('unmatched \'', 2);
      part(src.slice(i + 1, j), 1); i = j + 1; continue;
    }
    if (c === '"') {
      if (!word) { word = { t: 'word', parts: [] }; start = i; }
      let j = i + 1, buf = '';
      const flush = () => { part(buf, 2); buf = ''; };
      for (;;) {
        if (j >= src.length) throw new ShellError('unmatched "', 2);
        const d = src[j];
        if (d === '"') break;
        if (d === '\\' && '$`"\\\n'.includes(src[j + 1])) { flush(); if (src[j + 1] !== '\n') part(src[j + 1], 1); j += 2; continue; }
        if (d === '$' && src[j + 1] === '(' && src[j + 2] === '(') { flush(); const k = matchArith(src, j + 1); part({ arith: src.slice(j + 3, k - 1) }, 2); j = k + 1; continue; }
        if (d === '$' && src[j + 1] === '(') { flush(); const k = matchParen(src, j + 1); part({ sub: src.slice(j + 2, k) }, 2); j = k + 1; continue; }
        if (d === '`') { flush(); const k = src.indexOf('`', j + 1); if (k < 0) throw new ShellError('unmatched `', 2); part({ sub: src.slice(j + 1, k) }, 2); j = k + 1; continue; }
        buf += d; j++;
      }
      flush(); i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') { const k = matchArith(src, i + 1); part({ arith: src.slice(i + 3, k - 1) }, 0); i = k + 1; continue; }
    if (c === '$' && src[i + 1] === '(') { const k = matchParen(src, i + 1); part({ sub: src.slice(i + 2, k) }, 0); i = k + 1; continue; }
    if (c === '`') { const k = src.indexOf('`', i + 1); if (k < 0) throw new ShellError('unmatched `', 2); part({ sub: src.slice(i + 1, k) }, 0); i = k + 1; continue; }
    // Redirections. A file-descriptor prefix (2>, 1>) only counts at the start of a word, like bash
    // ("echo a2>f" writes "a2" to f).
    const rest = src.slice(i);
    const redir = (!word && rest.match(/^(2>&1|1>&2|2>>|2>|1>>|1>)/)) || rest.match(/^(>&2|>&1|&>>|&>|>>|>|<)/);
    if (redir) {
      end();
      const op = { '1>&2': '>&2', '1>>': '>>', '1>': '>', '>&1': '' }[redir[1]] ?? redir[1];
      if (op) tokens.push({ t: 'redir', op, raw: redir[1] });
      i += redir[1].length; continue;
    }
    const op = OPS.find(o => rest.startsWith(o));
    if (op) { end(); tokens.push({ t: 'op', v: op === ';;' ? ';' : op }); i += op.length; continue; }
    part(c, 0); i++;
  }
  end();
  return tokens;
}

function matchParen(src, open) {
  let depth = 0, q = null;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') k++; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '\\') k++;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k;
  }
  throw new ShellError('unmatched (', 2);
}

/** Index of the second ')' closing a $(( … )) that opens at `open` (the first '('). */
function matchArith(src, open) {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '(') depth++;
    else if (src[k] === ')' && --depth === 0) {
      if (src[k - 1] !== ')') throw new ShellError('arithmetic expansion: missing `))\'', 2);
      return k;
    }
  }
  throw new ShellError('unmatched $((', 2);
}

/**
 * Shell arithmetic ($(( … ))): integers, variables, + - * / % **, comparisons, ! && ||, ~ & | ^ << >>,
 * ?: and parentheses. A small recursive-descent evaluator (no eval).
 */
export function evalArithmetic(expr, getVar) {
  const toks = String(expr).match(/\s*(0x[0-9a-f]+|\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%()<>!~&|^?:])/giy);
  if (String(expr).trim() && (!toks || toks.join('').replace(/\s+/g, '') !== String(expr).replace(/\s+/g, ''))) throw new ShellError(`${String(expr).trim()}: syntax error in expression`, 1);
  const list = (toks || []).map(t => t.trim());
  let i = 0;
  const peek = () => list[i];
  const eat = t => { if (list[i] === t) { i++; return true; } return false; };
  const value = name => { const v = getVar(name); const n = parseInt(v || '0', 10); return Number.isNaN(n) ? 0 : n; };
  const primary = () => {
    const t = list[i++];
    if (t == null) throw new ShellError('syntax error: operand expected', 1);
    if (t === '(') { const v = ternary(); if (!eat(')')) throw new ShellError("syntax error: missing ')'", 1); return v; }
    if (t === '-') return -unary0();
    if (t === '+') return unary0();
    if (t === '!') return unary0() ? 0 : 1;
    if (t === '~') return ~unary0();
    if (/^0x/i.test(t)) return parseInt(t, 16);
    if (/^\d/.test(t)) return parseInt(t, 10);
    if (/^[A-Za-z_]/.test(t)) return value(t);
    throw new ShellError(`syntax error: operand expected (error token is "${t}")`, 1);
  };
  const unary0 = () => primary();
  const pow = () => { const b = unary0(); if (eat('**')) return b ** pow(); return b; };
  const bin = (next, ops) => () => {
    let v = next();
    for (;;) {
      const op = peek();
      if (!ops.includes(op)) return v;
      i++;
      const r = next();
      switch (op) {
        case '*': v = v * r; break;
        case '/': if (!r) throw new ShellError('division by 0', 1); v = Math.trunc(v / r); break;
        case '%': if (!r) throw new ShellError('division by 0', 1); v = v % r; break;
        case '+': v = v + r; break;
        case '-': v = v - r; break;
        case '<<': v = v << r; break;
        case '>>': v = v >> r; break;
        case '<': v = +(v < r); break;
        case '>': v = +(v > r); break;
        case '<=': v = +(v <= r); break;
        case '>=': v = +(v >= r); break;
        case '==': v = +(v === r); break;
        case '!=': v = +(v !== r); break;
        case '&': v = v & r; break;
        case '^': v = v ^ r; break;
        case '|': v = v | r; break;
        case '&&': v = +(!!v && !!r); break;
        case '||': v = +(!!v || !!r); break;
      }
    }
  };
  const mul = bin(pow, ['*', '/', '%']);
  const add = bin(mul, ['+', '-']);
  const shift = bin(add, ['<<', '>>']);
  const rel = bin(shift, ['<', '>', '<=', '>=']);
  const eq = bin(rel, ['==', '!=']);
  const band = bin(eq, ['&']);
  const bxor = bin(band, ['^']);
  const bor = bin(bxor, ['|']);
  const land = bin(bor, ['&&']);
  const lor = bin(land, ['||']);
  function ternary() {
    const c = lor();
    if (!eat('?')) return c;
    const a = ternary();
    if (!eat(':')) throw new ShellError("syntax error: ':' expected", 1);
    const b = ternary();
    return c ? a : b;
  }
  if (!list.length) return 0;
  const v = ternary();
  if (i < list.length) throw new ShellError(`syntax error in expression (error token is "${list[i]}")`, 1);
  return v;
}

const plainWord = tok => tok?.t === 'word' && tok.parts.length === 1 && tok.parts[0].q === 0 && tok.parts[0].v != null ? tok.parts[0].v : null;

/** Expands aliases at command positions (token level, like bash). */
export function expandAliases(tokens, aliases, depth = 0) {
  if (!aliases.size || depth > 8) return tokens;
  const out = [];
  let atCommand = true, changed = false;
  for (const tok of tokens) {
    const name = atCommand ? plainWord(tok) : null;
    if (name && aliases.has(name) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) {
      const sub = tokenize(aliases.get(name));
      out.push(...expandAliases(sub, new Map([...aliases].filter(([k]) => k !== name)), depth + 1));
      changed = true;
      atCommand = false;
      continue;
    }
    out.push(tok);
    if (tok.t === 'op') atCommand = true;
    else if (tok.t === 'word' && !(atCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plainWord(tok) || ''))) atCommand = false;
  }
  return changed ? out : tokens;
}

// ---------------------------------------------------------------- parser

/** → [{ op: null | ';' | '&&' | '||' | '&', pipeline: { cmds: [{ assigns, words, redirs }] } }] */
export function parse(tokens) {
  const list = [];
  let op = null, cmds = [], cmd = newCmd();
  function newCmd() { return { assigns: [], words: [], redirs: [] }; }
  const endCmd = () => {
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length) throw new ShellError(`syntax error near unexpected token`, 2);
    cmds.push(cmd); cmd = newCmd();
  };
  const endPipeline = nextOp => {
    endCmd();
    list.push({ op, pipeline: { cmds } });
    cmds = []; op = nextOp;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'word') {
      const first = tok.parts[0];
      const m = !cmd.words.length && first?.q === 0 && first.v?.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
      if (m) cmd.assigns.push({ name: m[1], word: { ...tok, parts: [{ v: first.v.slice(m[0].length), q: 0 }, ...tok.parts.slice(1)] } });
      else cmd.words.push(tok);
    } else if (tok.t === 'redir') {
      if (tok.op === '2>&1' || tok.op === '>&2') { cmd.redirs.push({ op: tok.op }); continue; }
      const target = tokens[i + 1];
      if (target?.t !== 'word') throw new ShellError(`syntax error near unexpected token \`${target ? (target.v || target.raw || 'newline') : 'newline'}'`, 2);
      cmd.redirs.push({ op: tok.op, target }); i++;
    } else if (tok.v === '|') endCmd();
    else {
      if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length && !cmds.length) {
        if (tok.v === ';' && !list.length) throw new ShellError("syntax error near unexpected token `;'", 2);
        throw new ShellError(`syntax error near unexpected token \`${tok.v}'`, 2);
      }
      endPipeline(tok.v);
    }
  }
  if (cmd.words.length || cmd.assigns.length || cmd.redirs.length) endPipeline(null);
  else if (cmds.length) throw new ShellError('syntax error: unexpected end of file', 2);
  return list;
}

// ---------------------------------------------------------------- globbing

const GLOB_CHARS = /[*?[{]/;
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

export function globToRegExp(pattern, { dot = false } = {}) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const segStart = i === 0 || pattern[i - 1] === '/';
        if (segStart && pattern[i + 2] === '/') { re += '(?:[^/]*/)*'; i += 2; continue; }
        re += '.*'; i++; continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = pattern.indexOf(']', i + 2);
      if (j < 0) { re += '\\['; continue; }
      let body = pattern.slice(i + 1, j);
      if (body[0] === '!') body = '^' + body.slice(1);
      re += `[${body.replace(/\\/g, '\\\\')}]`; i = j;
    } else if (c === '{') {
      const j = pattern.indexOf('}', i + 1);
      if (j < 0 || !pattern.slice(i + 1, j).includes(',')) { re += '\\{'; continue; }
      re += `(?:${pattern.slice(i + 1, j).split(',').map(alt => globToRegExp(alt, { dot: true }).source.slice(1, -1)).join('|')})`;
      i = j;
    } else re += escapeRe(c);
  }
  void dot;
  return new RegExp(`^${re}$`);
}
export const hasGlob = s => GLOB_CHARS.test(s);

// ---------------------------------------------------------------- IO sinks

export function captureSink() {
  const chunks = [];
  return { isTTY: false, write(t) { chunks.push(String(t)); }, text() { return chunks.join(''); } };
}
const nullSink = { isTTY: false, write() {} };

// ---------------------------------------------------------------- the shell

const DEFAULT_ALIASES = [['ll', 'ls -la'], ['la', 'ls -A'], ['l', 'ls -CF'], ['cls', 'clear']];

export class Shell {
  /** host: { columns(), clear(), exit(code), history(), clearHistory(), projectName() } */
  constructor(host) {
    this.host = host;
    this.cwd = '';
    this.oldCwd = '';
    this.vars = new Map([
      ['HOME', '/'], ['USER', 'user'], ['LOGNAME', 'user'], ['HOSTNAME', 'xcoder'], ['SHELL', '/bin/xsh'],
      ['TERM', 'xterm-256color'], ['COLORTERM', 'truecolor'], ['LANG', 'en_US.UTF-8'], ['TERM_PROGRAM', 'vscode'],
      ['PATH', '/usr/local/bin:/usr/bin:/bin'], ['EDITOR', 'code']
    ]);
    this.exported = new Set(this.vars.keys());
    this.aliases = new Map(DEFAULT_ALIASES);
    this.status = 0;
    this.positional = [];
  }

  get fs() {
    if (!workspace.fs) throw new ShellError('no project is open');
    return workspace.fs;
  }

  // ---- paths
  /** Project-relative path for a user path ('' = project root). */
  resolve(p = '') {
    p = String(p);
    const slug = projectSlug(this.host.projectName?.() || workspace.name);
    if (p === '~' || p === '/' ) return '';
    if (p.startsWith(`~/${slug}`) && (p.length === slug.length + 2 || p[slug.length + 2] === '/') && !this.fs.exists(slug)) p = '/' + p.slice(slug.length + 2);
    if (p.startsWith('~/')) return posix.clean(p.slice(2));
    if (p.startsWith('/')) return posix.clean(p.slice(1));
    return posix.clean(posix.join(this.cwd, p));
  }
  isDir(path) { return path === '' || this.fs.isFolder(path); }
  exists(path) { return path === '' || this.fs.exists(path); }
  /** Prompt path: ~/<project-slug>/sub/dir */
  promptPath() {
    const slug = projectSlug(this.host.projectName?.() || workspace.name);
    return `~/${slug}${this.cwd ? '/' + this.cwd : ''}`;
  }
  pwd() { return '/' + this.cwd; }
  setCwd(path) {
    const p = typeof path === 'string' ? path : '';
    if (!this.isDir(p)) throw new ShellError(`${p}: Not a directory`);
    if (p !== this.cwd) { this.oldCwd = this.cwd; this.cwd = p; }
    this.vars.set('PWD', this.pwd()); this.vars.set('OLDPWD', '/' + this.oldCwd);
  }

  // ---- variables
  getVar(name) {
    switch (name) {
      case '?': return String(this.status);
      case '$': return '4242';
      case '#': return String(this.positional.length);
      case '@': case '*': return this.positional.join(' ');
      case '0': return 'xsh';
      case 'RANDOM': return String(Math.floor(Math.random() * 32768));
      case 'PWD': return this.pwd();
      case 'OLDPWD': return '/' + this.oldCwd;
      case 'COLUMNS': return String(this.host.columns?.() || 80);
      case 'SECONDS': return String(Math.floor(performance.now() / 1000));
    }
    if (/^[1-9]$/.test(name)) return this.positional[Number(name) - 1] ?? '';
    return this.vars.get(name) ?? '';
  }
  env() {
    const out = new Map();
    for (const k of this.exported) if (this.vars.has(k)) out.set(k, this.vars.get(k));
    out.set('PWD', this.pwd());
    return out;
  }

  expandVars(text) {
    return text.replace(/\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*)|([?$#@*0-9!]))/g, (m, braced, name, special) => {
      if (special) return special === '!' ? '' : this.getVar(special);
      if (name) return this.getVar(name);
      const def = braced.match(/^([A-Za-z_][A-Za-z0-9_]*|[?#0-9])(:?[-=+])(.*)$/);
      if (def) {
        const val = this.getVar(def[1]);
        const empty = def[2].startsWith(':') ? !val : !this.vars.has(def[1]) && !/^[?#0-9]$/.test(def[1]);
        if (def[2].endsWith('-')) return empty ? this.expandVars(def[3]) : val;
        if (def[2].endsWith('=')) { if (empty) { const v = this.expandVars(def[3]); this.vars.set(def[1], v); return v; } return val; }
        if (def[2].endsWith('+')) return empty ? '' : this.expandVars(def[3]);
      }
      if (braced.startsWith('#')) return String(this.getVar(braced.slice(1)).length);
      return this.getVar(braced);
    });
  }

  /** Expands one word token into zero or more fields (vars, substitution, splitting, globbing). */
  async expandWord(tok, io, { glob = true, split = true } = {}) {
    const fields = [];
    let cur = null;
    const ensure = () => (cur ??= { s: '', pat: '', globbable: false, keep: false });
    const literal = (text, q) => {
      const f = ensure();
      f.s += text;
      if (q === 0) { f.pat += text; if (hasGlob(text)) f.globbable = true; }
      else { f.pat += text.replace(/[*?[\]{}]/g, '\\$&'); f.keep = true; }
    };
    const splittable = text => {
      if (!split) { literal(text, 1); return; }
      const pieces = text.split(/[ \t\n]+/);
      pieces.forEach((piece, idx) => {
        if (idx > 0) { if (cur && (cur.s || cur.keep)) fields.push(cur); cur = null; }
        if (piece) literal(piece, 0);
      });
    };
    for (const p of tok.parts) {
      if (p.arith != null) {
        const n = String(evalArithmetic(this.expandVars(p.arith), name => this.getVar(name)));
        if (p.q === 2) literal(n, 2); else splittable(n);
        continue;
      }
      if (p.sub != null) {
        const out = (await this.capture(p.sub, io)).replace(/\n+$/, '');
        if (p.q === 2) literal(out, 2); else splittable(out);
        continue;
      }
      if (p.q === 1) { literal(p.v, 1); continue; }
      if (p.q === 2) { literal(this.expandVars(p.v), 2); continue; }
      // unquoted: literal text with embedded $VAR expansions (expansions are field-split)
      const re = /\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*|[?$#@*0-9!])/g;
      let last = 0, m;
      while ((m = re.exec(p.v))) {
        if (m.index > last) literal(p.v.slice(last, m.index), 0);
        splittable(this.expandVars(m[0]));
        last = m.index + m[0].length;
      }
      if (last < p.v.length) literal(p.v.slice(last), 0);
    }
    if (cur && (cur.s || cur.keep)) fields.push(cur);
    const out = [];
    for (const f of fields) {
      if (glob && f.globbable) {
        const matches = this.glob(f.pat);
        if (matches.length) { out.push(...matches); continue; }
      }
      out.push(f.s);
    }
    return out;
  }

  /** Matches a glob pattern against the project tree. Returns paths spelled like the pattern (relative or ~/…). */
  glob(pattern) {
    const segs = pattern.split('/');
    let prefixSegs = [];
    for (const s of segs) { if (hasGlob(s.replace(/\\./g, ''))) break; prefixSegs.push(s); }
    if (prefixSegs.length === segs.length) return [];
    const prefix = prefixSegs.join('/');
    const rest = segs.slice(prefixSegs.length).join('/');
    const base = prefix === '' && pattern.startsWith('/') ? '' : this.resolve(prefix || '.');
    if (!this.isDir(base)) return [];
    const dirOnly = rest.endsWith('/');
    const re = globToRegExp(dirOnly ? rest.slice(0, -1) : rest.replace(/\\(.)/g, '$1'));
    const allowDot = /(^|\/)\./.test(rest);
    const out = [];
    for (const r of this.fs.entries()) {
      if (base && !r.path.startsWith(base + '/')) continue;
      const rel = base ? r.path.slice(base.length + 1) : r.path;
      if (!allowDot && /(^|\/)\./.test(rel)) continue;
      if (dirOnly && r.type !== 'folder') continue;
      if (re.test(rel)) out.push((prefix ? (prefix.endsWith('/') ? prefix : prefix + '/') : '') + rel + (dirOnly ? '/' : ''));
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  // ---- execution
  /** Runs a command line. io: { stdout, stderr, stdin?, signal } → exit status */
  async run(line, io) {
    let list;
    try { list = parse(expandAliases(tokenize(line), this.aliases)); }
    catch (err) { io.stderr.write(`xsh: ${err.message}\n`); this.status = err.status ?? 2; return this.status; }
    return this.runList(list, io);
  }

  async runList(list, io) {
    for (const item of list) {
      if (io.signal?.aborted) return (this.status = 130);
      if (item.op === '&&' && this.status !== 0) continue;
      if (item.op === '||' && this.status === 0) continue;
      this.status = await this.runPipeline(item.pipeline, io);
      if (this.exitRequested) break;
    }
    return this.status;
  }

  async runPipeline({ cmds }, io) {
    let stdin = io.stdin ?? '';
    let status = 0;
    for (let i = 0; i < cmds.length; i++) {
      const last = i === cmds.length - 1;
      const sink = last ? io.stdout : captureSink();
      status = await this.runSimple(cmds[i], { ...io, stdin, stdout: sink, piped: cmds.length > 1 && i > 0 });
      if (io.signal?.aborted) return 130;
      if (!last) stdin = sink.text();
    }
    return status;
  }

  /** Captures the stdout of a command line ($(…) substitution). */
  async capture(line, io) {
    const sink = captureSink();
    const saved = this.status;
    await this.run(line, { ...io, stdout: sink, stdin: '' });
    this.status = saved;
    return stripAnsi(sink.text());
  }

  async runSimple(cmd, io) {
    const argv = [];
    try { for (const w of cmd.words) argv.push(...await this.expandWord(w, io)); }
    catch (err) { io.stderr.write(`xsh: ${err.message}\n`); return 1; }
    const assigns = [];
    for (const a of cmd.assigns) assigns.push([a.name, (await this.expandWord(a.word, io, { glob: false, split: false })).join('')]);
    if (!argv.length) {
      for (const [k, v] of assigns) this.vars.set(k, v);
      if (!cmd.redirs.length) return 0;
    }
    // redirections
    let { stdout, stderr, stdin } = io;
    const files = [];
    for (const r of cmd.redirs) {
      if (r.op === '2>&1') { stderr = stdout; continue; }
      if (r.op === '>&2') { stdout = stderr; continue; }
      const target = (await this.expandWord(r.target, io, { split: false })).join(' ');
      if (r.op === '<') {
        const p = this.resolve(target);
        if (!this.fs.isFile(p)) { io.stderr.write(`xsh: ${this.exists(p) ? 'is a directory' : 'no such file or directory'}: ${target}\n`); return 1; }
        stdin = await this.fs.readText(p);
        continue;
      }
      let sink = nullSink;
      if (target !== '/dev/null') {
        const path = this.resolve(target);
        if (!path || this.fs.isFolder(path)) { io.stderr.write(`xsh: is a directory: ${target}\n`); return 1; }
        const f = { path, append: r.op.endsWith('>>'), sink: captureSink() };
        files.push(f); sink = f.sink;
      }
      if (r.op === '>' || r.op === '>>') stdout = sink;
      else if (r.op === '2>' || r.op === '2>>') stderr = sink;
      else if (r.op === '&>' || r.op === '&>>') { stdout = sink; stderr = sink; }
    }
    let status = 0;
    if (argv.length) {
      const saved = new Map();
      for (const [k, v] of assigns) { saved.set(k, this.vars.has(k) ? this.vars.get(k) : undefined); this.vars.set(k, v); }
      const raw = cmd.words.map(w => w.raw).join(' ');
      try { status = await this.exec(argv, { ...io, stdout, stderr, stdin, raw }); }
      finally { for (const [k, v] of saved) v === undefined ? this.vars.delete(k) : this.vars.set(k, v); }
    }
    for (const f of files) {
      try {
        let text = stripAnsi(f.sink.text());
        if (f.append && this.fs.isFile(f.path)) text = (await this.fs.readText(f.path)) + text;
        await this.fs.writeText(f.path, text, { source: 'terminal' });
      } catch (err) { io.stderr.write(`xsh: ${err.message}\n`); status = 1; }
    }
    return status;
  }

  /** Looks up a command: builtins, dev tools, then commands registered through the terminal API. */
  lookup(name) {
    return BUILTINS.get(name) || externalCommands.get(name) || DEVTOOLS.get(name) || null;
  }
  commandNames() {
    return [...new Set([...BUILTINS.keys(), ...DEVTOOLS.keys(), ...externalCommands.keys(), ...this.aliases.keys()])].sort();
  }

  /** Executes an argv with io. */
  async exec(argv, io) {
    const [name, ...args] = argv;
    let cmd = this.lookup(name);
    if (!cmd && /^\.{0,2}\/|^~\//.test(name)) cmd = BUILTINS.get('__exec_path');
    if (!cmd) { io.stderr.write(`xsh: command not found: ${name}\n`); return 127; }
    const ctx = this.context(name, args, io);
    if (args[0] === '--help' && cmd.usage && !cmd.external) { ctx.out(`Usage: ${cmd.usage}\n${cmd.summary ? `${cmd.summary}\n` : ''}`); return 0; }
    try {
      const result = await (cmd.external ? cmd.invoke(args, ctx) : cmd.run(ctx));
      if (io.signal?.aborted) return 130;
      return typeof result === 'number' ? result : 0;
    } catch (err) {
      if (io.signal?.aborted || err?.name === 'AbortError') return 130;
      const msg = err instanceof ShellError ? err.message : (err?.message || String(err));
      io.stderr.write(`${name}: ${msg}\n`);
      return err?.status ?? 1;
    }
  }

  context(name, args, io) {
    const shell = this;
    return {
      name, args, shell,
      raw: io.raw ?? [name, ...args].join(' '),
      stdin: io.stdin ?? '',
      hasStdin: io.piped || io.stdin != null && io.stdin !== '',
      isTTY: !!io.stdout.isTTY,
      signal: io.signal,
      io,
      get fs() { return shell.fs; },
      get cwd() { return shell.cwd; },
      columns: this.host.columns?.() || 80,
      out: text => io.stdout.write(String(text)),
      err: text => io.stderr.write(String(text)),
      println: text => io.stdout.write(String(text) + '\n'),
      resolve: p => shell.resolve(p),
      /** Runs another command line with this context's io (used by xargs, npm run, scripts). */
      run: (line, extra = {}) => shell.run(line, { ...io, ...extra }),
      exec: (argv, extra = {}) => shell.exec(argv, { ...io, ...extra })
    };
  }
}

export function projectSlug(name = '') {
  return String(name || 'project').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}
