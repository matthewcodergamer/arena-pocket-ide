// X Coder agent protocol — the model writes normal Markdown for the user plus XML-style tool tags:
//
//   <read_file path="src/app.js" start_line="1" end_line="200"/>
//   <write_file path="src/new.js">FULL CONTENT</write_file>
//   <edit_file path="src/app.js">
//   <<<<<<< SEARCH
//   old lines
//   =======
//   new lines
//   >>>>>>> REPLACE
//   </edit_file>
//
// Bodies are raw text (no JSON escaping), which is robust for every model. Pure module (no DOM):
//
//   parseAgentOutput(raw) → { text, calls, errors, truncated, truncatedCall, reasoning, legacy, hallucinated }
//   createStreamFilter({ onPending }) → { push(delta) → visibleDelta, finish() → { delta, result }, raw }
//        hides tool tags in real time (partial '<' sequences are buffered so raw tags never flash in the UI)
//   parseEditBlocks(body, path) → { blocks: [{search, replace}], errors }
//   formatToolResult({ name, attrs, ok, content })
//   callSignature(call)                                   stable key for loop detection
//
// Parsing rules: tags inside fenced code blocks are ignored (the model is showing an example) unless the fence
// contains nothing but tool tags (weaker models often wrap their calls in ```xml). A body wrapped in a single
// code fence is unwrapped. CRLF, attribute order, single quotes, unquoted values, self-closing and empty-body
// forms are tolerated. An unclosed <write_file>/<edit_file> at the end marks the output as truncated.
// The legacy X Coder 5 JSON protocol ({message, requests, operations, project_action}) is also accepted.

export const TOOLS = {
  read_file: { kind: 'read', primary: 'path' },
  list_files: { kind: 'read', primary: 'path' },
  search_files: { kind: 'read', primary: 'query' },
  get_problems: { kind: 'read' },
  run_preview: { kind: 'run', primary: 'entry' },
  run_script: { kind: 'run', primary: 'path' },
  get_terminal_output: { kind: 'read' },
  git_diff: { kind: 'read', primary: 'path' },
  view_image: { kind: 'read', primary: 'path' },
  fetch_url: { kind: 'read', primary: 'url' },
  run_command: { kind: 'run', primary: 'command' },
  write_file: { kind: 'edit', body: true },
  edit_file: { kind: 'edit', body: true },
  delete_file: { kind: 'edit', primary: 'path' },
  rename_file: { kind: 'edit' },
  create_folder: { kind: 'edit', primary: 'path' },
  create_project: { kind: 'project', primary: 'name' },
  generate_image: { kind: 'edit', primary: 'prompt' }
};

/** Tag names other models commonly invent → canonical tool. */
export const ALIASES = {
  create_file: 'write_file', update_file: 'write_file', replace_file: 'write_file', overwrite_file: 'write_file',
  replace_in_file: 'edit_file', apply_diff: 'edit_file', patch_file: 'edit_file', search_replace: 'edit_file', modify_file: 'edit_file',
  move_file: 'rename_file', rename_path: 'rename_file', remove_file: 'delete_file',
  list_directory: 'list_files', list_dir: 'list_files', grep_search: 'search_files', search_code: 'search_files',
  execute_command: 'run_command', run_terminal_command: 'run_command', open_file: 'read_file', view_file: 'read_file'
};

const HIDDEN = ['think', 'thinking'];
const RESULT_TAG = 'tool_result';
const ALL_NAMES = [...Object.keys(TOOLS), ...Object.keys(ALIASES), ...HIDDEN, RESULT_TAG].sort((a, b) => b.length - a.length);
const TAG_RE = new RegExp(`<(${ALL_NAMES.join('|')})(?=[\\s/>])`, 'gi');
const STRAY_CLOSE_RE = new RegExp(`</(?:${ALL_NAMES.join('|')})\\s*>`, 'gi');
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm;
const TOOL_FENCE_LANGS = new Set(['', 'xml', 'html', 'tool', 'tools', 'xcoder', 'text', 'plaintext']);

export const canonicalName = name => {
  const n = String(name || '').toLowerCase();
  return ALIASES[n] || n;
};
export const isEditTool = name => ['edit', 'project'].includes(TOOLS[canonicalName(name)]?.kind);
export const isReadOnlyTool = name => TOOLS[canonicalName(name)]?.kind === 'read';

const toLf = s => String(s ?? '').replace(/\r\n?/g, '\n');

function decodeEntities(s) {
  return s.replace(/&(quot|apos|lt|gt|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[name.toLowerCase()] ?? m;
  });
}

const COMMON_ATTRS = {
  file: 'path', filename: 'path', file_path: 'path', filepath: 'path', target_file: 'path',
  start: 'start_line', from_line: 'start_line', line_start: 'start_line', startline: 'start_line',
  end: 'end_line', to_line: 'end_line', line_end: 'end_line', endline: 'end_line'
};
const TOOL_ATTRS = {
  search_files: { pattern: 'query', text: 'query', q: 'query', glob: 'include', file_pattern: 'include', is_regex: 'regex', regexp: 'regex', directory: 'path', dir: 'path' },
  list_files: { directory: 'path', dir: 'path', folder: 'path' },
  run_command: { cmd: 'command' },
  fetch_url: { href: 'url', link: 'url', src: 'url' },
  view_image: { src: 'path' },
  rename_file: { path: 'from', old_path: 'from', source: 'from', src: 'from', new_path: 'to', dest: 'to', destination: 'to', target: 'to', new_name: 'to' },
  generate_image: { description: 'prompt', text: 'prompt' },
  create_project: { title: 'name', project: 'name' }
};
function normalizeAttrs(tool, attrs) {
  const out = {};
  const special = TOOL_ATTRS[tool] || {};
  for (const [k0, v] of Object.entries(attrs)) {
    const k1 = k0.toLowerCase();
    const k = special[k1] || COMMON_ATTRS[k1] || k1;
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Parses attributes starting right after the tag name. → { attrs, end, selfClosing } | null (incomplete) */
function parseOpenTag(text, i) {
  const attrs = {};
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) return null;
    if (text[i] === '>') return { attrs, end: i + 1, selfClosing: false };
    if (text[i] === '/') {
      let j = i + 1; while (j < n && /\s/.test(text[j])) j++;
      if (j >= n) return null;
      if (text[j] === '>') return { attrs, end: j + 1, selfClosing: true };
      i = j; continue;
    }
    const m = /^([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 64));
    if (!m) { i++; continue; } // skip junk characters
    const name = m[1];
    i += name.length;
    while (i < n && /[ \t]/.test(text[i])) i++;
    if (i >= n) return null;
    if (text[i] !== '=') { attrs[name] = 'true'; continue; }
    i++;
    while (i < n && /[ \t]/.test(text[i])) i++;
    if (i >= n) return null;
    const q = text[i];
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, i + 1);
      if (close < 0) return null;
      attrs[name] = decodeEntities(text.slice(i + 1, close));
      i = close + 1;
    } else {
      let j = i;
      while (j < n && !/[\s>]/.test(text[j])) j++;
      if (j >= n) return null;
      let v = text.slice(i, j);
      if (v.endsWith('/') && text[j] === '>') { attrs[name] = decodeEntities(v.slice(0, -1)); return { attrs, end: j + 1, selfClosing: true }; }
      attrs[name] = decodeEntities(v);
      i = j;
    }
  }
  return null;
}

function findClose(text, name, from) {
  const re = new RegExp(`</${name}\\s*>`, 'ig');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

/** Next tag start at/after pos that is not inside inline code (`<tag>`). */
function nextTag(text, pos) {
  TAG_RE.lastIndex = pos;
  let m;
  while ((m = TAG_RE.exec(text))) {
    if (m.index > 0 && text[m.index - 1] === '`') continue;
    return { index: m.index, name: m[1].toLowerCase() };
  }
  return null;
}

function nextFence(text, pos) {
  FENCE_RE.lastIndex = pos;
  let m;
  while ((m = FENCE_RE.exec(text))) {
    if (m[1][0] === '`' && m[2].includes('`')) continue; // not a valid backtick fence opener
    return { index: m.index, marker: m[1], info: m[2].trim(), lineEnd: m.index + m[0].length };
  }
  return null;
}

/** → { contentStart, contentEnd, end } or null when unclosed. */
function fenceClose(text, fence) {
  const contentStart = fence.lineEnd + 1;
  if (contentStart > text.length) return null;
  const ch = fence.marker[0];
  const re = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${fence.marker.length},}[ \\t]*$`, 'gm');
  re.lastIndex = contentStart;
  const m = re.exec(text);
  if (!m) return null;
  return { contentStart, contentEnd: Math.max(contentStart, m.index - 1), end: Math.min(text.length, m.index + m[0].length + 1) };
}

function unwrapFence(body) {
  const m = /^\s*(`{3,}|~{3,})[^\n`]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*\s*$/.exec(body);
  return m ? m[2] : body;
}

function trimBody(body) {
  let b = body;
  if (b.startsWith('\n')) b = b.slice(1);
  else if (/^[ \t]+\n/.test(b)) b = b.replace(/^[ \t]+\n/, '');
  if (b.endsWith('\n')) b = b.slice(0, -1);
  return b;
}

let callCounter = 0;
function makeCall(rawName, attrs, body, source = 'tags') {
  const name = canonicalName(rawName);
  const spec = TOOLS[name];
  const a = normalizeAttrs(name, attrs || {});
  let b = body;
  if (b != null && spec?.body) {
    b = unwrapFence(trimBody(toLf(b)));
  }
  if (spec?.primary && a[spec.primary] == null && b != null && !spec.body && b.trim()) a[spec.primary] = b.trim();
  const call = { id: `call_${Date.now().toString(36)}_${(++callCounter).toString(36)}`, name, attrs: a, body: spec?.body ? (b ?? '') : null, source };
  if (name === 'edit_file' && source === 'tags') {
    const parsed = parseEditBlocks(call.body, a.path);
    call.blocks = parsed.blocks;
    call.blockErrors = parsed.errors;
  }
  return call;
}

function looksLikeToolStart(s) {
  if (!s.startsWith('<')) return false;
  const frag = s.slice(0, 40).toLowerCase();
  return ALL_NAMES.some(n => frag.startsWith(`<${n}`) || `<${n}`.startsWith(frag.split(/[\s/>]/)[0]));
}

/** Could `frag` (text from a trailing '<') still grow into a known tag? */
function isPartialTag(frag) {
  const f = frag.toLowerCase();
  if (f === '<' || f === '</') return true;
  const m = /^<\/?([a-z_]*)$/.exec(f);
  if (!m) return false;
  return ALL_NAMES.some(n => n.startsWith(m[1]));
}

/**
 * Core scanner. `final` = the text is complete (otherwise uncertain trailing structures are held back).
 * → { parts: [{text, code}], calls, errors, reasoning: [], truncated, truncatedCall, pending, hallucinated }
 */
function scan(src, final) {
  const text = toLf(src);
  const out = { parts: [], calls: [], errors: [], reasoning: [], truncated: false, truncatedCall: null, pending: null, hallucinated: false };
  let pos = 0;
  const pushText = (s, code = false) => { if (s) out.parts.push({ text: s, code }); };
  while (pos < text.length) {
    const f = nextFence(text, pos);
    const t = nextTag(text, pos);
    if (!f && !t) {
      let rest = text.slice(pos);
      if (!final) {
        const lt = rest.lastIndexOf('<');
        if (lt >= 0 && isPartialTag(rest.slice(lt))) rest = rest.slice(0, lt);
        // a trailing partial fence marker ("`", "``", "~~") could still become a fence
        const lastNl = rest.lastIndexOf('\n');
        const lastLine = rest.slice(lastNl + 1);
        if (/^ {0,3}(`{1,2}|~{1,2})$/.test(lastLine)) rest = rest.slice(0, lastNl + 1);
      }
      pushText(rest);
      break;
    }
    if (f && (!t || f.index <= t.index)) {
      pushText(text.slice(pos, f.index));
      const close = fenceClose(text, f);
      if (!close) {
        const contentStart = f.lineEnd + 1;
        const content = contentStart <= text.length ? text.slice(contentStart) : '';
        const trimmed = content.trimStart();
        if (!final) {
          if (contentStart > text.length || !trimmed || looksLikeToolStart(trimmed)) { out.pending = out.pending || { name: 'fence' }; break; }
          pushText(text.slice(f.index), true);
          break;
        }
        if (TOOL_FENCE_LANGS.has(f.info.toLowerCase()) && looksLikeToolStart(trimmed)) {
          const sub = scan(content, true);
          mergeSub(out, sub);
          if (sub.parts.some(p => p.text.trim())) out.parts.push(...sub.parts);
        } else pushText(text.slice(f.index), true);
        break;
      }
      const inner = text.slice(close.contentStart, close.contentEnd);
      const innerTrim = inner.trim();
      if (TOOL_FENCE_LANGS.has(f.info.toLowerCase()) && looksLikeToolStart(innerTrim)) {
        const sub = scan(inner, true);
        const leftover = sub.parts.map(p => p.text).join('').replace(STRAY_CLOSE_RE, '').trim();
        if (sub.calls.length && !leftover) { mergeSub(out, sub); pos = close.end; continue; }
      }
      pushText(text.slice(f.index, close.end), true);
      pos = close.end;
      continue;
    }
    // tool tag
    pushText(text.slice(pos, t.index));
    const rawName = t.name;
    if (rawName === RESULT_TAG) {
      // The model is inventing tool results: everything from here on is fiction.
      out.hallucinated = true;
      if (!final) out.pending = { name: RESULT_TAG };
      break;
    }
    const open = parseOpenTag(text, t.index + 1 + rawName.length);
    const name = canonicalName(rawName);
    const spec = TOOLS[name];
    if (!open) {
      if (!final) { out.pending = { name, attrs: {} }; break; }
      if (spec?.body) { out.truncated = true; out.truncatedCall = { name, attrs: {} }; }
      else out.errors.push(`Malformed <${rawName}> tag (missing ">").`);
      break;
    }
    if (HIDDEN.includes(rawName)) {
      if (open.selfClosing) { pos = open.end; continue; }
      const c = findClose(text, rawName, open.end);
      if (!c) { if (final) out.reasoning.push(text.slice(open.end).trim()); else out.pending = { name: rawName }; break; }
      out.reasoning.push(text.slice(open.end, c.index).trim());
      pos = c.end;
      continue;
    }
    if (open.selfClosing) { out.calls.push(makeCall(rawName, open.attrs, null)); pos = open.end; continue; }
    if (spec?.body) {
      const c = findClose(text, rawName, open.end);
      if (!c) {
        const attrs = normalizeAttrs(name, open.attrs);
        if (!final) { out.pending = { name, attrs }; break; }
        out.truncated = true;
        out.truncatedCall = { name, attrs, partialLength: text.length - open.end };
        break;
      }
      out.calls.push(makeCall(rawName, open.attrs, text.slice(open.end, c.index)));
      pos = c.end;
      continue;
    }
    // A non-body tool written with an open tag: accept a nearby closing tag (body = primary argument).
    const c = findClose(text, rawName, open.end);
    const nt = nextTag(text, open.end);
    const nextIdx = nt ? nt.index : Infinity;
    if (c && c.index < nextIdx && c.index - open.end <= 4000) {
      out.calls.push(makeCall(rawName, open.attrs, text.slice(open.end, c.index)));
      pos = c.end;
      continue;
    }
    if (!final && !c && nextIdx === Infinity && text.length - open.end <= 4000) { out.pending = { name, attrs: normalizeAttrs(name, open.attrs) }; break; }
    out.calls.push(makeCall(rawName, open.attrs, null));
    pos = open.end;
  }
  return out;
}

function mergeSub(out, sub) {
  out.calls.push(...sub.calls);
  out.errors.push(...sub.errors);
  out.reasoning.push(...sub.reasoning);
  if (sub.truncated) { out.truncated = true; out.truncatedCall = sub.truncatedCall; }
  if (sub.hallucinated) out.hallucinated = true;
}

function visibleText(parts) {
  const s = parts.map(p => (p.code ? p.text : p.text.replace(STRAY_CLOSE_RE, ''))).join('');
  return s.replace(/[ \t]+\n/g, m => (m.includes('\n') ? '\n' : m)).replace(/\n{3,}/g, '\n\n').trim();
}

// ---- legacy X Coder 5 JSON protocol ----

const LEGACY_KEYS = ['message', 'requests', 'operations', 'project_action', 'reasoning_summary'];
const TEXT_KEYS = ['message', 'response', 'reply', 'answer', 'text', 'content'];

function extractJsonObject(raw) {
  let s = String(raw).trim();
  const fenced = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(s);
  if (fenced) s = fenced[1].trim();
  if (!s.startsWith('{')) return null;
  const tryParse = str => { try { const v = JSON.parse(str); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  let obj = tryParse(s);
  if (!obj) { const end = s.lastIndexOf('}'); if (end > 0) obj = tryParse(s.slice(0, end + 1)); }
  if (!obj) obj = tryParse(s.replace(/,\s*([}\]])/g, '$1'));
  return obj;
}

/** → { message, calls, errors, reasoning } or null when `raw` is not a legacy JSON reply. */
export function parseLegacyJSON(raw) {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  const keys = Object.keys(obj);
  const isLegacy = keys.some(k => LEGACY_KEYS.includes(k)) || (keys.length <= 3 && keys.some(k => TEXT_KEYS.includes(k) && typeof obj[k] === 'string'));
  if (!isLegacy) return null;
  const calls = [], errors = [];
  const pa = obj.project_action;
  if (pa && typeof pa === 'object' && /create/i.test(pa.type || 'create_project') && (pa.name || pa.title)) {
    calls.push(makeCall('create_project', { name: String(pa.name || pa.title), template: String(pa.template || 'blank') }, null, 'legacy'));
  }
  for (const r of Array.isArray(obj.requests) ? obj.requests : []) {
    const tool = String(r?.tool || r?.type || '').toLowerCase();
    if (/^(read|read_file|open_file|view_file|get_file)$/.test(tool)) calls.push(makeCall('read_file', { path: r.path || r.file }, null, 'legacy'));
    else if (/^(search|search_files|grep|find)$/.test(tool)) calls.push(makeCall('search_files', { query: r.query || r.pattern || '', path: r.path || '' }, null, 'legacy'));
    else if (/^(list|list_files|ls|tree)$/.test(tool)) calls.push(makeCall('list_files', { path: r.path || '' }, null, 'legacy'));
    else if (/console|problem|diagnostic|error/.test(tool)) calls.push(makeCall('get_problems', {}, null, 'legacy'));
    else if (/preview|run/.test(tool)) calls.push(makeCall('run_preview', { entry: r.path || r.entry || '' }, null, 'legacy'));
    else if (tool && TOOLS[canonicalName(tool)]) calls.push(makeCall(tool, { ...r }, null, 'legacy'));
    else errors.push(`Unknown legacy request tool "${tool}".`);
  }
  for (const op of Array.isArray(obj.operations) ? obj.operations : []) {
    const type = String(op?.type || '').toLowerCase();
    const path = op?.path || op?.file;
    if (type === 'create_file' || type === 'replace_file' || type === 'write_file') {
      const c = makeCall('write_file', { path }, null, 'legacy');
      c.body = toLf(op.content ?? '');
      calls.push(c);
    } else if (type === 'patch_file' || type === 'edit_file') {
      const c = makeCall('edit_file', { path }, null, 'legacy');
      c.body = '';
      c.blocks = (Array.isArray(op.changes) ? op.changes : []).map(ch => ({ search: toLf(ch?.find ?? ch?.search ?? ''), replace: toLf(ch?.replace ?? '') }));
      c.blockErrors = c.blocks.length ? [] : ['patch_file has no changes.'];
      calls.push(c);
    } else if (type === 'delete_file' || type === 'delete_path') calls.push(makeCall('delete_file', { path }, null, 'legacy'));
    else if (type === 'rename_path' || type === 'move_path' || type === 'rename_file') calls.push(makeCall('rename_file', { from: path, to: op.to || op.newPath || op.new_path }, null, 'legacy'));
    else if (type === 'create_folder' || type === 'mkdir') calls.push(makeCall('create_folder', { path }, null, 'legacy'));
    else errors.push(`Unknown legacy operation "${type}".`);
  }
  let message = '';
  for (const k of TEXT_KEYS) if (typeof obj[k] === 'string') { message = obj[k]; break; }
  const reasoning = Array.isArray(obj.reasoning_summary) ? obj.reasoning_summary.map(String) : typeof obj.reasoning_summary === 'string' ? [obj.reasoning_summary] : [];
  return { message: toLf(message), calls, errors, reasoning };
}

const LEGACY_START = /^\s*(```(?:json)?\s*)?\{/i;

/** Parses a complete model reply. */
export function parseAgentOutput(raw) {
  const legacy = LEGACY_START.test(raw) ? parseLegacyJSON(raw) : null;
  if (legacy) {
    // Forced-JSON models may still embed tool tags inside the message text.
    const inner = scan(legacy.message, true);
    return {
      text: visibleText(inner.parts),
      calls: [...legacy.calls, ...inner.calls],
      errors: [...legacy.errors, ...inner.errors],
      truncated: inner.truncated, truncatedCall: inner.truncatedCall,
      reasoning: [...legacy.reasoning, ...inner.reasoning].filter(Boolean).join('\n\n'),
      legacy: true, hallucinated: inner.hallucinated
    };
  }
  const s = scan(raw, true);
  return {
    text: visibleText(s.parts), calls: s.calls, errors: s.errors,
    truncated: s.truncated, truncatedCall: s.truncatedCall,
    reasoning: s.reasoning.filter(Boolean).join('\n\n'), legacy: false, hallucinated: s.hallucinated
  };
}

/**
 * Incremental visible-text filter for streaming. push() returns only text that can never be retracted:
 * anything that might still become a tool tag, a hidden fence or a legacy JSON reply is held back.
 */
export function createStreamFilter({ onPending, minInterval = 40 } = {}) {
  let raw = '', emitted = '', lastScanLen = 0, lastScanAt = 0, pendingKey = '';
  const report = pending => {
    const key = pending ? `${pending.name}:${pending.attrs?.path || pending.attrs?.from || ''}` : '';
    if (key !== pendingKey) { pendingKey = key; try { onPending?.(pending || null); } catch {} }
  };
  const diff = visible => {
    if (visible.startsWith(emitted)) { const d = visible.slice(emitted.length); emitted = visible; return d; }
    return '';
  };
  return {
    get raw() { return raw; },
    get emitted() { return emitted; },
    push(delta) {
      if (!delta) return '';
      raw += delta;
      const now = Date.now();
      if (raw.length - lastScanLen < 48 && now - lastScanAt < minInterval && !/[\n>]/.test(delta)) return '';
      lastScanLen = raw.length; lastScanAt = now;
      if (LEGACY_START.test(raw)) { report({ name: 'json' }); return ''; }
      const s = scan(raw, false);
      report(s.pending);
      return diff(visibleText(s.parts));
    },
    finish() {
      const result = parseAgentOutput(raw);
      report(null);
      return { delta: diff(result.text), result };
    }
  };
}

// ---- SEARCH/REPLACE blocks ----

const SEARCH_RE = /^\s*[<-]{5,9}\s*(SEARCH|ORIGINAL|FIND)\b.*$/i;
const DIVIDER_RE = /^\s*={5,9}\s*$/;
const REPLACE_RE = /^\s*[>+]{5,9}\s*(REPLACE|UPDATED|REPLACEMENT)\b.*$/i;

function stripSectionFence(lines, path) {
  if (/\.(md|mdx|markdown)$/i.test(path || '')) return lines;
  if (lines.length >= 2 && /^\s*(`{3,}|~{3,})[\w+-]*\s*$/.test(lines[0]) && /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1])) return lines.slice(1, -1);
  return lines;
}

/** Parses SEARCH/REPLACE blocks from an edit_file body. */
export function parseEditBlocks(body, path = '') {
  const lines = toLf(unwrapFence(body || '')).split('\n');
  const blocks = [], errors = [];
  let state = 'outside', search = [], replace = [];
  const push = () => {
    blocks.push({ search: stripSectionFence(search, path).join('\n'), replace: stripSectionFence(replace, path).join('\n') });
    search = []; replace = [];
  };
  for (const line of lines) {
    if (state === 'outside') {
      if (SEARCH_RE.test(line)) { state = 'search'; search = []; replace = []; }
      else if (DIVIDER_RE.test(line) || REPLACE_RE.test(line)) errors.push(`Block ${blocks.length + 1}: found "${line.trim()}" without a preceding "<<<<<<< SEARCH" line.`);
      continue;
    }
    if (state === 'search') {
      if (DIVIDER_RE.test(line)) { state = 'replace'; continue; }
      if (REPLACE_RE.test(line)) { errors.push(`Block ${blocks.length + 1}: missing the "=======" divider between SEARCH and REPLACE.`); state = 'outside'; continue; }
      search.push(line);
      continue;
    }
    // replace
    if (REPLACE_RE.test(line)) { push(); state = 'outside'; continue; }
    if (SEARCH_RE.test(line)) { push(); state = 'search'; continue; } // forgot ">>>>>>> REPLACE"
    replace.push(line);
  }
  if (state === 'replace') {
    while (replace.length && !replace[replace.length - 1].trim()) replace.pop();
    push();
  } else if (state === 'search') errors.push(`Block ${blocks.length + 1} is incomplete (no "=======" and ">>>>>>> REPLACE").`);
  if (!blocks.length && !errors.length) {
    errors.push((body || '').trim()
      ? 'edit_file needs one or more <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks. To replace the whole file use write_file instead.'
      : 'edit_file is empty.');
  }
  return { blocks, errors };
}

// ---- helpers for the agent loop ----

const escAttr = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function formatToolResult({ name, attrs = {}, ok = true, content = '' }) {
  const keys = ['path', 'from', 'to', 'query', 'entry', 'url', 'command', 'start_line', 'end_line', 'name'];
  const attrStr = keys.filter(k => attrs[k] != null && attrs[k] !== '').map(k => ` ${k}="${escAttr(String(attrs[k]).slice(0, 200))}"`).join('');
  return `<tool_result name="${name}"${attrStr} status="${ok ? 'ok' : 'error'}">\n${String(content).replace(/<\/tool_result>/g, '<\\/tool_result>')}\n</tool_result>`;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
export function callSignature(call) {
  const attrs = Object.keys(call.attrs || {}).sort().map(k => `${k}=${call.attrs[k]}`).join('&');
  const body = call.blocks ? JSON.stringify(call.blocks) : call.body || '';
  return `${call.name}?${attrs}#${hash(body)}`;
}
