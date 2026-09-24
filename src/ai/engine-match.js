// Pure text utilities for the X Coder agent engine (no DOM, no app imports — unit-tested in Node by
// tools/test/ai-protocol.test.mjs):
//
//   applyBlocks(content, blocks, { path })   SEARCH/REPLACE application with a cascade of matchers:
//                                              exact → line-ending normalized → trailing-whitespace-insensitive
//                                              → indentation-insensitive (re-indents the replacement)
//                                              → unique fuzzy line window (similarity ≥ 0.9).
//                                              Failed blocks get a precise error with the closest candidate.
//   lineDiffStats(a, b) → { added, removed }  real line diff counts (LCS; bounded cost)
//   globToRegExp(glob), compileIgnore(text)   gitignore-style matching (.aiignore, include filters)
//   findPlaceholder(text, path)               detects lazy "// ... existing code ..." elisions
//   numbered(text, start)                     "  12 | code" line-numbered excerpts
//   detectEol / toLf / withEol                line-ending helpers

export const FUZZY_THRESHOLD = 0.9;

export function detectEol(text = '') {
  const crlf = (text.match(/\r\n/g) || []).length;
  if (!crlf) return '\n';
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf >= lf ? '\r\n' : '\n';
}
export const toLf = (text = '') => String(text).replace(/\r\n?/g, '\n');
export const withEol = (text, eol) => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

/** Line-numbered excerpt (1-based `start`). */
export function numbered(text, start = 1, { width } = {}) {
  const lines = Array.isArray(text) ? text : String(text).split('\n');
  const w = width || String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(w)} | ${l}`).join('\n');
}

const LINE_NUMBER_PREFIX = /^\s*\d+\s?\| ?/;
/** Models sometimes copy "12 | code" prefixes from read_file output into SEARCH/REPLACE. */
function stripCopiedLineNumbers(lines) {
  const nonBlank = lines.filter(l => l.trim());
  if (nonBlank.length < 1 || !nonBlank.every(l => LINE_NUMBER_PREFIX.test(l))) return lines;
  return lines.map(l => l.replace(LINE_NUMBER_PREFIX, ''));
}

function splitLines(text) {
  const lines = toLf(text).split('\n');
  return lines;
}

function trimEdgeBlankLines(lines) {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return { lines: lines.slice(a, b), lead: a, trail: lines.length - b };
}

const leadingWs = s => s.match(/^[ \t]*/)[0];

function firstNonBlank(lines) { return lines.find(l => l.trim()) ?? ''; }

/** Re-indents `repl` lines from the search's base indentation to the found base indentation. */
function reindent(repl, searchLines, foundLines) {
  const sIndent = leadingWs(firstNonBlank(searchLines));
  const cIndent = leadingWs(firstNonBlank(foundLines));
  if (sIndent === cIndent) return repl;
  return repl.map(line => {
    if (!line.trim()) return '';
    if (cIndent.startsWith(sIndent)) return cIndent.slice(sIndent.length) + line;
    if (sIndent.startsWith(cIndent)) {
      const extra = sIndent.length - cIndent.length;
      const ws = leadingWs(line);
      return ws.length >= extra ? line.slice(extra) : line.trimStart();
    }
    if (line.startsWith(sIndent)) return cIndent + line.slice(sIndent.length);
    return cIndent + line.trimStart();
  });
}

// ---- similarity (bigram Dice, cached) ----
const bigramCache = new Map();
function bigrams(s) {
  let m = bigramCache.get(s);
  if (m) return m;
  m = new Map();
  const t = s.length > 400 ? s.slice(0, 400) : s;
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  if (bigramCache.size > 20000) bigramCache.clear();
  bigramCache.set(s, m);
  return m;
}
export function lineSimilarity(a, b) {
  a = a.trim(); b = b.trim();
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const [g, n] of A) { total += n; const m = B.get(g); if (m) inter += Math.min(n, m); }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}
/** Weighted similarity of two equally long line arrays. */
function windowSimilarity(searchLines, contentLines, start) {
  let score = 0, weight = 0;
  for (let i = 0; i < searchLines.length; i++) {
    const s = searchLines[i], c = contentLines[start + i] ?? '';
    const w = Math.max(1, Math.max(s.trim().length, c.trim().length));
    score += lineSimilarity(s, c) * w;
    weight += w;
  }
  return weight ? score / weight : 0;
}

function findLineMatches(contentLines, searchLines, eq) {
  const out = [];
  const n = searchLines.length;
  if (!n || n > contentLines.length) return out;
  outer: for (let i = 0; i + n <= contentLines.length; i++) {
    for (let j = 0; j < n; j++) if (!eq(contentLines[i + j], searchLines[j])) continue outer;
    out.push(i);
    if (out.length > 20) break;
  }
  return out;
}

function countOccurrences(hay, needle, limit = 50) {
  const out = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i >= 0 && out.length < limit) { out.push(i); i = hay.indexOf(needle, i + 1); }
  return out;
}
const lineOfIndex = (text, idx) => text.slice(0, idx).split('\n').length;

/** Finds the best fuzzy window: { start, score, second } */
function bestFuzzyWindow(contentLines, searchLines) {
  const n = searchLines.length;
  let best = { start: -1, score: 0 }, runnerUp = { start: -1, score: 0 };
  if (!n || contentLines.length === 0) return { best, runnerUp };
  const limit = Math.min(contentLines.length, 20000);
  const trimmedSearch = searchLines.map(l => l.trim());
  for (let i = 0; i + n <= limit || (i === 0 && n > limit); i++) {
    // cheap pre-filter: skip windows sharing no characters at all at the anchors
    const score = windowSimilarity(trimmedSearch, contentLines, i);
    if (score > best.score) {
      if (best.start >= 0 && Math.abs(best.start - i) >= n) runnerUp = best;
      best = { start: i, score };
    } else if (score > runnerUp.score && Math.abs(best.start - i) >= n) {
      runnerUp = { start: i, score };
    }
    if (n > limit) break;
  }
  return { best, runnerUp };
}

function candidateSnippet(contentLines, start, n, context = 2) {
  if (start < 0) return '';
  const a = Math.max(0, start - context), b = Math.min(contentLines.length, start + n + context);
  return numbered(contentLines.slice(a, b), a + 1);
}

const ELISION = /^\s*(\/\/|#|\/\*+|<!--|\*|--)?\s*(\.\.\.|…)/;

/**
 * Applies one SEARCH/REPLACE block to LF text.
 * → { ok: true, text, strategy, startLine, endLine (of the replacement in the new text) }
 * | { ok: false, error, candidate? }
 */
export function applyBlock(text, block, { path = '' } = {}) {
  let searchLines = stripCopiedLineNumbers(splitLines(block.search ?? ''));
  let replaceLines = stripCopiedLineNumbers(splitLines(block.replace ?? ''));
  if (searchLines.length && searchLines[searchLines.length - 1] === '' && searchLines.length > 1) searchLines.pop();
  if (replaceLines.length && replaceLines[replaceLines.length - 1] === '') replaceLines.pop();
  const search = searchLines.join('\n');
  const replace = replaceLines.join('\n');

  if (!search.trim()) {
    if (!text.trim()) return { ok: true, text: replace + (replace && !replace.endsWith('\n') ? '\n' : ''), strategy: 'create', startLine: 1, endLine: Math.max(1, replaceLines.length) };
    return { ok: false, error: 'The SEARCH section is empty. To insert code, put an existing anchor line in SEARCH and repeat it in REPLACE together with the new lines (or use write_file to replace the whole file).' };
  }

  // 1 + 2. exact substring (text is already LF-normalized, so CRLF differences are covered here)
  let hits = countOccurrences(text, search);
  if (hits.length === 1) {
    const idx = hits[0];
    let end = idx + search.length;
    let rep = replace;
    // deleting whole lines: also remove the line break so no blank line is left behind
    if (!rep && (idx === 0 || text[idx - 1] === '\n') && text[end] === '\n') end += 1;
    const out = text.slice(0, idx) + rep + text.slice(end);
    const startLine = lineOfIndex(text, idx);
    return { ok: true, text: out, strategy: block.eolNormalized ? 'eol' : 'exact', startLine, endLine: startLine + Math.max(0, replaceLines.length - 1) };
  }
  if (hits.length > 1) {
    const lines = hits.slice(0, 6).map(i => lineOfIndex(text, i));
    return { ok: false, ambiguous: true, error: `The SEARCH text matches ${hits.length} places (starting at lines ${lines.join(', ')}${hits.length > 6 ? ', …' : ''}). Add more surrounding lines to SEARCH so it matches exactly one place.` };
  }

  const contentLines = text.split('\n');
  const edge = trimEdgeBlankLines(searchLines);
  const core = edge.lines;
  let replCore = replaceLines;
  {
    // drop the same edge blank lines from the replacement when it has them too
    let lead = 0; while (lead < edge.lead && replCore[lead] !== undefined && !replCore[lead].trim()) lead++;
    let trail = 0; while (trail < edge.trail && replCore.length - 1 - trail >= lead && !replCore[replCore.length - 1 - trail].trim()) trail++;
    replCore = replCore.slice(lead, replCore.length - trail);
  }

  const replaceWindow = (start, n, lines, strategy) => {
    const out = [...contentLines.slice(0, start), ...lines, ...contentLines.slice(start + n)];
    return { ok: true, text: out.join('\n'), strategy, startLine: start + 1, endLine: start + Math.max(1, lines.length) };
  };

  // 3. trailing-whitespace-insensitive
  let matches = findLineMatches(contentLines, core, (a, b) => a.trimEnd() === b.trimEnd());
  if (matches.length === 1) return replaceWindow(matches[0], core.length, replCore, 'whitespace');
  if (matches.length > 1) return { ok: false, ambiguous: true, error: `The SEARCH lines match ${matches.length} places (lines ${matches.slice(0, 6).map(m => m + 1).join(', ')}). Include more context so the SEARCH is unique.` };

  // 4. indentation-insensitive (re-indent the replacement)
  matches = findLineMatches(contentLines, core, (a, b) => a.trim() === b.trim());
  if (matches.length === 1) {
    const found = contentLines.slice(matches[0], matches[0] + core.length);
    return replaceWindow(matches[0], core.length, reindent(replCore, core, found), 'indentation');
  }
  if (matches.length > 1) return { ok: false, ambiguous: true, error: `Ignoring indentation, the SEARCH lines match ${matches.length} places (lines ${matches.slice(0, 6).map(m => m + 1).join(', ')}). Include more context so the SEARCH is unique.` };

  // 5. fuzzy window
  const elided = core.some(l => ELISION.test(l) && /\.\.\.|…/.test(l) && l.trim().length < 60 && /^\s*(\/\/|#|\/\*|<!--|\*|\.\.\.|…)/.test(l));
  const { best, runnerUp } = bestFuzzyWindow(contentLines, core);
  const nonBlank = core.filter(l => l.trim()).length;
  if (best.start >= 0 && best.score >= FUZZY_THRESHOLD && nonBlank >= 2 && !elided) {
    const ambiguous = runnerUp.start >= 0 && runnerUp.score >= Math.max(FUZZY_THRESHOLD, best.score - 0.02);
    if (!ambiguous) {
      const found = contentLines.slice(best.start, best.start + core.length);
      return replaceWindow(best.start, core.length, reindent(replCore, core, found), 'fuzzy');
    }
  }
  const pct = Math.round(best.score * 100);
  const snippet = candidateSnippet(contentLines, best.start, core.length);
  let error = 'The SEARCH text was not found in the file.';
  if (elided) error += ' It contains an elision ("..."); SEARCH must contain the exact lines from the file, without "..." placeholders.';
  if (snippet && best.score >= 0.5) error += ` The closest match (${pct}% similar) is at lines ${best.start + 1}-${best.start + core.length}:\n${snippet}\nCopy the exact current lines from the file (re-read it if unsure) and retry this block.`;
  else error += ' Nothing in the file is similar — re-read the file to see its current content before retrying.';
  return { ok: false, error, candidate: snippet ? { startLine: best.start + 1, endLine: best.start + core.length, score: best.score, snippet } : null };
}

/**
 * Applies SEARCH/REPLACE blocks in order to `content` (any line endings; the result keeps the file's EOL).
 * Successful blocks are applied even when others fail — the caller reports the failures precisely.
 * → { content, changed, applied: [{index, strategy, startLine, endLine}], failed: [{index, error, candidate}] }
 */
export function applyBlocks(content, blocks, { path = '' } = {}) {
  const eol = detectEol(content);
  const hadCR = /\r/.test(content);
  let text = toLf(content);
  const applied = [], failed = [];
  blocks.forEach((block, index) => {
    const r = applyBlock(text, { ...block, eolNormalized: hadCR }, { path });
    if (r.ok) {
      applied.push({ index, strategy: r.strategy, startLine: r.startLine, endLine: r.endLine });
      // later blocks shift the line numbers of earlier ones; keep them accurate relative to the final text
      const delta = r.text.split('\n').length - text.split('\n').length;
      for (const a of applied.slice(0, -1)) if (a.startLine > r.startLine) { a.startLine += delta; a.endLine += delta; }
      text = r.text;
    } else {
      failed.push({ index, error: r.error, candidate: r.candidate || null, ambiguous: !!r.ambiguous });
    }
  });
  const out = withEol(text, eol);
  return { content: out, changed: out !== content, applied, failed };
}

// ---- line diff ----

/** Real added/removed line counts between two texts (LCS on lines, bounded work). */
export function lineDiffStats(a = '', b = '') {
  if (a === b) return { added: 0, removed: 0 };
  const A = a === '' ? [] : toLf(a).replace(/\n$/, '').split('\n');
  const B = b === '' ? [] : toLf(b).replace(/\n$/, '').split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const x = A.slice(s, ea), y = B.slice(s, eb);
  if (!x.length || !y.length) return { added: y.length, removed: x.length };
  if (x.length * y.length > 4_000_000) {
    // approximate with multiset difference for huge rewrites
    const counts = new Map();
    for (const l of x) counts.set(l, (counts.get(l) || 0) + 1);
    let common = 0;
    for (const l of y) { const c = counts.get(l); if (c) { common++; counts.set(l, c - 1); } }
    return { added: y.length - common, removed: x.length - common };
  }
  let prev = new Uint32Array(y.length + 1), cur = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[y.length];
  return { added: y.length - lcs, removed: x.length - lcs };
}

// ---- globs / ignore files ----

/** gitignore-style glob → RegExp over a relative path. */
export function globToRegExp(glob) {
  let g = String(glob).trim();
  let anchored = false;
  if (g.startsWith('/')) { anchored = true; g = g.slice(1); }
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  if (g.includes('/')) anchored = true;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) { re += `(?:${g.slice(i + 1, end).split(',').map(escapeRe).join('|')})`; i = end; }
      else re += '\\{';
    } else if (c === '[') {
      const end = g.indexOf(']', i);
      if (end > i) { re += `[${g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; }
      else re += '\\[';
    } else re += escapeRe(c);
  }
  // a pattern also matches everything inside a matching folder
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${re}(?:/.*)?$`, 'i');
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

/** Compiles .aiignore / .gitignore text → (path) => boolean (true = ignored). Supports ! negation. */
export function compileIgnore(text = '') {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    try { rules.push({ negate, re: globToRegExp(negate ? line.slice(1) : line) }); } catch {}
  }
  return path => {
    let ignored = false;
    for (const r of rules) if (r.re.test(path)) ignored = !r.negate;
    return ignored;
  };
}

/** Comma/space separated include globs → predicate (null when empty). */
export function includeMatcher(include = '') {
  const parts = String(include || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const res = parts.map(p => globToRegExp(p));
  return path => res.some(re => re.test(path));
}

// ---- lazy placeholder detection ----

const PROSE_EXT = /\.(md|mdx|markdown|txt|rst|csv|log|adoc)$/i;
// languages where a bare "..." line can never be valid code
const STRICT_CODE_EXT = /\.(m?js|cjs|jsx|tsx?|css|scss|less|html?|json|vue|svelte|java|c|h|cpp|hpp|cs|go|rs|swift|kt|php|rb|dart)$/i;
const COMMENT = String.raw`(?:\/\/+|#+|\/\*+|<!--|\{\/\*|--|;+|\*)`;
const PLACEHOLDER_PATTERNS = [
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:\.\.\.|…)?\s*\(?\s*(?:the\s+)?(?:rest|remainder)\s+of\s+(?:the\s+)?(?:code|file|function|component|class|styles?|css|html|markup|content|implementation|logic|methods?|script|page|document)\b`, 'i'),
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:\.\.\.|…)?\s*\(?\s*(?:existing|unchanged|previous|original|other|remaining)\s+(?:code|content|styles?|css|html|markup|functions?|methods?|logic|implementation|properties|rules|imports|components?|lines|sections?|items|elements)\b`, 'i'),
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:\.\.\.|…)\s*(?:same|unchanged|as before|keep|existing)\b`, 'i'),
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:code|content|everything|styles?|the rest)\s+(?:above|below|here)?\s*(?:remains?|stays?|is|are)\s+(?:the\s+same|unchanged|as\s+(?:before|is))`, 'i'),
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:\.\.\.|…)\s*(?:\*\/|-->|\*\/\})?\s*$`)
];

/** Returns { line, text } of the first lazy elision placeholder in code, or null. */
export function findPlaceholder(text = '', path = '') {
  if (PROSE_EXT.test(path)) return null;
  const lines = toLf(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 160) continue;
    if (PLACEHOLDER_PATTERNS.some(re => re.test(l))) return { line: i + 1, text: l.trim() };
    if (/^\s*(\.\.\.|…)\s*$/.test(l) && STRICT_CODE_EXT.test(path)) return { line: i + 1, text: l.trim() };
  }
  return null;
}
