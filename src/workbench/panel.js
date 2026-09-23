// Bottom Panel (PROBLEMS · OUTPUT · DEBUG CONSOLE · TERMINAL …).
//
//   panel.registerTab({ id: 'terminal', title: 'Terminal', order: 4, keybinding,
//                       render(host) → { dispose?, onShow?, onHide?, focus? },
//                       actions: () => [{ icon: 'trash', title: 'Clear', run }] })
//   panel.open('terminal', { focus: true })   panel.toggle('terminal')   panel.close()
//   panel.setBadge('problems', 3)             panel.refreshActions()     panel.activeId

import { $, h, codicon, clear } from '../core/dom.js';
import { bus } from '../core/events.js';
import { layout } from './layout.js';
import { showContextMenu } from '../platform/contextmenu.js';

const tabs = new Map();
let activeId = null;
let built = false;

export const panel = {
  get activeId() { return activeId; },
  registerTab(def) {
    tabs.set(def.id, { order: 100, badge: null, ...def, handle: null, host: null });
    if (built) render();
    return () => { tabs.delete(def.id); render(); };
  },
  open(id, { focus = false } = {}) {
    if (id && tabs.has(id)) activeId = id;
    if (!activeId) activeId = sorted()[0]?.id || null;
    try { localStorage.setItem('xcoder.panel.active', activeId || ''); } catch {}
    layout.setPanelVisible(true);
    render();
    const t = tabs.get(activeId);
    if (focus) requestAnimationFrame(() => t?.handle?.focus?.());
  },
  toggle(id) {
    if (layout.panelVisible && (!id || id === activeId)) { this.close(); return; }
    this.open(id || activeId, { focus: true });
  },
  close() { layout.setPanelVisible(false); tabs.get(activeId)?.handle?.onHide?.(); },
  isVisible(id) { return layout.panelVisible && (!id || id === activeId); },
  setBadge(id, value) { const t = tabs.get(id); if (!t) return; t.badge = value || null; renderTabsOnly(); },
  refreshActions() { renderActions(); },
  restore() {
    const saved = localStorage.getItem('xcoder.panel.active');
    activeId = tabs.has(saved) ? saved : sorted().find(t => t.id === 'terminal')?.id || sorted()[0]?.id || null;
    built = true;
    render();
  }
};

function sorted() { return [...tabs.values()].sort((a, b) => a.order - b.order); }

let tabBar, actionsBar, content;
function ensureDom() {
  const root = $('#panel');
  if (!root || tabBar) return root;
  tabBar = h('ul', { class: 'panel-switcher actions-container', role: 'tablist' });
  actionsBar = h('div', { class: 'title-actions monaco-toolbar' });
  const title = h('div', { class: 'composite title panel-title' }, h('div', { class: 'panel-switcher-container' }, tabBar), actionsBar);
  content = h('div', { class: 'content panel-content' });
  root.append(title, content);
  return root;
}

function render() {
  if (!ensureDom()) return;
  renderTabsOnly();
  for (const t of tabs.values()) {
    if (t.id === activeId && layout.panelVisible) {
      if (!t.host) {
        t.host = h('div', { class: 'panel-view', 'data-panel': t.id });
        content.append(t.host);
        try { t.handle = t.render(t.host) || {}; } catch (err) { console.error(err); t.host.append(h('div', { class: 'view-error' }, err.message)); t.handle = {}; }
      }
      t.host.classList.remove('hidden');
      t.handle?.onShow?.();
    } else if (t.host && !t.host.classList.contains('hidden')) {
      t.host.classList.add('hidden');
      t.handle?.onHide?.();
    }
  }
  renderActions();
}

function renderTabsOnly() {
  if (!tabBar) return;
  clear(tabBar);
  for (const t of sorted()) {
    const li = h('li', { class: ['action-item', t.id === activeId && 'checked'], role: 'tab', 'aria-selected': String(t.id === activeId), tabindex: '0', title: t.title },
      h('a', { class: 'action-label' }, t.title.toUpperCase()),
      t.badge ? h('div', { class: 'badge' }, h('div', { class: 'badge-content' }, String(t.badge))) : null,
      h('div', { class: 'active-item-indicator' }));
    li.addEventListener('click', () => panel.open(t.id, { focus: true }));
    tabBar.append(li);
  }
}

function renderActions() {
  if (!actionsBar) return;
  clear(actionsBar);
  const t = tabs.get(activeId);
  const list = (typeof t?.actions === 'function' ? t.actions() : t?.actions) || [];
  for (const a of list) {
    if (a.separator) { actionsBar.append(h('span', { class: 'action-separator' })); continue; }
    if (a.element) { actionsBar.append(a.element); continue; }
    const b = h('a', { class: ['action-label', 'codicon', `codicon-${a.icon}`, a.checked && 'checked'], role: 'button', title: a.title, 'aria-label': a.title });
    b.addEventListener('click', e => { e.stopPropagation(); a.run?.(b); });
    actionsBar.append(b);
  }
  if (t?.moreActions) {
    const more = h('a', { class: 'action-label codicon codicon-ellipsis', role: 'button', title: 'Views and More Actions…' });
    more.addEventListener('click', () => showContextMenu(t.moreActions(), { anchor: more, align: 'right' }));
    actionsBar.append(more);
  }
  const max = h('a', { class: `action-label codicon codicon-${layout.panelMaximized ? 'chevron-down' : 'chevron-up'}`, role: 'button', title: layout.panelMaximized ? 'Restore Panel Size' : 'Maximize Panel Size' });
  max.addEventListener('click', () => { layout.togglePanelMaximized(); renderActions(); });
  const close = h('a', { class: 'action-label codicon codicon-close', role: 'button', title: 'Hide Panel' });
  close.addEventListener('click', () => panel.close());
  actionsBar.append(max, close);
}

bus.on('layout:changed', () => { if (built) render(); });
