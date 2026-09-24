// Markdown preview (input { type: 'markdown-preview', path }): marked + DOMPurify with VS Code's
// markdown preview styling, project-relative images (blob URLs), highlighted code blocks and live
// updates while typing (from the open editor) or when the file changes on disk.

import { h, escapeHtml } from '../core/dom.js';
import { bus } from '../core/events.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { editors } from '../workbench/editors.js';
import { log } from '../core/output.js';
import { textEditorFor, editorEvents } from './registry.js';
import { highlightCode } from './highlight.js';

let libs = null;
async function markdownLibs() { return libs || (libs = await import('../../vendor/markdown.js')); }

function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

class MarkdownPreview {
  constructor(input, container) {
    this.kind = 'markdown-preview';
    this.path = input.path;
    this.container = container;
    this.blobUrls = new Map();
    container.classList.add('xc-markdown-root');
    this.body = h('div', { class: 'markdown-body selectable', role: 'document' });
    this.el = h('div', { class: 'markdown-preview', tabindex: '0' }, this.body);
    container.append(this.el);
    this.el.addEventListener('click', e => this.onClick(e));
    this.renderSoon = (() => { let t = 0; return (ms = 150) => { clearTimeout(t); t = setTimeout(() => this.render(), ms); }; })();
    this.offs = [
      editorEvents.on('change', path => { if (path === this.path) this.renderSoon(); }),
      bus.on('fs:changed', ev => {
        if ((ev.type === 'write' || ev.type === 'create') && (ev.path === this.path || !ev.path.endsWith('.md'))) this.renderSoon(300);
        else if (ev.type === 'reset') this.renderSoon(300);
      }),
      bus.on('theme:changed', () => this.renderSoon(0))
    ];
  }

  source() {
    const ed = textEditorFor(this.path);
    if (ed) return ed.view.state.doc.toString();
    return workspace.fs?.peekText(this.path) ?? '';
  }

  async render() {
    if (this.disposed) return;
    const token = (this.token = (this.token || 0) + 1);
    let html;
    try {
      const { marked, DOMPurify } = await markdownLibs();
      const raw = marked.parse(this.source(), { gfm: true, async: false });
      html = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] });
    } catch (err) {
      log.warn('Markdown preview failed', err);
      html = `<p class="markdown-error">${escapeHtml(String(err?.message || err))}</p>`;
    }
    if (token !== this.token || this.disposed) return;
    const scroll = this.el.scrollTop;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const frag = tpl.content;
    const used = new Map();
    for (const hd of frag.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      let id = slugify(hd.textContent || '');
      const n = used.get(id) || 0; used.set(id, n + 1);
      if (n) id += `-${n}`;
      hd.id = id;
    }
    for (const cb of frag.querySelectorAll('input[type="checkbox"]')) { cb.disabled = true; cb.classList.add('task-list-item-checkbox'); cb.parentElement?.classList.add('task-list-item'); }
    for (const a of frag.querySelectorAll('a[href]')) { const href = a.getAttribute('href'); if (/^https?:/i.test(href)) a.title = a.title || href; }
    await this.resolveImages(frag);
    const blocks = [...frag.querySelectorAll('pre > code')];
    await Promise.all(blocks.map(async code => {
      const lang = (/(?:^|\s)language-([\w#+.-]+)/.exec(code.className) || [])[1];
      if (!lang) return;
      code.innerHTML = await highlightCode(code.textContent || '', lang);
      code.parentElement.classList.add('highlighted');
    }));
    if (token !== this.token || this.disposed) return;
    this.body.replaceChildren(frag);
    this.el.scrollTop = scroll;
  }

  async resolveImages(frag) {
    const fs = workspace.fs;
    for (const img of frag.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      if (/^(https?:|data:|blob:)/i.test(src)) continue;
      let target;
      try { target = posix.resolve(this.path, decodeURI(src)); } catch { target = posix.resolve(this.path, src); }
      const rec = fs?.get(target);
      if (!rec || rec.type !== 'file') { img.removeAttribute('src'); img.alt = `${img.alt || src} (image not found: ${target})`; img.classList.add('missing'); continue; }
      const key = `${target}|${rec.updatedAt}`;
      let url = this.blobUrls.get(key);
      if (!url) {
        const blob = await fs.readBlob(target);
        url = URL.createObjectURL(posix.ext(target) === '.svg' ? new Blob([blob], { type: 'image/svg+xml' }) : blob);
        for (const [k, u] of this.blobUrls) if (k.startsWith(target + '|')) { URL.revokeObjectURL(u); this.blobUrls.delete(k); }
        this.blobUrls.set(key, url);
      }
      img.src = url;
    }
  }

  onClick(e) {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    e.preventDefault();
    if (href.startsWith('#')) {
      const el = this.body.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`);
      el?.scrollIntoView({ block: 'start' });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); return; }
    const [file, frag] = href.split('#');
    let target;
    try { target = posix.resolve(this.path, decodeURI(file)); } catch { target = posix.resolve(this.path, file); }
    if (workspace.fs?.isFile(target)) {
      if (/\.md$/i.test(target) && frag == null) editors.open({ type: 'markdown-preview', path: target }, { pinned: true });
      else editors.open({ type: 'file', path: target }, { pinned: true });
    }
  }

  focus() { this.el.focus({ preventScroll: true }); }
  onShow() { if (!this.rendered) { this.rendered = true; this.render(); } }
  setInput(input) { this.path = input.path; this.renderSoon(0); }
  getState() { return { scrollTop: this.el.scrollTop }; }
  setState(s) { if (s?.scrollTop) requestAnimationFrame(() => { this.el.scrollTop = s.scrollTop; }); }
  dispose() {
    this.disposed = true;
    for (const off of this.offs) off();
    for (const u of this.blobUrls.values()) URL.revokeObjectURL(u);
    this.blobUrls.clear();
  }
}

export function createMarkdownPreview(input, container) {
  const p = new MarkdownPreview(input, container);
  p.render();
  p.rendered = true;
  return p;
}
