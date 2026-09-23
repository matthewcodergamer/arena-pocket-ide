// Glob patterns for "files to include" / "files to exclude" and search.exclude, with VS Code's rules:
//   *  any characters except '/'      **  any number of path segments      ?  one character
//   {a,b}  alternatives               [abc] / [!abc]  character classes
//   Patterns are comma-separated. "./src" or "/src" is anchored at the project root; any other pattern
//   matches anywhere ("*.js" → "**/*.js"). A pattern also matches everything inside a matching folder.

function escapeRe(c) { return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

function findClosing(glob, i, open, close) {
  let depth = 0;
  for (let j = i; j < glob.length; j++) {
    if (glob[j] === '\\') { j++; continue; }
    if (glob[j] === open) depth++;
    else if (glob[j] === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

function splitTopLevel(text, sep = ',') {
  const out = []; let depth = 0, cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { cur += c + text[++i]; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Glob → RegExp source (unanchored). */
export function globSource(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) { re += escapeRe(glob[++i]); continue; }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        if (atStart && glob[i + 2] === '/') { re += '(?:[^/]*/)*'; i += 2; continue; }
        re += '.*'; i += 1; continue;
      }
      re += '[^/]*'; continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '{') {
      const end = findClosing(glob, i, '{', '}');
      if (end > i) { re += `(?:${splitTopLevel(glob.slice(i + 1, end)).map(globSource).join('|')})`; i = end; continue; }
    }
    if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end > i) {
        let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (body[0] === '!') body = '^' + body.slice(1);
        re += `[${body}]`; i = end; continue;
      }
    }
    re += escapeRe(c);
  }
  return re;
}

/** Splits a "files to include" string into patterns (commas inside {…} are kept). */
export function parsePatterns(text) {
  return splitTopLevel(String(text || '')).map(s => s.trim()).filter(Boolean);
}

/** One pattern → RegExp that tests a relative path (file or folder prefix). */
export function patternToRegExp(pattern, { caseSensitive = true } = {}) {
  let p = pattern.trim().replace(/\\/g, '/');
  let anchored = false;
  if (p.startsWith('./')) { anchored = true; p = p.slice(2); }
  else if (p.startsWith('/')) { anchored = true; p = p.slice(1); }
  p = p.replace(/\/+$/, '');
  if (!p || p === '.') return /^/; // "./" = everything
  const body = globSource(p);
  const prefix = anchored || p.startsWith('**/') || p.startsWith('**') ? '' : '(?:[^/]*/)*';
  return new RegExp(`^${prefix}${body}(?:/.*)?$`, caseSensitive ? '' : 'i');
}

/** Builds a predicate from a pattern string; null when there are no patterns. */
export function buildMatcher(text, opts) {
  const patterns = Array.isArray(text) ? text : parsePatterns(text);
  if (!patterns.length) return null;
  const res = [];
  for (const p of patterns) { try { res.push(patternToRegExp(p, opts)); } catch {} }
  if (!res.length) return null;
  return path => res.some(re => re.test(path));
}
