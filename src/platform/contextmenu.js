// VS Code–style context menu with keyboard navigation and submenus.
// On phones submenus drill down in place (with a back row); on larger screens they cascade.
//
//   showContextMenu([
//     { label: 'Rename', icon: 'edit', keybinding: 'F2', run: () => … },
//     { separator: true },
//     { label: 'Sort By', submenu: [ { label: 'Name', checked: true, run } ] },   // submenu: items | () => items
//     { label: 'Delete', danger: true, disabled: false, run }
//   ], { x, y })                     // or { anchor: element, align: 'left'|'right' }
//
// Returns a promise that resolves when the menu closes.

import { h, codicon, clamp, isPhone } from '../core/dom.js';

let current = null;

export function closeContextMenu() { current?.close(); }
export function isContextMenuOpen() { return !!current; }

export function showContextMenu(items, opts = {}) {
  closeContextMenu();
  return new Promise(resolve => {
    const layer = h('div', { class: 'context-view-layer' });
    const stack = []; // menus (cascade) or levels (drill-down)
    const drill = isPhone() || opts.drill;
    let closed = false;

    const close = () => {
      if (closed) return; closed = true;
      layer.remove();
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey, true);
      if (current?.layer === layer) current = null;
      opts.onClose?.();
      resolve();
    };
    current = { layer, close };

    layer.addEventListener('pointerdown', e => { if (e.target === layer) { e.preventDefault(); close(); } });
    layer.addEventListener('contextmenu', e => { e.preventDefault(); if (e.target === layer) close(); });

    function resolveItems(list) {
      const arr = typeof list === 'function' ? list() : list;
      // collapse duplicate/leading/trailing separators
      const out = [];
      for (const it of arr || []) {
        if (!it) continue;
        if (it.separator && (!out.length || out.at(-1).separator)) continue;
        out.push(it);
      }
      while (out.length && out.at(-1).separator) out.pop();
      return out;
    }

    function buildMenu(list, level, title) {
      const menu = h('div', { class: 'monaco-menu context-menu', role: 'menu', tabindex: '-1' });
      const rows = [];
      if (drill && level > 0) {
        const back = h('div', { class: 'action-item menu-back', role: 'menuitem', tabindex: '-1' },
          h('span', { class: 'menu-item-check' }, codicon('chevron-left')), h('span', { class: 'action-label' }, title || 'Back'));
        back.addEventListener('click', e => { e.stopPropagation(); popTo(level - 1); });
        menu.append(back);
        rows.push({ el: back, item: { back: true } });
      } else if (opts.title && level === 0) {
        menu.append(h('div', { class: 'menu-title' }, opts.title));
      }
      const hasChecks = list.some(i => i.checked !== undefined && !i.separator);
      for (const item of list) {
        if (item.separator) { menu.append(h('div', { class: 'action-separator', role: 'separator' })); continue; }
        const row = h('div', {
          class: ['action-item', item.disabled && 'disabled', item.danger && 'danger', item.checked && 'checked'],
          role: item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem', tabindex: '-1',
          'aria-checked': item.checked !== undefined ? String(!!item.checked) : null,
          'aria-disabled': item.disabled ? 'true' : null, title: item.tooltip || null
        },
          h('span', { class: 'menu-item-check' }, item.checked ? codicon('check') : (hasChecks || !item.icon ? null : codicon(item.icon))),
          h('span', { class: 'action-label' }, item.label),
          item.keybinding ? h('span', { class: 'keybinding' }, item.keybinding) : null,
          item.submenu ? h('span', { class: 'submenu-indicator' }, codicon('chevron-right')) : null);
        const entry = { el: row, item };
        rows.push(entry);
        menu.append(row);
        row.addEventListener('pointerenter', e => {
          if (e.pointerType === 'mouse') { focusRow(menuState, rows.indexOf(entry)); if (!drill) hoverSubmenu(entry, level); }
        });
        row.addEventListener('click', e => { e.stopPropagation(); activate(entry, level); });
      }
      const menuState = { menu, rows, level, active: -1 };
      return menuState;
    }

    let hoverTimer = 0;
    function hoverSubmenu(entry, level) {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (closed) return;
        if (entry.item.submenu && !entry.item.disabled) openSubmenu(entry, level);
        else popTo(level);
      }, 180);
    }

    function focusRow(state, index) {
      state.rows.forEach((r, i) => r.el.classList.toggle('focused', i === index));
      state.active = index;
      state.rows[index]?.el.focus({ preventScroll: false });
    }

    function popTo(level) {
      while (stack.length > level + 1) stack.pop().menu.remove();
      if (drill) { const top = stack[level]; if (top) { top.menu.style.display = ''; focusRow(top, 0); } }
    }

    function openSubmenu(entry, level) {
      popTo(level);
      const list = resolveItems(entry.item.submenu);
      const sub = buildMenu(list, level + 1, entry.item.label);
      stack.push(sub);
      layer.append(sub.menu);
      if (drill) {
        const parent = stack[level];
        const r = parent.menu.getBoundingClientRect();
        parent.menu.style.display = 'none';
        position(sub.menu, { x: r.left, y: r.top });
      } else {
        const r = entry.el.getBoundingClientRect();
        position(sub.menu, { x: r.right - 2, y: r.top - 5, flipX: r.left + 2 });
      }
      focusRow(sub, drill ? 1 : 0);
    }

    function activate(entry, level) {
      const { item } = entry;
      if (item.back) { popTo(level - 1); return; }
      if (item.disabled) return;
      if (item.submenu) { openSubmenu(entry, level); return; }
      close();
      try { const r = item.run?.(); if (r?.catch) r.catch(err => console.error(err)); } catch (err) { console.error(err); }
    }

    function onKey(e) {
      const state = stack.at(-1); if (!state) return;
      const { rows } = state;
      const move = dir => {
        if (!rows.length) return;
        let i = state.active;
        for (let n = 0; n < rows.length; n++) { i = (i + dir + rows.length) % rows.length; if (!rows[i].item.disabled) break; }
        focusRow(state, i);
      };
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (stack.length > 1) popTo(stack.length - 2); else close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'ArrowRight') { const r = rows[state.active]; if (r?.item.submenu) { e.preventDefault(); openSubmenu(r, state.level); } }
      else if (e.key === 'ArrowLeft') { if (stack.length > 1) { e.preventDefault(); popTo(stack.length - 2); } }
      else if (e.key === 'Enter' || e.key === ' ') { const r = rows[state.active]; if (r) { e.preventDefault(); activate(r, state.level); } }
      else if (e.key === 'Tab') { e.preventDefault(); close(); }
    }

    const root = buildMenu(resolveItems(items), 0);
    stack.push(root);
    layer.append(root.menu);
    document.body.append(layer);

    let point;
    if (opts.anchor) {
      const r = opts.anchor.getBoundingClientRect();
      point = { x: opts.align === 'right' ? r.right : r.left, y: r.bottom + 2, alignRight: opts.align === 'right', flipY: r.top - 2 };
    } else point = { x: opts.x ?? 0, y: opts.y ?? 0 };
    position(root.menu, point);
    if (opts.minWidth) root.menu.style.minWidth = `${opts.minWidth}px`;
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => root.menu.focus({ preventScroll: true }));
  });
}

function position(menu, { x, y, alignRight = false, flipX, flipY }) {
  menu.style.left = '0px'; menu.style.top = '0px';
  const vw = window.visualViewport?.width || innerWidth;
  const vh = window.visualViewport?.height || innerHeight;
  const r = menu.getBoundingClientRect();
  let left = alignRight ? x - r.width : x;
  if (left + r.width > vw - 4) left = flipX != null ? flipX - r.width : vw - r.width - 4;
  let top = y;
  if (top + r.height > vh - 4) top = flipY != null && flipY - r.height > 4 ? flipY - r.height : vh - r.height - 4;
  menu.style.left = `${clamp(left, 4, Math.max(4, vw - r.width - 4))}px`;
  menu.style.top = `${clamp(top, 4, Math.max(4, vh - r.height - 4))}px`;
  menu.style.maxHeight = `${vh - 8}px`;
}
