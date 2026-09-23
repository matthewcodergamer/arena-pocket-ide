// Built-in diagnostics → core/diagnostics.js (Problems panel) under the owners 'javascript', 'json', 'syntax':
//   · JavaScript (.js/.mjs/.cjs): acorn (module, then script fallback; JSX-in-.js falls back to the JSX grammar)
//   · JSON: a VS Code–style validator (comments/trailing commas allowed in jsconfig/tsconfig/.vscode/*.json)
//   · everything else with a lezer grammar: syntax-tree error nodes ("Syntax error" warnings)
// Open editors lint their live text (debounced by the editor); a throttled background pass covers the
// whole project when it opens and whenever files change outside the editor (AI, git, search, terminal).

import { diagnostics } from '../core/diagnostics.js';
import { workspace } from '../core/workspace.js';
import { bus } from '../core/events.js';
import { log } from '../core/output.js';
import { detectLanguage, loadSupport, languageById } from './languages.js';
import { languageOverride, isOpenInEditor } from './registry.js';

export const OWNERS = ['javascript', 'json', 'syntax'];
const MAX_FILE = 200 * 1024;
const MAX_FILES = 400;
const MAX_MARKERS = 20;
const NO_SYNTAX = new Set(['plaintext', 'markdown', 'diff', 'properties']);

let acornMod = null;
async function acorn() { return acornMod || (acornMod = await import('../../vendor/acorn.js')); }

function lineCol(text, offset, lineStarts) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
}
function lineStartsOf(text) { const out = [0]; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1); return out; }
function marker(text, starts, from, to, message, severity, source) {
  const a = lineCol(text, Math.min(from, text.length), starts);
  const b = lineCol(text, Math.min(Math.max(to, from + 1), text.length), starts);
  if (b.line === a.line && b.col <= a.col) b.col = a.col + 1;
  return { line: a.line, col: a.col, endLine: b.line, endCol: b.col, severity, message, source };
}

// ---------------- JavaScript (acorn) ----------------
async function lintJavaScript(text) {
  const { parse } = await acorn();
  const base = { ecmaVersion: 'latest', allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, locations: true };
  let moduleErr = null;
  try { parse(text, { ...base, sourceType: 'module' }); return { errors: [] }; } catch (err) { moduleErr = err; }
  try { parse(text, { ...base, sourceType: 'script' }); return { errors: [] }; } catch {}
  const pos = typeof moduleErr?.pos === 'number' ? moduleErr.pos : 0;
  // JSX inside a .js file (common in React projects): let the JSX grammar decide.
  if (text[pos] === '<' && /<[A-Za-z>]/.test(text.slice(pos, pos + 2))) return { jsx: true };
  const token = /^[\w$]+|^\S/.exec(text.slice(pos)) || [''];
  const message = String(moduleErr?.message || 'Syntax error').replace(/\s*\(\d+:\d+\)\s*$/, '');
  return { errors: [{ from: pos, to: pos + Math.max(1, token[0].length), message }] };
}

// ---------------- JSON ----------------
/** Validates JSON the way VS Code's JSON language service reports it. Returns [{from, to, message, severity}]. */
export function validateJSON(text, { comments = false, trailingCommas = false } = {}) {
  const errors = [];
  const n = text.length;
  let i = 0;
  const FATAL = {};
  const add = (message, from, len = 1, severity = 'error') => { if (errors.length < MAX_MARKERS) errors.push({ from, to: from + Math.max(1, len), message, severity }); };
  const fatal = (message, from, len = 1) => { add(message, Math.min(from, Math.max(0, n - 1)), len); throw FATAL; };
  const tokenLen = at => { const m = /^("(?:[^"\\\n]|\\.)*"?|[^\s,:{}[\]"]+|.)/.exec(text.slice(at, at + 200)); return m ? m[0].length : 1; };
  const skipWs = () => {
    for (;;) {
      while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) i++; else break; }
      if (text[i] === '/' && text[i + 1] === '/') { const s = i; while (i < n && text[i] !== '\n') i++; if (!comments) add('Comments are not permitted in JSON.', s, i - s); continue; }
      if (text[i] === '/' && text[i + 1] === '*') {
        const s = i; const e = text.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
        if (e < 0) fatal('Unexpected end of comment.', s, i - s);
        if (!comments) add('Comments are not permitted in JSON.', s, i - s);
        continue;
      }
      return;
    }
  };
  const parseString = () => {
    const s = i; i++;
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) add('Invalid unicode sequence in string.', i, 6); i += 6; continue; }
        if (!e || !'"\\/bfnrt'.includes(e)) add('Invalid escape character in string.', i, 2);
        out += e || ''; i += 2; continue;
      }
      if (c === '\n' || c === '\r') fatal('Unexpected end of string.', s, i - s);
      if (c < ' ') add('Invalid characters in string. Control characters must be escaped.', i, 1);
      out += c; i++;
    }
    fatal('Unexpected end of string.', s, i - s);
  };
  const parseValue = () => {
    skipWs();
    if (i >= n) fatal('Value expected', n - 1);
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') { parseString(); return; }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
      if (!m) { add('Invalid number format.', i, tokenLen(i)); i += tokenLen(i); return; }
      i += m[0].length;
      if (/[\w.]/.test(text[i] || '')) { const s = i; while (i < n && /[\w.]/.test(text[i])) i++; add('Invalid number format.', s, i - s); }
      return;
    }
    for (const kw of ['true', 'false', 'null']) if (text.startsWith(kw, i) && !/[\w$]/.test(text[i + kw.length] || '')) { i += kw.length; return; }
    fatal('Value expected', i, tokenLen(i));
  };
  const parseObject = () => {
    const open = i; i++;
    const keys = new Set();
    skipWs();
    if (text[i] === '}') { i++; return; }
    for (;;) {
      skipWs();
      if (i >= n) fatal('Closing brace expected', open);
      if (text[i] !== '"') {
        if (text[i] === "'") fatal('Property keys must be doublequoted', i, tokenLen(i));
        fatal('Property expected', i, tokenLen(i));
      }
      const ks = i;
      const key = parseString();
      if (keys.has(key)) add('Duplicate object key', ks, i - ks, 'warning');
      keys.add(key);
      skipWs();
      if (text[i] !== ':') fatal('Colon expected', i, tokenLen(i));
      i++;
      parseValue();
      skipWs();
      if (text[i] === ',') {
        const comma = i; i++; skipWs();
        if (text[i] === '}') { if (!trailingCommas) add('Trailing comma', comma, 1); i++; return; }
        continue;
      }
      if (text[i] === '}') { i++; return; }
      if (i >= n) fatal('Closing brace expected', open);
      fatal('Expected comma', i, tokenLen(i));
    }
  };
  const parseArray = () => {
    const open = i; i++;
    skipWs();
    if (text[i] === ']') { i++; return; }
    for (;;) {
      parseValue();
      skipWs();
      if (text[i] === ',') {
        const comma = i; i++; skipWs();
        if (text[i] === ']') { if (!trailingCommas) add('Trailing comma', comma, 1); i++; return; }
        continue;
      }
      if (text[i] === ']') { i++; return; }
      if (i >= n) fatal('Closing bracket expected', open);
      fatal('Expected comma', i, tokenLen(i));
    }
  };
  try {
    skipWs();
    if (i < n) {
      parseValue();
      skipWs();
      if (i < n) fatal('End of file expected.', i, tokenLen(i));
    }
  } catch (e) { if (e !== FATAL) throw e; }
  return errors;
}

function jsonFlavor(path, lang) {
  const loose = lang?.id === 'jsonc' || /(^|\/)\.vscode\/[^/]+\.json$/i.test(path) || /(^|\/)(ts|js)config(\.[^/]*)?\.json$/i.test(path);
  return { comments: loose, trailingCommas: loose };
}

// ---------------- lezer syntax errors ----------------
async function lintTree(text, lang) {
  const support = await loadSupport(lang);
  if (!support) return [];
  const parser = support.language?.parser;
  if (!parser || typeof parser.parse !== 'function') return [];
  const tree = parser.parse(text);
  const out = [];
  const seenLines = new Set();
  let lastEnd = -1;
  tree.iterate({
    enter(node) {
      if (out.length >= MAX_MARKERS) return false;
      if (!node.type.isError) return;
      if (node.from < lastEnd) return;
      const lineStart = text.lastIndexOf('\n', node.from - 1) + 1;
      if (seenLines.has(lineStart)) return;
      seenLines.add(lineStart);
      let from = node.from, to = node.to;
      if (to <= from) {
        // Zero-width error: point at the token that follows (or the previous character at end of line/file).
        const m = /^[\w$]+|^\S/.exec(text.slice(from, from + 100));
        if (m && text[from] !== '\n') to = from + m[0].length;
        else if (from > 0) { from -= 1; to = from + 1; }
        else to = from + 1;
      }
      lastEnd = to;
      out.push({ from, to, message: 'Syntax error', severity: 'warning' });
    }
  });
  return out;
}

/** Lints `text` as the file at `path`. Returns { owner, markers }. */
export async function lintText(path, text, lang = detectLanguage(path, text, languageOverride(path))) {
  const starts = lineStartsOf(text);
  const toMarkers = (list, severity, source) => list.map(e => marker(text, starts, e.from, e.to, e.message, e.severity || severity, source));
  if (lang?.id === 'json' || lang?.id === 'jsonc') {
    return { owner: 'json', markers: toMarkers(validateJSON(text, jsonFlavor(path, lang)), 'error', 'json') };
  }
  if (lang?.id === 'javascript') {
    const r = await lintJavaScript(text);
    if (r.jsx) {
      const jsx = languageById('javascriptreact');
      return { owner: 'syntax', markers: toMarkers(await lintTree(text, jsx), 'warning', 'syntax') };
    }
    return { owner: 'javascript', markers: toMarkers(r.errors, 'error', 'javascript') };
  }
  if (!lang?.desc || NO_SYNTAX.has(lang.id)) return { owner: null, markers: [] };
  return { owner: 'syntax', markers: toMarkers(await lintTree(text, lang), 'warning', 'syntax') };
}

/** Lints and publishes markers for `path` (clearing the other built-in owners). */
export async function lintAndPublish(path, text, lang) {
  if (text == null) { for (const o of OWNERS) diagnostics.clear(o, path); return; }
  let result;
  try { result = await lintText(path, text, lang); }
  catch (err) { log.warn(`Diagnostics for ${path} failed`, err); return; }
  for (const o of OWNERS) if (o !== result.owner) diagnostics.clear(o, path);
  if (result.owner) diagnostics.set(result.owner, path, result.markers);
}

// ---------------- background pass ----------------
const queue = new Set();
let scheduled = false;
let generation = 0;
const idle = window.requestIdleCallback ? (fn => window.requestIdleCallback(fn, { timeout: 1500 })) : (fn => setTimeout(() => fn({ timeRemaining: () => 12, didTimeout: true }), 60));

function shouldLint(rec) {
  if (!rec || rec.type !== 'file' || rec.binary instanceof Blob) return false;
  return (rec.content || '').length <= MAX_FILE;
}

export function queueBackgroundLint(paths) {
  for (const p of paths) queue.add(p);
  if (!scheduled && queue.size) { scheduled = true; idle(runBatch); }
}

async function runBatch(deadline) {
  const gen = generation;
  const started = performance.now();
  try {
    while (queue.size && (performance.now() - started < 14 || deadline?.didTimeout)) {
      const path = queue.values().next().value;
      queue.delete(path);
      if (isOpenInEditor(path)) continue;
      const fs = workspace.fs;
      const rec = fs?.get(path);
      if (!rec) { for (const o of OWNERS) diagnostics.clear(o, path); continue; }
      if (!shouldLint(rec)) { for (const o of OWNERS) diagnostics.clear(o, path); continue; }
      await lintAndPublish(path, rec.content || '');
      if (gen !== generation) return;
      if (performance.now() - started > 40) break;
    }
  } catch (err) { log.warn('Background diagnostics failed', err); }
  finally {
    if (gen === generation) {
      scheduled = false;
      if (queue.size) { scheduled = true; idle(runBatch); }
    }
  }
}

function lintableFiles() {
  const fs = workspace.fs;
  if (!fs) return [];
  return fs.files().filter(shouldLint).map(r => r.path).slice(0, MAX_FILES);
}

export function startBackgroundDiagnostics() {
  const onProject = () => {
    generation++;
    queue.clear(); scheduled = false;
    for (const o of OWNERS) diagnostics.clear(o);
    queueBackgroundLint(lintableFiles());
  };
  bus.on('project:opened', onProject);
  if (workspace.fs) onProject();
  bus.on('fs:changed', ev => {
    try {
      if (ev.type === 'delete') { diagnostics.removePath(ev.path); return; }
      if (ev.type === 'rename') {
        diagnostics.renamePath(ev.path, ev.to);
        const fs = workspace.fs;
        if (fs?.isFile(ev.to)) queueBackgroundLint([ev.to]);
        else if (fs) queueBackgroundLint(fs.files().filter(r => r.path.startsWith(ev.to + '/')).map(r => r.path));
        return;
      }
      if (ev.type === 'reset') {
        const fs = workspace.fs;
        if (!fs) return;
        for (const { path } of diagnostics.all()) if (!fs.exists(path)) diagnostics.removePath(path);
        queueBackgroundLint(lintableFiles());
        return;
      }
      if ((ev.type === 'write' || ev.type === 'create') && ev.source !== 'editor') queueBackgroundLint([ev.path]);
    } catch (err) { log.warn('Diagnostics update failed', err); }
  });
}
