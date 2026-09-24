// Virtualized list used by the Explorer tree and the Search results tree.
// Only the rows inside the viewport (plus overscan) exist in the DOM, so a 2000-file project
// scrolls smoothly on an iPhone. Rows are absolutely positioned at index × row height, where the
// row height comes from the CSS density variable --row-height (22px desktop / 30px touch).
//
//   const list = new VirtualList({ className: 'explorer-tree', role: 'tree', ariaLabel: 'Files Explorer',
//     keyOf: row => row.key,                 // stable identity
//     sigOf: row => 'depth|name|decorations', // static look; a changed signature re-creates the element
//     renderRow: (row, index) => element,    // builds the static structure
//     updateRow: (el, row, index) => {} });  // applies dynamic state in place (selection, focus, expanded…)
//   list.setRows(rows)   // new data: unchanged rows keep their element (taps and double-clicks stay intact)
//   list.update()        // re-apply updateRow() to mounted rows (selection changes)
//   list.refresh()       // force re-creating every mounted row (theme / density changes)
//   list.reveal(index)   // scroll so the row is visible
//
// A renderRow() that returns the *same* element for a key keeps that element mounted untouched
// (used for the inline rename/new-file input so the iOS keyboard never closes). Rows with
// `pinned: true` stay mounted even when scrolled out of view.

import { h } from '../../core/dom.js';

export class VirtualList {
  constructor({ className = '', role = 'list', ariaLabel = '', keyOf, sigOf = null, renderRow, updateRow = null, overscan = 10 } = {}) {
    this.keyOf = keyOf;
    this.sigOf = sigOf;
    this.renderRow = renderRow;
    this.updateRow = updateRow;
    this.overscan = overscan;
    this.rows = [];
    this.cache = new Map(); // key → { el, sig, version }
    this.version = 0;
    this.rowHeight = 22;
    this.scroller = h('div', { class: `monaco-list xc-vlist ${className}`, tabindex: '0', role, 'aria-label': ariaLabel });
    this.rowsEl = h('div', { class: 'monaco-list-rows' });
    this.scroller.append(this.rowsEl);
    let queued = false;
    this.onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; this.render(); });
    };
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.lastWidth = -1; this.lastHeight = -1;
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(entries => {
        const r = entries[0]?.contentRect;
        if (r && r.width === this.lastWidth && r.height === this.lastHeight) return;
        this.lastWidth = r?.width ?? 0; this.lastHeight = r?.height ?? 0;
        this.measure();
        this.render();
      });
      this.ro.observe(this.scroller);
    }
  }

  /** Reads --row-height; a change (pointer type / density) forces a full re-render. */
  measure() {
    let v = 22;
    try { v = parseFloat(getComputedStyle(this.scroller).getPropertyValue('--row-height')) || 22; } catch {}
    if (v !== this.rowHeight) { this.rowHeight = v; this.version++; }
    return v;
  }

  setRows(rows) { this.rows = rows || []; this.render(); }
  refresh() { this.version++; this.render(); }
  update() {
    if (!this.updateRow) return this.refresh();
    for (const [, entry] of this.cache) {
      const i = Number(entry.el.dataset.index);
      if (this.rows[i]) this.updateRow(entry.el, this.rows[i], i);
    }
  }
  get length() { return this.rows.length; }
  elementFor(key) { return this.cache.get(key)?.el || null; }

  visibleRange() {
    const hgt = this.rowHeight;
    const viewport = this.scroller.clientHeight || window.innerHeight;
    const top = this.scroller.scrollTop;
    const start = Math.max(0, Math.floor(top / hgt) - this.overscan);
    const end = Math.min(this.rows.length, Math.ceil((top + viewport) / hgt) + this.overscan);
    return [start, end];
  }

  render() {
    const hgt = this.rowHeight;
    this.rowsEl.style.height = `${this.rows.length * hgt}px`;
    const [start, end] = this.visibleRange();
    const keep = new Set();
    const place = i => {
      const row = this.rows[i];
      const key = this.keyOf(row);
      if (keep.has(key)) return;
      keep.add(key);
      const sig = this.sigOf ? this.sigOf(row, i) : null;
      const cached = this.cache.get(key);
      let el = cached?.el;
      if (!cached || cached.version !== this.version || (this.sigOf ? cached.sig !== sig : true)) {
        const next = this.renderRow(row, i);
        if (el && el !== next) el.replaceWith(next);
        el = next;
        this.cache.set(key, { el, sig, version: this.version });
      }
      el.style.top = `${i * hgt}px`;
      el.dataset.index = String(i);
      this.updateRow?.(el, row, i);
      if (el.parentNode !== this.rowsEl) this.rowsEl.append(el);
    };
    for (let i = start; i < end; i++) place(i);
    // Pinned rows (inline inputs) stay mounted even when scrolled out of view.
    for (let i = 0; i < this.rows.length; i++) if (this.rows[i]?.pinned) place(i);
    for (const [key, entry] of this.cache) {
      if (!keep.has(key)) { entry.el.remove(); this.cache.delete(key); }
    }
  }

  /** Scrolls the row at `index` into view. block: 'nearest' | 'center' */
  reveal(index, { block = 'nearest' } = {}) {
    if (index < 0 || index >= this.rows.length) return;
    const hgt = this.rowHeight;
    const top = index * hgt;
    const viewport = this.scroller.clientHeight;
    if (!viewport) return;
    if (block === 'center') this.scroller.scrollTop = Math.max(0, top - (viewport - hgt) / 2);
    else if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + hgt > this.scroller.scrollTop + viewport) this.scroller.scrollTop = top + hgt - viewport;
    this.render();
  }

  isRowVisible(index) {
    const hgt = this.rowHeight, top = index * hgt;
    return top >= this.scroller.scrollTop && top + hgt <= this.scroller.scrollTop + this.scroller.clientHeight;
  }

  dispose() {
    this.ro?.disconnect();
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.cache.clear();
    this.scroller.remove();
  }
}
