// Small JSON-with-comments parser (the settings.json dialect): // and /* */ comments and trailing
// commas are allowed. Unlike JSON.parse it reports the error offset on every browser (Safari's
// JSON.parse messages carry no position) and records where each top-level key starts.
//
//   parseJsonc(text) → { value, error: null | { message, offset }, keys: [{ key, offset, valueOffset, end }] }

export function parseJsonc(text = '') {
  let i = 0;
  const n = text.length;
  const keys = [];
  const fail = (message, at = i) => { const e = new Error(message); e.offset = Math.min(at, n); throw e; };

  function ws() {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') i++;
      else if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; }
      else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('Unexpected end of comment.', i);
        i = end + 2;
      } else return;
    }
  }

  function string() {
    const start = i;
    i++;
    for (;;) {
      if (i >= n) fail('Unexpected end of string.', start);
      const c = text[i];
      if (c === '"') { i++; break; }
      if (c === '\n' || c === '\r') fail('Unexpected end of string.', start);
      if (c === '\\') i += 2; else i++;
    }
    try { return JSON.parse(text.slice(start, i)); }
    catch { fail('Invalid escape character in string.', start); }
  }

  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  function number() {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m || !m[0] || m[0] === '-') fail('Invalid number format.');
    i += m[0].length;
    return Number(m[0]);
  }

  function value(depth) {
    ws();
    if (i >= n) fail('Value expected.');
    const c = text[i];
    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    fail('Value expected.');
  }

  function object(depth) {
    i++;
    const out = {};
    for (;;) {
      ws();
      if (text[i] === '}') { i++; return out; }
      if (i >= n) fail('Expected comma or closing brace.');
      if (text[i] !== '"') fail('Property expected. Property names must be double-quoted strings.');
      const keyStart = i;
      const key = string();
      ws();
      if (text[i] !== ':') fail('Colon expected.');
      i++;
      ws();
      const valueOffset = i;
      const v = value(depth + 1);
      if (depth === 0) keys.push({ key, offset: keyStart, valueOffset, end: i });
      out[key] = v;
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return out; }
      fail(i >= n ? 'Expected comma or closing brace.' : 'Comma expected.');
    }
  }

  function array(depth) {
    i++;
    const out = [];
    for (;;) {
      ws();
      if (text[i] === ']') { i++; return out; }
      if (i >= n) fail('Expected comma or closing bracket.');
      out.push(value(depth + 1));
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return out; }
      fail(i >= n ? 'Expected comma or closing bracket.' : 'Comma expected.');
    }
  }

  try {
    ws();
    if (i >= n) return { value: {}, error: null, keys };
    const v = value(0);
    ws();
    if (i < n) fail('End of file expected.');
    return { value: v, error: null, keys };
  } catch (err) {
    return { value: undefined, error: { message: err.message, offset: err.offset ?? i }, keys };
  }
}

/** 1-based line/column of an offset. */
export function lineColOf(text, offset) {
  let line = 1, col = 1;
  for (let k = 0; k < offset && k < text.length; k++) {
    if (text[k] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}
