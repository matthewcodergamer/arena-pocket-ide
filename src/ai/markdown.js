// Chat markdown: marked → DOMPurify (own instance: no scripts, styles, event handlers, iframes, forms or remote
// images; links open in a new tab) → VS Code chat code blocks with a toolbar (Copy, Insert at Cursor,
// Apply in Editor, Insert into New File, Run in Terminal) and static syntax highlighting.
//
//   renderMarkdownInto(el, text, { streaming })   incremental: unchanged top-level blocks keep their DOM
//   renderMarkdown(text) → element                 one-shot
//   codeBlockActions                               the toolbar actions (used by tests and the chat view)
//
// Rendering is incremental so streamed answers do not flicker and finished code blocks stay tappable.

import { Marked, DOMPurify } from '../../vendor/markdown.js';
import { h, escapeHtml, copyText, uid } from '../core/dom.js';
import { posix, validatePath } from '../core/path.js';
import { workspace } from '../core/workspace.js';
import { output } from '../core/output.js';

const log = output.channel('X Coder AI');
const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'shellsession', 'terminal', 'powershell', 'ps1', 'cmd', 'bat']);
const LANG_LABELS = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', md: 'markdown', yml: 'yaml', rb: 'ruby', rs: 'rust', kt: 'kotlin', cs: 'csharp', 'c++': 'cpp', htm: 'html', jsx: 'javascriptreact', tsx: 'typescriptreact' };
const EXT_FOR_LANG = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', html: 'html', css: 'css', json: 'json', markdown: 'md', md: 'md', shell: 'sh', bash: 'sh', sh: 'sh', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', rust: 'rs', ruby: 'rb', php: 'php', swift: 'swift', kotlin: 'kt', sql: 'sql', yaml: 'yml', yml: 'yml', xml: 'xml', jsx: 'jsx', tsx: 'tsx', scss: 'scss', less: 'less', vue: 'vue', svelte: 'svelte', lua: 'lua', dart: 'dart', r: 'r', toml: 'toml' };

// ------------------------------------------------------------------ parser + sanitizer

function parseInfo(info = '') {
  const parts = String(info).trim().split(/\s+/).filter(Boolean);
  let lang = parts[0] || '';
  let path = '';
  // ```js src/app.js   ·   ```src/app.js   ·   ```js title="src/app.js"   ·   ```js:src/app.js
  const colon = lang.match(/^([\w+#-]+):(.+)$/);
  if (colon) { lang = colon[1]; path = colon[2]; }
  for (const p of parts.slice(1)) {
    const m = p.match(/^(?:title|file|path|filename)=["']?([^"']+)["']?$/i);
    if (m) { path = m[1]; break; }
    if (!path && /[./]/.test(p) && !/^\d/.test(p)) path = p;
  }
  if (!path && /[./]/.test(lang) && /\.\w+$/.test(lang)) { path = lang; lang = posix.ext(lang).slice(1); }
  path = path.replace(/^\.?\//, '');
  try { if (path) validatePath(path); } catch { path = ''; }
  return { lang: lang.toLowerCase(), path };
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code(token) {
      const { lang, path } = parseInfo(token.lang || '');
      return `<pre data-code-lang="${escapeHtml(lang)}" data-code-path="${escapeHtml(path)}"><code>${escapeHtml(String(token.text ?? '').replace(/\n$/, ''))}</code></pre>\n`;
    }
  }
});

let purify = null;
function sanitizer() {
  if (purify) return purify;
  purify = DOMPurify(window); // private instance: hooks here never affect other features
  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'img') {
      const src = node.getAttribute?.('src') || '';
      if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) {
        // remote images would leak the user's IP / enable tracking: show them as links instead
        const a = node.ownerDocument.createElement('a');
        a.setAttribute('href', src);
        a.textContent = node.getAttribute('alt') || src || 'image';
        node.replaceWith(a);
      }
    }
  });
  purify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
      else if (href && !href.startsWith('#')) node.setAttribute('data-file-link', href);
    }
    if (node.tagName === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') node.remove();
      else node.setAttribute('disabled', '');
    }
  });
  return purify;
}

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base', 'svg', 'math', 'video', 'audio', 'source', 'track', 'dialog', 'template', 'noscript'],
  FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset', 'formaction', 'action', 'background', 'ping'],
  ALLOW_DATA_ATTR: true,
  ADD_ATTR: ['target', 'rel']
};

export function markdownToSafeHtml(text) {
  let html = '';
  try { html = marked.parse(String(text ?? ''), { async: false }); }
  catch (err) { html = `<p>${escapeHtml(String(text ?? ''))}</p>`; log.warn('Markdown render failed', err); }
  return sanitizer().sanitize(html, PURIFY_CONFIG);
}

/** Streaming: close an unterminated code fence so partial code renders as a code block. */
function balanceFences(text) {
  const fences = String(text).match(/^\s{0,3}(```|~~~)/gm) || [];
  return fences.length % 2 ? `${text}\n\`\`\`` : text;
}

// ------------------------------------------------------------------ highlighting

const hlCache = new Map();
async function highlight(code, lang) {
  const key = `${lang}\u0000${code}`;
  if (hlCache.has(key)) return hlCache.get(key);
  let html = null;
  try {
    const { codeEditor } = await import('../editor/api.js');
    html = await codeEditor.highlightCode(code, lang || 'text');
  } catch { html = null; }
  if (hlCache.size > 300) hlCache.delete(hlCache.keys().next().value);
  hlCache.set(key, html);
  return html;
}
function cachedHighlight(code, lang) { return hlCache.get(`${lang}\u0000${code}`); }

function scheduleHighlight(codeEl) {
  if (codeEl.dataset.highlighted) return;
  codeEl.dataset.highlighted = 'pending';
  const code = codeEl.textContent;
  const lang = codeEl.closest('.interactive-result-code-block')?.dataset.lang || '';
  highlight(code, lang).then(html => {
    if (html && codeEl.isConnected && codeEl.textContent === code) { codeEl.innerHTML = html; codeEl.dataset.highlighted = 'done'; }
    else codeEl.dataset.highlighted = 'none';
  });
}

// ------------------------------------------------------------------ code blocks

function langLabel(lang, path) {
  if (lang) return LANG_LABELS[lang] || lang;
  if (path) return posix.ext(path).slice(1) || 'text';
  return 'text';
}

function toolbarButton(icon, title, run) {
  const b = h('a', { class: `action-label codicon codicon-${icon}`, role: 'button', tabindex: '0', title, 'aria-label': title });
  const go = async e => {
    e.preventDefault(); e.stopPropagation();
    try { await run(b); } catch (err) { notifyError(err); }
  };
  b.addEventListener('click', go);
  b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') go(e); });
  return b;
}

async function notifyError(err) {
  log.warn(err?.stack || String(err));
  try { const { notify } = await import('../platform/notifications.js'); notify.error(String(err?.message || err), { source: 'X Coder AI' }); } catch {}
}
async function notifyInfo(msg) {
  try { const { notify } = await import('../platform/notifications.js'); notify.info(msg, { source: 'X Coder AI' }); } catch {}
}

function buildCodeBlock(pre, { streaming }) {
  const lang = pre.getAttribute('data-code-lang') || '';
  const path = pre.getAttribute('data-code-path') || '';
  const codeText = pre.textContent;
  const isShell = SHELL_LANGS.has(lang);
  const block = h('div', { class: 'interactive-result-code-block', 'data-lang': lang, 'data-path': path });
  const get = () => block.querySelector('code')?.textContent ?? codeText;
  const ctx = () => ({ code: get(), lang, path });
  const toolbar = h('div', { class: 'code-block-toolbar monaco-toolbar', role: 'toolbar', 'aria-label': 'Code block actions' },
    toolbarButton('copy', 'Copy', async b => {
      await codeBlockActions.copy(ctx());
      b.classList.replace('codicon-copy', 'codicon-check');
      setTimeout(() => b.classList.replace('codicon-check', 'codicon-copy'), 1200);
    }),
    isShell ? toolbarButton('terminal', 'Run in Terminal', () => codeBlockActions.runInTerminal(ctx())) : null,
    toolbarButton('insert', 'Insert at Cursor', () => codeBlockActions.insertAtCursor(ctx())),
    toolbarButton('git-pull-request-go-to-changes', path ? `Apply to ${path}` : 'Apply in Editor', () => codeBlockActions.apply(ctx())),
    toolbarButton('new-file', 'Insert into New File', () => codeBlockActions.newFile(ctx())));
  const header = h('div', { class: 'code-block-header' },
    h('span', { class: 'code-block-language' }, langLabel(lang, path)),
    path ? h('span', { class: 'code-block-path', title: path }, path) : null,
    toolbar);
  const code = h('code', { class: 'code-block-code' });
  const cached = cachedHighlight(codeText, lang);
  if (cached) { code.innerHTML = cached; code.dataset.highlighted = 'done'; }
  else code.textContent = codeText;
  const body = h('pre', { class: 'code-block-body', tabindex: '0' }, code);
  block.append(header, body);
  if (!streaming && !cached) queueMicrotask(() => scheduleHighlight(code));
  return block;
}

function enhance(node, opts) {
  if (node.nodeType !== 1) return node;
  const pres = node.matches?.('pre[data-code-lang]') ? [node] : [...node.querySelectorAll('pre[data-code-lang]')];
  let root = node;
  for (const pre of pres) {
    const block = buildCodeBlock(pre, opts);
    if (pre === node) root = block; else pre.replaceWith(block);
  }
  // inline code that names a project file becomes a file link (like VS Code's file widgets)
  for (const c of root.querySelectorAll?.('code:not(.code-block-code)') || []) {
    const t = c.textContent.trim().replace(/^\.?\//, '');
    if (t.length < 200 && /[./]/.test(t) && !/\s/.test(t)) {
      try { if (workspace.fs?.isFile(t)) { c.classList.add('file-link'); c.dataset.fileLink = t; c.setAttribute('role', 'link'); c.tabIndex = 0; } } catch {}
    }
  }
  // wide tables scroll horizontally inside the answer instead of widening the page
  for (const table of root.querySelectorAll?.('table') || []) {
    const wrap = h('div', { class: 'table-scroll' });
    table.before(wrap); wrap.append(table);
  }
  if (root.tagName === 'TABLE') root = h('div', { class: 'table-scroll' }, root);
  return root;
}

/**
 * Renders markdown into `el`, reusing unchanged top-level blocks. During streaming the unfinished last
 * block is re-rendered on every call; code blocks are highlighted once complete.
 */
export function renderMarkdownInto(el, text, { streaming = false } = {}) {
  el.classList.add('rendered-markdown');
  const src = streaming ? balanceFences(text) : String(text ?? '');
  const state = el._xcMd || (el._xcMd = { src: null, streaming: null });
  if (state.src === src && state.streaming === streaming) return;
  state.src = src; state.streaming = streaming;
  const tpl = document.createElement('template');
  tpl.innerHTML = markdownToSafeHtml(src);
  const next = [...tpl.content.childNodes].filter(n => !(n.nodeType === 3 && !n.textContent.trim()));
  const old = [...el.childNodes];
  next.forEach((n, i) => {
    const key = n.nodeType === 1 ? n.outerHTML : n.textContent;
    const cur = old[i];
    if (cur && cur._xcKey === key) {
      if (!streaming || i < next.length - 1) for (const c of cur.querySelectorAll?.('code.code-block-code:not([data-highlighted])') || []) scheduleHighlight(c);
      return;
    }
    const isLast = i === next.length - 1;
    const built = enhance(n, { streaming: streaming && isLast });
    built._xcKey = key;
    if (cur) el.replaceChild(built, cur); else el.append(built);
  });
  for (let i = next.length; i < old.length; i++) old[i].remove();
}

export function renderMarkdown(text) {
  const el = h('div', { class: 'rendered-markdown' });
  renderMarkdownInto(el, text);
  return el;
}

/** Plain text for speech / copying: code blocks omitted, markdown syntax removed. */
export function speechText(text = '') {
  return String(text)
    .replace(/```[\s\S]*?(```|$)/g, ' (code block omitted) ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------ actions

function defaultNewFileName({ lang, path }) {
  if (path) return path;
  const ext = EXT_FOR_LANG[lang] || (lang && /^[a-z0-9]{1,6}$/.test(lang) ? lang : 'txt');
  return `untitled.${ext}`;
}

export const codeBlockActions = {
  async copy({ code }) {
    if (!(await copyText(code))) throw new Error('Could not copy to the clipboard.');
  },

  async insertAtCursor({ code }) {
    const { codeEditor } = await import('../editor/api.js');
    const ed = codeEditor.getActive();
    if (!ed) { notifyInfo('Open a file in the editor to insert this code at the cursor.'); return false; }
    if (ed.insertText(code) === false) throw new Error('The active editor is read-only.');
    ed.focus?.();
    return true;
  },

  /** Opens a diff of the target file vs. the code block; Keep writes it, Undo discards. */
  async apply({ code, path }) {
    const { codeEditor } = await import('../editor/api.js');
    const { editors } = await import('../workbench/editors.js');
    const fs = workspace.fs;
    if (!fs) throw new Error('Open a project first.');
    const active = codeEditor.getActive();
    const target = path || active?.path;
    if (!target) { notifyInfo('Open the file you want to change, then tap Apply again.'); return null; }
    const exists = fs.isFile(target);
    const original = exists ? (codeEditor.getText(target) ?? await fs.readText(target)) : '';
    let modified = code.endsWith('\n') || !original.endsWith('\n') ? code : `${code}\n`;
    if (!path && active?.path === target) {
      const sel = active.getSelection?.();
      if (sel && sel.to > sel.from) modified = original.slice(0, sel.from) + code + original.slice(sel.to);
    }
    const id = uid('apply');
    const key = `diff:${id}`;
    await codeEditor.openDiff({
      id, path: target, readOnly: true, original, modified,
      title: `${posix.basename(target)} ↔ Code Block`,
      actions: [
        { label: 'Keep', icon: 'check', run: async () => {
          await fs.writeText(target, modified, { source: 'ai' });
          await editors.close(key, { force: true });
          notifyInfo(`${exists ? 'Updated' : 'Created'} ${target}.`);
        } },
        { label: 'Undo', icon: 'discard', run: () => editors.close(key, { force: true }) }
      ]
    });
    return { id, key, target, modified };
  },

  async newFile({ code, lang, path }) {
    const fs = workspace.fs;
    if (!fs) throw new Error('Open a project first.');
    const { quickInput } = await import('../platform/quickinput.js');
    const suggested = defaultNewFileName({ lang, path });
    const name = await quickInput.input({
      title: 'Insert into New File', prompt: 'Path of the new file in the project', value: suggested,
      validate: v => { try { validatePath(String(v).trim()); } catch (err) { return err.message; } return fs.exists(String(v).trim()) ? `${String(v).trim()} already exists` : null; }
    });
    if (!name) return null;
    const target = String(name).trim().replace(/^\/+/, '');
    await fs.writeText(target, code.endsWith('\n') ? code : `${code}\n`, { source: 'user' });
    const { editors } = await import('../workbench/editors.js');
    await editors.open({ type: 'file', path: target }, { pinned: true });
    return target;
  },

  async runInTerminal({ code }) {
    const { terminal } = await import('../panel/api.js');
    const lines = String(code).split('\n').map(l => l.replace(/^\s*[$>]\s+/, '')).filter(l => l.trim() && !/^\s*#/.test(l));
    if (!lines.length) return null;
    return terminal.run(lines.join('\n'));
  }
};
