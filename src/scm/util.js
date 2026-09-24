// Source Control utilities: git blob hashing (SHA-1 over "blob <len>\0" + bytes, so local hashes
// compare directly with GitHub tree SHAs), SHA-256 (X Coder 5 snapshots), base64, text decoding,
// unified diffs (Myers), .gitignore matching, and GitHub repository / branch name parsing.

import { posix, isTextPath } from '../core/path.js';

const encoder = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
const subtle = () => (globalThis.crypto && crypto.subtle) || null;

export function encodeText(text) { return encoder.encode(String(text ?? '')); }

/** Strict UTF-8 decode that keeps a BOM (so bytes round-trip); null when the bytes are not valid UTF-8. */
export function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

/** Bytes of a ProjectFS record (text → UTF-8, binary → blob bytes). */
export async function recordBytes(rec) {
  if (rec?.binary instanceof Blob) return new Uint8Array(await rec.binary.arrayBuffer());
  return encodeText(rec?.content || '');
}

/** Bytes of a stored value { content } | { blob }. */
export async function storedBytes(value) {
  if (value?.blob instanceof Blob) return new Uint8Array(await value.blob.arrayBuffer());
  return encodeText(value?.content ?? '');
}

/** How a downloaded file is stored locally: text when the path is a text type and the bytes are valid UTF-8. */
export function toStored(path, bytes, mime) {
  if (isTextPath(path)) {
    const text = decodeText(bytes);
    if (text !== null) return { content: text };
  }
  return { blob: new Blob([bytes], { type: mime || '' }) };
}

/** Git blob object id of the bytes: SHA-1("blob <len>\0" + bytes). */
export async function gitBlobSha(bytes) {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0); all.set(bytes, header.length);
  const s = subtle();
  if (s) return toHex(await s.digest('SHA-1', all));
  return sha1Fallback(all);
}

/** SHA-256 hex (X Coder 5 stored its GitHub snapshot as SHA-256 of the file bytes). */
export async function sha256Hex(bytes) {
  const s = subtle();
  if (!s) return null;
  return toHex(await s.digest('SHA-256', bytes));
}

// Plain SHA-1 for non-secure contexts (http://<lan-ip>) where crypto.subtle is unavailable.
function sha1Fallback(bytes) {
  const ml = bytes.length;
  const withPadding = ((ml + 9 + 63) >> 6) << 6;
  const msg = new Uint8Array(withPadding);
  msg.set(bytes); msg[ml] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(withPadding - 4, (ml * 8) >>> 0);
  dv.setUint32(withPadding - 8, Math.floor(ml / 0x20000000));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPadding; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, '0')).join('');
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function base64ToBytes(b64) {
  const raw = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Runs fn over items with at most `limit` in flight; stops scheduling after the first failure. */
export async function pool(items, limit, fn) {
  let next = 0, failed = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { await fn(items[i], i); } catch (err) { failed = failed || err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed;
}

// ---------------------------------------------------------------- repository / branch names

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Parses "owner/repo", "https://github.com/owner/repo(.git)(/tree/branch)", "github.com/owner/repo",
 * "git@github.com:owner/repo.git" → { owner, repo, full, branch? } or null.
 */
export function parseRepo(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/^git\+/, '').replace(/^git@github\.com:/i, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/^\/+/, '');
  if (/^[a-z]+:\/\//i.test(s)) return null; // another host
  const parts = s.split(/[?#]/)[0].split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  let branch;
  if (parts[2] === 'tree' && parts.length > 3) branch = parts.slice(3).join('/');
  return { owner, repo, full: `${owner}/${repo}`, ...(branch ? { branch } : {}) };
}

export function isValidRepoName(name) { return REPO_RE.test(name) && name !== '.' && name !== '..'; }

/** Makes a GitHub repository name from a project name ("My Project!" → "My-Project"). */
export function repoSlug(name) {
  const s = String(name || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 100);
  return isValidRepoName(s) ? s : 'x-coder-project';
}

/** Returns an error message when `name` is not a valid git branch name (git check-ref-format rules), else null. */
export function branchNameError(name) {
  const n = String(name ?? '');
  if (!n.trim()) return 'Please provide a branch name';
  if (/\s/.test(n)) return 'Branch names cannot contain spaces';
  if (/[\x00-\x1f\x7f~^:?*[\\]/.test(n)) return 'Branch names cannot contain ~ ^ : ? * [ \\ or control characters';
  if (n.includes('..') || n.includes('//') || n.includes('@{')) return 'Branch names cannot contain "..", "//" or "@{"';
  if (n.startsWith('/') || n.endsWith('/') || n.endsWith('.') || n.startsWith('-')) return 'Branch names cannot start with "/" or "-", or end with "/" or "."';
  if (n.endsWith('.lock') || n === '@' || n.split('/').some(p => p.startsWith('.'))) return 'That is not a valid branch name';
  if (n.length > 200) return 'Branch name is too long';
  return null;
}

// ---------------------------------------------------------------- .gitignore

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const prevSlash = i === 0 || glob[i - 1] === '/';
        const nextSlash = glob[i + 2] === '/' || i + 2 === glob.length;
        if (prevSlash && nextSlash) {
          if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
          continue;
        }
        i++; re += '[^/]*'; continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += `[${cls}]`; i = end;
    } else if (c === '\\' && i + 1 < glob.length) { re += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return re;
}

/** .gitignore matcher for the project's .gitignore files (root and nested). `.git/` is always ignored. */
export class IgnoreMatcher {
  /** sources: [{ base: 'folder' | '', text }] */
  constructor(sources = []) {
    this.rules = [];
    for (const { base, text } of sources) {
      for (let line of String(text || '').split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        line = line.replace(/(?<!\\)\s+$/, '');
        if (!line) continue;
        let negate = false;
        if (line.startsWith('!')) { negate = true; line = line.slice(1); }
        else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
        let dirOnly = false;
        if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
        if (!line) continue;
        const anchored = line.includes('/');
        if (line.startsWith('/')) line = line.slice(1);
        let regex;
        try { regex = new RegExp(`^${globToRegex(line)}$`); } catch { continue; }
        this.rules.push({ base, negate, dirOnly, anchored, regex });
      }
    }
  }
  static fromFS(fs) {
    const sources = [];
    for (const r of fs.files()) {
      if (posix.basename(r.path) !== '.gitignore' || r.binary instanceof Blob) continue;
      sources.push({ base: posix.dirname(r.path), text: r.content || '' });
    }
    sources.sort((a, b) => a.base.split('/').length - b.base.split('/').length);
    return new IgnoreMatcher(sources);
  }
  test(path, isDir) {
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.base && !(path.startsWith(r.base + '/'))) continue;
      const rel = r.base ? path.slice(r.base.length + 1) : path;
      const target = r.anchored ? rel : posix.basename(rel);
      if (r.regex.test(target)) ignored = !r.negate;
    }
    return ignored;
  }
  ignores(path) {
    const parts = path.split('/');
    if (parts.includes('.git')) return true;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (this.test(acc, true)) return true;
    }
    return this.test(path, false);
  }
}

// ---------------------------------------------------------------- unified diff

const NO_EOL = '\u0000';
// A last line without a trailing newline gets a marker so "a" and "a\n" differ (like git's
// "\ No newline at end of file").
function splitLines(text) {
  if (!text) return [];
  const lines = String(text).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

/** Myers diff over lines → [{ op: ' ' | '-' | '+', line }]. Falls back to replace-all for huge edit distances. */
export function diffLines(aText, bText) {
  const a = splitLines(aText), b = splitLines(bText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map(line => ({ op: ' ', line }));
  const tail = a.slice(endA).map(line => ({ op: ' ', line }));
  const A = a.slice(start, endA), B = b.slice(start, endB);
  return [...head, ...myers(A, B), ...tail];
}

function myers(a, b) {
  const n = a.length, m = b.length;
  if (!n) return b.map(line => ({ op: '+', line }));
  if (!m) return a.map(line => ({ op: '-', line }));
  const max = n + m, limit = Math.min(max, 4000);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return [...a.map(line => ({ op: '-', line })), ...b.map(line => ({ op: '+', line }))];
  // backtrack
  const out = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]; // v before step d, window [-d-1, d+1]
    const at = k => prev[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ op: ' ', line: a[x - 1] }); x--; y--; }
    if (x === prevX) out.push({ op: '+', line: b[y - 1] }); else out.push({ op: '-', line: a[x - 1] });
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { out.push({ op: ' ', line: a[x - 1] }); x--; y--; }
  return out.reverse();
}

/**
 * Unified diff ("git diff" format) between two texts. oldText/newText null = file absent (added/deleted).
 * Returns '' when identical.
 */
export function unifiedDiff(path, oldText, newText, { context = 3 } = {}) {
  if (oldText === newText) return '';
  const ops = diffLines(oldText ?? '', newText ?? '');
  const header = [`diff --git a/${path} b/${path}`];
  if (oldText == null) header.push('new file mode 100644');
  if (newText == null) header.push('deleted file mode 100644');
  header.push(`--- ${oldText == null ? '/dev/null' : `a/${path}`}`, `+++ ${newText == null ? '/dev/null' : `b/${path}`}`);
  const hunks = [];
  let i = 0;
  const changed = ops.map(o => o.op !== ' ');
  while (i < ops.length) {
    if (!changed[i]) { i++; continue; }
    let start = Math.max(0, i - context), end = i;
    // extend the hunk while changes are within 2*context lines of each other
    for (;;) {
      while (end < ops.length && changed[end]) end++;
      let next = end;
      while (next < ops.length && !changed[next] && next - end < context * 2) next++;
      if (next < ops.length && changed[next] && next - end <= context * 2) { end = next; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    let oldStart = 1, newStart = 1;
    for (let j = 0; j < start; j++) { if (ops[j].op !== '+') oldStart++; if (ops[j].op !== '-') newStart++; }
    let oldLen = 0, newLen = 0;
    const body = [];
    for (let j = start; j < stop; j++) {
      const o = ops[j];
      if (o.op !== '+') oldLen++;
      if (o.op !== '-') newLen++;
      if (o.line.endsWith(NO_EOL)) body.push(o.op + o.line.slice(0, -1), '\\ No newline at end of file');
      else body.push(o.op + o.line);
    }
    hunks.push(`@@ -${oldLen ? oldStart : oldStart - 1},${oldLen} +${newLen ? newStart : newStart - 1},${newLen} @@`, ...body);
    i = stop;
  }
  return [...header, ...hunks].join('\n') + '\n';
}
