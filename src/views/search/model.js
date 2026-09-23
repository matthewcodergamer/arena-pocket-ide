// Search engine for the Search view: runs workspace.fs.search with include/exclude globs, groups
// matches per file, and computes replacements (regex groups, \n / \t escapes, Preserve Case).

import { workspace } from '../../core/workspace.js';
import { settings } from '../../core/settings.js';
import { buildMatcher } from './glob.js';

export const SEARCH_LIMIT = 2000;

export function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Effective case sensitivity (search.smartCase: lowercase-only query → insensitive). */
export function isCaseSensitive(q) {
  if (q.caseSensitive) return true;
  if (settings.get('search.smartCase', false) && /[A-Z]/.test(q.query || '')) return true;
  return false;
}

/** The same RegExp that ProjectFS.search builds (so positions line up). */
export function buildRegex(q, extraFlags = '') {
  const src = q.isRegex ? q.query : escapeRegExp(q.query);
  return new RegExp(q.wholeWord ? `\\b(?:${src})\\b` : src, (isCaseSensitive(q) ? '' : 'i') + extraFlags);
}

/** Returns an error message for an invalid regular expression, else null. */
export function validateQuery(q) {
  if (!q.query) return null;
  try { buildRegex(q, 'g'); return null; } catch (err) { return err.message; }
}

export function excludeMatcher(q) {
  const parts = [];
  if (q.exclude) parts.push(q.exclude);
  if (q.useExcludeSettings !== false) parts.push(settings.get('search.exclude', '') || '');
  return buildMatcher(parts.filter(Boolean).join(','));
}

/** Searches one text like ProjectFS.search does (per line, 1-based positions). */
function searchText(path, text, re, out, limit) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(lines[i]))) {
      out.push({ path, line: i + 1, col: m.index + 1, preview: lines[i].slice(0, 400), match: m[0], length: m[0].length });
      if (out.length >= limit) break;
      if (!m[0].length) re.lastIndex++;
    }
  }
}

/**
 * Runs a search. q: { query, isRegex, caseSensitive, wholeWord, include, exclude, useExcludeSettings }
 * `buffers` (Map path → text) are searched instead of the saved file (unsaved editors, like VS Code).
 * → { files: [{ path, matches: [{ id, line, col, length, preview, match }], dirty? }], total, limitHit, error }
 */
export function runSearch(q, limit = SEARCH_LIMIT, buffers = null) {
  const fs = workspace.fs;
  if (!fs || !q.query) return { files: [], total: 0, limitHit: false, error: null };
  const error = validateQuery(q);
  if (error) return { files: [], total: 0, limitHit: false, error };
  const inc = buildMatcher(q.include || '');
  const exc = excludeMatcher(q);
  const include = path => (!inc || inc(path)) && !(exc && exc(path));
  let raw;
  try {
    raw = fs.search(q.query, { regex: !!q.isRegex, caseSensitive: isCaseSensitive(q), wholeWord: !!q.wholeWord, limit: limit + 1, include: p => include(p) && !buffers?.has(p) });
    if (buffers?.size) {
      const re = buildRegex(q, 'g');
      for (const [path, text] of buffers) if (include(path) && fs.isFile(path)) searchText(path, text, re, raw, Infinity);
      const order = new Map(fs.files().map((r, i) => [r.path, i]));
      raw.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.line - b.line || a.col - b.col);
    }
  } catch (err) {
    return { files: [], total: 0, limitHit: false, error: err.message };
  }
  const limitHit = raw.length > limit;
  if (limitHit) raw = raw.slice(0, limit);
  const byPath = new Map();
  let id = 0;
  for (const r of raw) {
    if (!byPath.has(r.path)) byPath.set(r.path, { path: r.path, matches: [], dirty: !!buffers?.has(r.path) });
    byPath.get(r.path).matches.push({ id: ++id, line: r.line, col: r.col, length: r.length ?? r.match.length, preview: r.preview, match: r.match });
  }
  return { files: [...byPath.values()], total: raw.length, limitHit, error: null };
}

// ---------------- replace ----------------
/** VS Code's buildReplaceStringWithCasePreserved. */
export function preserveCase(matched, replacement) {
  if (!matched || !replacement) return replacement;
  if (matched.toUpperCase() === matched && /[a-z]/i.test(matched)) return replacement.toUpperCase();
  if (matched.toLowerCase() === matched && /[a-z]/i.test(matched)) return replacement.toLowerCase();
  for (const sep of ['-', '_']) {
    if (matched.includes(sep) && replacement.includes(sep)) {
      const m = matched.split(sep), r = replacement.split(sep);
      if (m.length === r.length) return r.map((part, i) => preserveCase(m[i], part)).join(sep);
    }
  }
  if (/[A-Z]/.test(matched[0])) return replacement[0].toUpperCase() + replacement.slice(1);
  if (/[a-z]/.test(matched[0])) return replacement[0].toLowerCase() + replacement.slice(1);
  return replacement;
}

/** Converts \n, \t and \\ in a regex replace pattern (VS Code supports these). */
function unescapeReplace(text) {
  return text.replace(/\\(\\|n|t)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
}

/**
 * The replacement for the match starting at 0-based `col0` on `lineText`, or null if the text there
 * no longer matches. → { length, text }
 */
export function replacementAt(lineText, col0, q) {
  const re = buildRegex(q, 'y');
  re.lastIndex = col0;
  const m = re.exec(lineText);
  if (!m) return null;
  let text;
  if (q.isRegex) {
    const sticky = buildRegex(q, 'y');
    sticky.lastIndex = col0;
    const replaced = lineText.replace(sticky, unescapeReplace(q.replace ?? ''));
    text = replaced.slice(col0, replaced.length - (lineText.length - col0 - m[0].length));
  } else text = q.replace ?? '';
  if (q.preserveCase) text = preserveCase(m[0], text);
  return { length: m[0].length, text };
}

/**
 * Applies replacements for `matches` ([{ line, col }], 1-based, from runSearch) to `text`.
 * → { text, replaced, skipped }
 */
export function applyReplacements(text, matches, q) {
  const lines = text.split('\n');
  const byLine = new Map();
  for (const m of matches) { if (!byLine.has(m.line)) byLine.set(m.line, []); byLine.get(m.line).push(m); }
  let replaced = 0, skipped = 0;
  for (const [line, list] of byLine) {
    let lineText = lines[line - 1];
    if (lineText == null) { skipped += list.length; continue; }
    list.sort((a, b) => b.col - a.col);
    let lastStart = Infinity;
    for (const m of list) {
      const col0 = m.col - 1;
      const r = replacementAt(lineText, col0, q);
      if (!r || col0 + r.length > lastStart) { skipped++; continue; }
      lineText = lineText.slice(0, col0) + r.text + lineText.slice(col0 + r.length);
      lastStart = col0;
      replaced++;
    }
    lines[line - 1] = lineText;
  }
  return { text: lines.join('\n'), replaced, skipped };
}
