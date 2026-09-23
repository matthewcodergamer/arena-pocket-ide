// The 'file' editor input: text files open in the CodeMirror editor, images in the image viewer
// (SVG can switch between preview and text), other binary files show VS Code's binary placeholder.

import { h, codicon, formatBytes, downloadBlob, clamp } from '../core/dom.js';
import { workspace } from '../core/workspace.js';
import { posix, isImagePath } from '../core/path.js';
import { quickInput } from '../platform/quickinput.js';
import { CodeEditor } from './codeEditor.js';
import { editorEvents } from './registry.js';

const ZOOM_LEVELS = [0.1, 0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 5, 7, 10, 15, 20];

/** VS Code's image preview: checkerboard background, fit / zoom (tap, pinch, Ctrl/⌘+wheel), status bar info. */
export class ImageViewer {
  constructor({ path, container }) {
    this.kind = 'image';
    this.path = path;
    this.container = container;
    this.scale = 'fit';
    this.natural = { width: 0, height: 0 };
    this.size = 0;
    container.classList.add('xc-image-root');
    this.img = h('img', { class: 'image-preview-img', alt: posix.basename(path), draggable: 'false' });
    this.stage = h('div', { class: 'image-preview-stage' }, this.img);
    this.el = h('div', { class: 'image-preview scale-to-fit', tabindex: '0', role: 'img', 'aria-label': posix.basename(path) }, this.stage);
    container.append(this.el);
    this.bindGestures();
  }

  async load() {
    const blob = await workspace.fs.readBlob(this.path);
    this.size = blob.size;
    const typed = posix.ext(this.path) === '.svg' && blob.type !== 'image/svg+xml' ? new Blob([blob], { type: 'image/svg+xml' }) : blob;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(typed);
    await new Promise(resolve => {
      this.img.onload = () => { this.natural = { width: this.img.naturalWidth, height: this.img.naturalHeight }; resolve(); };
      this.img.onerror = () => { this.el.classList.add('error'); this.el.replaceChildren(h('div', { class: 'image-load-error' }, codicon('warning'), ` ${posix.basename(this.path)} could not be displayed as an image.`)); resolve(); };
      this.img.src = this.url;
    });
    this.apply();
  }

  bindGestures() {
    const pointers = new Map();
    let pinch = null, moved = false, downAt = null;
    this.el.addEventListener('pointerdown', e => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false; downAt = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.currentScale() };
      }
    });
    this.el.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) moved = true;
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.dist > 0) this.setScale(clamp(pinch.scale * (d / pinch.dist), 0.1, 20));
        e.preventDefault();
      }
    });
    const up = e => {
      const wasPinch = !!pinch;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (e.type === 'pointerup' && !wasPinch && !moved && pointers.size === 0 && e.button === 0) this.zoomStep(e.altKey || e.shiftKey ? -1 : 1);
    };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
    this.el.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setScale(clamp(this.currentScale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.1, 20));
    }, { passive: false });
    this.el.addEventListener('keydown', e => {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomStep(1); }
      else if (e.key === '-') { e.preventDefault(); this.zoomStep(-1); }
      else if (e.key === '0') { e.preventDefault(); this.setScale('fit'); }
    });
  }

  currentScale() {
    if (this.scale !== 'fit') return this.scale;
    const { width, height } = this.natural;
    if (!width || !height) return 1;
    const r = this.el.getBoundingClientRect();
    return Math.min(1, (r.width - 20) / width, (r.height - 20) / height);
  }
  zoomStep(dir) {
    const cur = this.currentScale();
    if (dir > 0) {
      const next = ZOOM_LEVELS.find(z => z > cur + 0.001);
      this.setScale(next ?? 'fit');
    } else {
      const prev = [...ZOOM_LEVELS].reverse().find(z => z < cur - 0.001);
      this.setScale(prev ?? ZOOM_LEVELS[0]);
    }
  }
  setScale(scale) {
    this.scale = scale;
    this.apply();
    editorEvents.emit('status', this);
  }
  apply() {
    const fit = this.scale === 'fit';
    this.el.classList.toggle('scale-to-fit', fit);
    this.el.classList.toggle('zoomed', !fit);
    if (fit) { this.img.style.width = ''; this.img.style.height = ''; }
    else {
      this.img.style.width = `${Math.max(1, Math.round(this.natural.width * this.scale))}px`;
      this.img.style.height = `${Math.max(1, Math.round(this.natural.height * this.scale))}px`;
    }
    this.el.classList.toggle('pixelated', !fit && this.scale >= 3);
  }
  zoomLabel() { return this.scale === 'fit' ? 'Whole Image' : `${Math.round(this.scale * 100)}%`; }
  statusInfo() {
    return { dimensions: this.natural.width ? `${this.natural.width}x${this.natural.height}` : '', size: formatBytes(this.size), zoom: this.zoomLabel() };
  }
  async pickZoom() {
    const items = [{ label: 'Whole Image', value: 'fit' }, ...ZOOM_LEVELS.map(z => ({ label: `${Math.round(z * 100)}%`, value: z }))];
    const picked = await quickInput.pick(items, { placeholder: 'Select zoom level', activeItem: items.find(i => i.value === this.scale) });
    if (picked) this.setScale(picked.value);
  }
  focus() { this.el.focus({ preventScroll: true }); }
  onShow() { editorEvents.emit('status', this); }
  async reload() { await this.load(); editorEvents.emit('status', this); }
  setInput(input) { this.path = input.path; this.img.alt = posix.basename(input.path); }
  dispose() { if (this.url) URL.revokeObjectURL(this.url); this.el.remove(); }
}

/** VS Code's "binary or unsupported encoding" placeholder. */
class BinaryView {
  constructor({ path, container, onOpenAnyway }) {
    this.kind = 'binary';
    this.path = path;
    const size = workspace.fs?.size(path) || 0;
    const open = h('button', { class: 'monaco-button', type: 'button' }, 'Open Anyway');
    const download = h('button', { class: 'monaco-button secondary', type: 'button' }, 'Download');
    open.addEventListener('click', () => onOpenAnyway());
    download.addEventListener('click', async () => { downloadBlob(await workspace.fs.readBlob(this.path), posix.basename(this.path)); });
    this.el = h('div', { class: 'editor-placeholder binary-editor' },
      h('div', { class: 'editor-placeholder-icon' }, codicon('file-binary')),
      h('div', { class: 'editor-placeholder-label' }, 'The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.'),
      h('div', { class: 'editor-placeholder-meta' }, `${posix.basename(path)} · ${formatBytes(size)}`),
      h('div', { class: 'editor-placeholder-buttons' }, open, download));
    container.append(this.el);
    this.focusTarget = open;
  }
  focus() { this.focusTarget.focus({ preventScroll: true }); }
  setInput(input) { this.path = input.path; }
  dispose() { this.el.remove(); }
}

/** Hosts the right view for a file and switches between them (SVG preview ↔ text, binary → Open Anyway). */
class FileHost {
  constructor(input, container, api) {
    this.input = input;
    this.container = container;
    this.api = api;
    this.inner = null;
    this.mode = null;
  }
  get path() { return this.input.path; }

  defaultMode() {
    const fs = workspace.fs;
    const rec = fs.get(this.input.path);
    if (!rec || rec.type !== 'file') throw new Error(`The editor could not be opened because the file was not found: ${this.input.path}`);
    if (this.input.as === 'text') return 'text';
    if (isImagePath(this.input.path)) return 'image';
    if (rec.binary instanceof Blob) return 'binary';
    return 'text';
  }

  async show(mode, { readOnly = false } = {}) {
    try { this.inner?.dispose?.(); } catch {}
    this.inner = null;
    this.container.replaceChildren();
    this.container.className = this.container.className.split(' ').filter(c => !/^xc-(editor|image)-root$/.test(c)).join(' ');
    this.mode = mode;
    const path = this.input.path;
    if (mode === 'image') {
      const viewer = new ImageViewer({ path, container: this.container });
      this.inner = viewer;
      await viewer.load();
    } else if (mode === 'binary') {
      this.inner = new BinaryView({ path, container: this.container, onOpenAnyway: () => this.show('text', { readOnly: true }).then(() => this.afterSwitch()) });
    } else {
      const ed = await CodeEditor.create({ path }, this.container, this.api, { readOnly: readOnly || (workspace.fs.isBinary(path) && !isImagePath(path)) });
      this.inner = ed;
    }
    return this.inner;
  }
  afterSwitch() {
    this.inner?.onShow?.();
    editorEvents.emit('status', this.inner);
    import('../workbench/editors.js').then(({ editors }) => { editors.refresh(); editors.active && this.api && editors.pin(this.api.key); });
  }
  /** SVG: switch between the image preview and the text editor. */
  async openAs(mode) {
    if (mode === this.mode) return;
    if (this.mode === 'text' && this.inner?.dirty) await this.inner.save();
    this.input = { ...this.input, as: mode === 'text' ? 'text' : undefined };
    await this.show(mode);
    this.afterSwitch();
    this.inner?.focus?.();
  }
  setInput(input) { this.input = { ...input, as: this.input.as }; this.inner?.setInput?.(input); }
  dispose() { try { this.inner?.dispose?.(); } catch {} this.inner = null; }
}

const proxyHandler = {
  get(target, key) {
    if (key in target) return target[key];
    const inner = target.inner;
    if (!inner) return undefined;
    const value = inner[key];
    return typeof value === 'function' ? value.bind(inner) : value;
  },
  has(target, key) { return key in target || (!!target.inner && key in target.inner); }
};

export async function createFileEditor(input, container, api) {
  const host = new FileHost(input, container, api);
  await host.show(host.defaultMode());
  return new Proxy(host, proxyHandler);
}

/** The FileHost behind an editor instance (or null). */
export function fileHostOf(instance) { return instance && instance.inner !== undefined && typeof instance.openAs === 'function' ? instance : null; }
