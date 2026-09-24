// Small DOM toolkit shared by every X Coder module. No framework: plain elements.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Hyperscript element builder.
 *   h('button', { class: 'monaco-button', onclick: fn, title: 'Run', 'aria-label': 'Run' }, codicon('play'), 'Run')
 * attrs: class/className (string|array), style (string|object), dataset (object),
 * on<event> handlers, boolean attributes (true → present, false/null → omitted), anything else → setAttribute.
 * children: strings, numbers, nodes, arrays (flattened), null/undefined/false (skipped).
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = {};
  }
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'style') {
      if (typeof value === 'string') el.style.cssText = value;
      else for (const [k, v] of Object.entries(value)) {
        if (v == null) continue;
        if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v;
      }
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else if (key in el && typeof value !== 'string' && key !== 'list') el[key] = value;
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

/** VS Code icon font element: codicon('files') → <span class="codicon codicon-files"> */
export function codicon(name, extraClass = '') {
  const el = document.createElement('span');
  el.className = `codicon codicon-${name}${extraClass ? ' ' + extraClass : ''}`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}
export function codiconHtml(name, extraClass = '') {
  return `<span class="codicon codicon-${escapeAttr(name)}${extraClass ? ' ' + escapeAttr(extraClass) : ''}" aria-hidden="true"></span>`;
}

/** Renders VS Code label syntax: "$(git-branch) main" → codicon + text (HTML string, escaped). */
export function renderLabelWithIcons(text = '') {
  return String(text).split(/(\$\([a-z0-9-~]+\))/gi).map(part => {
    const m = part.match(/^\$\(([a-z0-9-]+)(~spin)?\)$/i);
    if (m) return codiconHtml(m[1], m[2] ? 'codicon-modifier-spin' : '');
    return escapeHtml(part);
  }).join('');
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const escapeAttr = escapeHtml;

export function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

export function debounce(fn, ms = 150) {
  let t = 0;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

export function throttleRaf(fn) {
  let queued = false, lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

export function uid(prefix = 'id') {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}_${rand[0].toString(36)}${rand[1].toString(36).slice(0, 3)}`;
}

export const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ||
  (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
export const isTouch = () => matchMedia('(hover: none), (pointer: coarse)').matches;
/** Phone-sized layout: narrow viewport. Tablets and desktops get the full VS Code layout. */
export const isPhone = () => matchMedia('(max-width: 700px)').matches;
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * Long-press (touch) → callback(x, y, event). Mouse users get the native contextmenu event instead.
 * Returns a disposer. Cancels on movement > 10px or scroll.
 */
export function onLongPress(el, callback, { delay = 480 } = {}) {
  let timer = 0, sx = 0, sy = 0, fired = false;
  const start = e => {
    if (e.pointerType === 'mouse') return;
    fired = false; sx = e.clientX; sy = e.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; navigator.vibrate?.(8); callback(sx, sy, e); }, delay);
  };
  const cancel = () => { clearTimeout(timer); timer = 0; };
  const move = e => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); };
  const click = e => { if (fired) { e.preventDefault(); e.stopImmediatePropagation(); fired = false; } };
  const ctx = e => { if (e.pointerType !== 'mouse' && fired) e.preventDefault(); };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointermove', move);
  el.addEventListener('click', click, true);
  el.addEventListener('contextmenu', ctx);
  return () => {
    cancel();
    el.removeEventListener('pointerdown', start);
    el.removeEventListener('pointerup', cancel);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('pointerleave', cancel);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('click', click, true);
    el.removeEventListener('contextmenu', ctx);
  };
}

/** Attach both right-click (desktop) and long-press (touch) to the same handler(x, y, event). */
export function onContextMenu(el, handler) {
  const ctx = e => { e.preventDefault(); e.stopPropagation(); handler(e.clientX, e.clientY, e); };
  el.addEventListener('contextmenu', ctx);
  const off = onLongPress(el, handler);
  return () => { el.removeEventListener('contextmenu', ctx); off(); };
}

export function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(ts) {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const hr = Math.round(m / 60); if (hr < 24) return `${hr} hr${hr === 1 ? '' : 's'} ago`;
  const d = Math.round(hr / 24); if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

/** Copy text to the clipboard with a fallback for older iOS webviews. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0', readonly: true });
  ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Opens a native file picker and resolves with the chosen File[] (empty when cancelled). */
export function pickFiles({ accept = '', multiple = true, directory = false, capture = '' } = {}) {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', style: 'position:fixed;left:-9999px;top:0;opacity:0' });
    if (accept) input.accept = accept;
    if (multiple) input.multiple = true;
    if (directory) { input.webkitdirectory = true; input.setAttribute('webkitdirectory', ''); }
    if (capture) input.setAttribute('capture', capture);
    let done = false;
    const finish = files => { if (done) return; done = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

export function isEditableTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Simple fuzzy matcher (VS Code quick-open style). Returns { score, matches:[indices] } or null. */
export function fuzzyMatch(pattern, text) {
  if (!pattern) return { score: 0, matches: [] };
  const p = pattern.toLowerCase(), t = text.toLowerCase();
  const direct = t.indexOf(p);
  if (direct >= 0) {
    const matches = Array.from({ length: p.length }, (_, i) => direct + i);
    const boundary = direct === 0 || /[\s/._\-]/.test(text[direct - 1]) ? 20 : 0;
    return { score: 100 + boundary - direct * 0.5 - t.length * 0.05, matches };
  }
  let ti = 0, score = 0, prev = -2; const matches = [];
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    matches.push(found);
    score += found === prev + 1 ? 6 : 1;
    if (found === 0 || /[\s/._\-]/.test(text[found - 1]) || (text[found] !== t[found])) score += 4;
    prev = found; ti = found + 1;
  }
  return { score: score - t.length * 0.05, matches };
}

/** Highlights matched indices in text (HTML). */
export function highlightMatches(text, matches = []) {
  if (!matches.length) return escapeHtml(text);
  const set = new Set(matches); let out = '', open = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m && !open) { out += '<span class="highlight">'; open = true; }
    if (!m && open) { out += '</span>'; open = false; }
    out += escapeHtml(text[i]);
  }
  if (open) out += '</span>';
  return out;
}
