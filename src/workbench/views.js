// View containers (Activity Bar + Primary/Secondary Side Bar) and their views.
//
//   views.registerContainer({ id: 'workbench.view.explorer', title: 'Explorer', icon: 'files', order: 1,
//                             location: 'sidebar' | 'aux', keybinding: 'Mod+Shift+E' })
//   views.registerView({
//     id: 'workbench.explorer.fileView', containerId: 'workbench.view.explorer', name: 'Folders',
//     order: 2, collapsed: false, size: 'fill' | 'auto',
//     render(body, view) → { dispose?, onShow?, onHide?, focus? },
//     actions: [{ icon: 'new-file', title: 'New File…', run: () => … }],    // shown in the pane header (or container title if it's the only view)
//     moreActions: () => menuItems,                                           // "…" menu
//     when: () => bool
//   })
//   views.open('workbench.view.scm')          views.toggle(id)          views.close(location)
//   views.setBadge('workbench.view.scm', 3)   views.setTitle(viewId, 'MY-PROJECT')   views.refreshActions(viewId)
//   views.revealView(viewId)                  views.activeContainer('sidebar')

import { $, h, codicon, clear, onContextMenu } from '../core/dom.js';
import { bus } from '../core/events.js';
import { commands, keybindingLabel } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { layout } from './layout.js';
import { showContextMenu } from '../platform/contextmenu.js';

const containers = new Map();
const viewDefs = new Map();
const active = { sidebar: null, aux: null };
const rendered = new Map(); // containerId → { el, panes: Map(viewId → pane) }
const COLLAPSE_KEY = 'xcoder.views.collapsed.v6';
let collapsedState = {};
try { collapsedState = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch {}

export const views = {
  registerContainer(def) {
    const c = { location: 'sidebar', order: 100, ...def, badge: null };
    containers.set(c.id, c);
    commands.register({
      id: c.id, title: `Show ${c.title}`, category: 'View', icon: c.icon, keybinding: c.keybinding,
      run: () => this.open(c.id, { focus: true })
    });
    renderActivityBar();
    return c;
  },
  registerView(def) {
    const v = { order: 100, size: 'fill', collapsed: false, actions: [], ...def };
    viewDefs.set(v.id, v);
    const r = rendered.get(v.containerId);
    if (r) { r.el.remove(); rendered.delete(v.containerId); if (isShown(v.containerId)) showContainer(v.containerId); }
    return v;
  },
  containers() { return [...containers.values()].sort((a, b) => a.order - b.order); },
  container(id) { return containers.get(id); },
  activeContainer(location = 'sidebar') { return active[location]; },
  isVisible(id) { return isShown(id); },

  /** Opens a container in its location (activates the Activity Bar item). */
  open(id, { focus = false } = {}) {
    const c = containers.get(id);
    if (!c) return;
    active[c.location] = id;
    try { localStorage.setItem(`xcoder.views.active.${c.location}`, id); } catch {}
    if (c.location === 'aux') layout.setAuxVisible(true); else layout.setSidebarVisible(true);
    showContainer(id);
    renderActivityBar();
    if (focus) {
      const r = rendered.get(id);
      for (const pane of r?.panes.values() || []) if (!pane.collapsed && pane.handle?.focus) { pane.handle.focus(); break; }
    }
    bus.emit('views:opened', { id });
  },
  /** Clicking an Activity Bar icon: open, or hide when it is already the visible container. */
  toggle(id) {
    const c = containers.get(id);
    if (!c) return;
    if (isShown(id)) {
      if (c.location === 'aux') layout.setAuxVisible(false); else layout.setSidebarVisible(false);
      renderActivityBar();
    } else this.open(id, { focus: !layout.isPhone });
  },
  close(location = 'sidebar') { if (location === 'aux') layout.setAuxVisible(false); else layout.setSidebarVisible(false); renderActivityBar(); },

  setBadge(id, value, tooltip = '') {
    const c = containers.get(id); if (!c) return;
    c.badge = value || value === 0 ? (value === 0 ? null : value) : null;
    c.badgeTooltip = tooltip;
    renderActivityBar();
  },
  setTitle(viewId, title) {
    const v = viewDefs.get(viewId); if (!v) return;
    v.title = title;
    const pane = findPane(viewId);
    if (pane) pane.titleEl.textContent = title;
    const r = rendered.get(v.containerId);
    if (r && r.single === viewId) renderContainerTitle(v.containerId);
  },
  setDescription(viewId, text) {
    const pane = findPane(viewId);
    if (pane) pane.descEl.textContent = text || '';
  },
  refreshActions(viewId) {
    const v = viewDefs.get(viewId); if (!v) return;
    const pane = findPane(viewId);
    if (pane) renderPaneActions(pane, v);
    const r = rendered.get(v.containerId);
    if (r?.single === viewId) renderContainerTitle(v.containerId);
  },
  revealView(viewId, { focus = true } = {}) {
    const v = viewDefs.get(viewId); if (!v) return;
    this.open(v.containerId);
    const pane = findPane(viewId);
    if (pane?.collapsed) setCollapsed(pane, false);
    if (focus) pane?.handle?.focus?.();
    pane?.el.scrollIntoView?.({ block: 'nearest' });
  },
  getViewHandle(viewId) { return findPane(viewId)?.handle || null; },

  /** Restores the last active containers (called once at startup). */
  restore() {
    for (const loc of ['sidebar', 'aux']) {
      const saved = localStorage.getItem(`xcoder.views.active.${loc}`);
      const first = this.containers().find(c => c.location === loc && !c.hidden);
      active[loc] = containers.has(saved) ? saved : first?.id || null;
    }
    renderActivityBar();
    if (layout.sidebarVisible && active.sidebar) showContainer(active.sidebar);
    if (layout.auxVisible && active.aux) showContainer(active.aux);
  }
};

function isShown(id) {
  const c = containers.get(id); if (!c) return false;
  return active[c.location] === id && (c.location === 'aux' ? layout.auxVisible : layout.sidebarVisible);
}

function findPane(viewId) {
  const v = viewDefs.get(viewId); if (!v) return null;
  return rendered.get(v.containerId)?.panes.get(viewId) || null;
}

function containerViews(id) {
  return [...viewDefs.values()].filter(v => v.containerId === id && (!v.when || safe(v.when)))
    .sort((a, b) => a.order - b.order);
}
function safe(fn) { try { return !!fn(); } catch { return false; } }

function showContainer(id) {
  const c = containers.get(id);
  const host = $(c.location === 'aux' ? '#auxiliarybar' : '#sidebar');
  if (!host) return;
  for (const child of host.children) {
    const cid = child.dataset.containerId;
    if (cid !== id) { child.classList.add('hidden'); for (const p of rendered.get(cid)?.panes.values() || []) p.handle?.onHide?.(); }
  }
  let r = rendered.get(id);
  if (!r) r = buildContainer(c, host);
  r.el.classList.remove('hidden');
  for (const p of r.panes.values()) if (!p.collapsed) p.handle?.onShow?.();
}

function buildContainer(c, host) {
  const el = h('div', { class: 'composite viewlet', 'data-container-id': c.id, role: 'region', 'aria-label': c.title });
  const title = h('div', { class: 'composite title' });
  const content = h('div', { class: 'content split-view-container' });
  el.append(title, content);
  host.append(el);
  const list = containerViews(c.id);
  const r = { el, title, content, panes: new Map(), single: list.length === 1 ? list[0].id : null };
  rendered.set(c.id, r);
  for (const v of list) {
    const pane = buildPane(v, r.single === v.id);
    r.panes.set(v.id, pane);
    content.append(pane.el);
  }
  renderContainerTitle(c.id);
  return r;
}

function renderContainerTitle(id) {
  const c = containers.get(id), r = rendered.get(id);
  if (!r) return;
  clear(r.title);
  const single = r.single ? viewDefs.get(r.single) : null;
  const label = single?.containerTitle || c.title;
  r.title.append(h('div', { class: 'title-label' }, h('h2', { title: label }, label.toUpperCase())));
  const actions = h('div', { class: 'title-actions monaco-toolbar' });
  const list = single ? resolveActions(single) : (c.actions || []);
  for (const a of list) actions.append(actionButton(a));
  const more = single?.moreActions || c.moreActions;
  if (more) {
    const b = actionButton({ icon: 'ellipsis', title: 'More Actions…' });
    b.addEventListener('click', e => { e.stopPropagation(); showContextMenu(more(), { anchor: b, align: 'right' }); });
    actions.append(b);
  }
  if (layout.isPhone) actions.append(actionButton({ icon: 'close', title: 'Close', run: () => views.close(c.location) }));
  r.title.append(actions);
}

function resolveActions(v) {
  const list = typeof v.actions === 'function' ? v.actions() : (v.actions || []);
  const fromMenu = menus.resolve(`view/title/${v.id}`).filter(i => !i.separator && i.icon).map(i => ({ icon: i.icon, title: i.label, run: i.run }));
  return [...list, ...fromMenu].filter(a => !a.when || safe(a.when));
}

function actionButton(a) {
  const kb = a.command ? commands.keybindingLabel(a.command) : '';
  const title = a.title + (kb ? ` (${kb})` : '');
  const b = h('a', { class: ['action-label', 'codicon', `codicon-${a.icon}`, a.checked && 'checked'], role: 'button', tabindex: '0', title, 'aria-label': title });
  b.addEventListener('click', e => { e.stopPropagation(); if (a.run) a.run(e); else if (a.command) commands.execute(a.command, ...(a.args || [])); });
  b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } });
  return b;
}

function buildPane(v, single) {
  const key = v.id;
  const collapsed = single ? false : (collapsedState[key] ?? v.collapsed);
  const el = h('div', { class: ['pane', single && 'single', collapsed && 'collapsed', v.size === 'auto' && 'size-auto'], 'data-view-id': v.id });
  const header = h('div', { class: 'pane-header', role: 'button', tabindex: '0', 'aria-expanded': String(!collapsed) });
  const twistie = codicon(collapsed ? 'chevron-right' : 'chevron-down', 'twistie');
  const titleEl = h('h3', { class: 'title' }, (v.title || v.name || '').toUpperCase());
  const descEl = h('span', { class: 'description' });
  const actions = h('div', { class: 'actions monaco-toolbar' });
  header.append(twistie, titleEl, descEl, actions);
  const body = h('div', { class: 'pane-body' });
  el.append(header, body);
  const pane = { el, header, body, twistie, titleEl, descEl, actions, collapsed, handle: null, view: v, single };
  if (single) header.classList.add('hidden');
  header.addEventListener('click', e => { if (e.target.closest('.actions')) return; setCollapsed(pane, !pane.collapsed); });
  header.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(pane, !pane.collapsed); } });
  if (v.moreActions) onContextMenu(header, (x, y) => showContextMenu(v.moreActions(), { x, y }));
  renderPaneActions(pane, v);
  try { pane.handle = v.render(body, { id: v.id, pane, setBadge: n => views.setBadge(v.containerId, n) }) || {}; }
  catch (err) { console.error(`[X Coder] view ${v.id} failed to render`, err); body.append(h('div', { class: 'view-error' }, `This view failed to load: ${err.message}`)); pane.handle = {}; }
  return pane;
}

function renderPaneActions(pane, v) {
  clear(pane.actions);
  if (pane.single) return;
  for (const a of resolveActions(v)) pane.actions.append(actionButton(a));
  if (v.moreActions) {
    const b = actionButton({ icon: 'ellipsis', title: 'More Actions…' });
    b.addEventListener('click', e => { e.stopPropagation(); showContextMenu(v.moreActions(), { anchor: b, align: 'right' }); });
    pane.actions.append(b);
  }
}

function setCollapsed(pane, collapsed) {
  pane.collapsed = collapsed;
  pane.el.classList.toggle('collapsed', collapsed);
  pane.header.setAttribute('aria-expanded', String(!collapsed));
  pane.twistie.className = `codicon codicon-${collapsed ? 'chevron-right' : 'chevron-down'} twistie`;
  collapsedState[pane.view.id] = collapsed;
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedState)); } catch {}
  if (collapsed) pane.handle?.onHide?.(); else pane.handle?.onShow?.();
}

// ---------------- Activity Bar ----------------
const globalItems = []; // bottom items (Accounts, Manage)
export const activityBar = {
  /** Bottom "global" items like Accounts and Manage: { id, icon, title, order, onClick(anchorEl), badge } */
  addGlobalItem(item) { globalItems.push({ order: 100, ...item }); renderActivityBar(); return () => { globalItems.splice(globalItems.indexOf(item), 1); renderActivityBar(); }; },
  setGlobalBadge(id, badge) { const it = globalItems.find(i => i.id === id); if (it) { it.badge = badge; renderActivityBar(); } },
  render: () => renderActivityBar()
};

function renderActivityBar() {
  const bar = $('#activitybar');
  if (!bar) return;
  clear(bar);
  const top = h('ul', { class: 'actions-container', role: 'tablist', 'aria-label': 'Active View Switcher' });
  // code-server / VS Code web show the application menu at the top of the activity bar when the title bar is hidden
  const menuBtn = h('li', { class: 'action-item menubar-toggle', role: 'button', title: 'Application Menu', 'aria-label': 'Application Menu' }, codicon('menu'));
  menuBtn.addEventListener('click', () => commands.execute('workbench.action.showApplicationMenu', menuBtn));
  top.append(menuBtn);
  for (const c of views.containers()) {
    if (c.hidden) continue;
    const isActive = isShown(c.id);
    const kb = c.keybinding ? ` (${keybindingLabel(c.keybinding)})` : '';
    const li = h('li', { class: ['action-item', isActive && 'checked', c.location === 'aux' && 'aux'], role: 'tab', 'aria-selected': String(isActive), title: c.title + kb, 'aria-label': c.title, 'data-container': c.id },
      h('span', { class: `action-label codicon codicon-${c.icon}` }),
      c.badge != null ? h('div', { class: 'badge', title: c.badgeTooltip || '' }, h('div', { class: 'badge-content' }, String(c.badge))) : null,
      h('div', { class: 'active-item-indicator' }));
    li.addEventListener('click', () => views.toggle(c.id));
    top.append(li);
  }
  const bottom = h('ul', { class: 'actions-container global' });
  for (const it of [...globalItems].sort((a, b) => a.order - b.order)) {
    const li = h('li', { class: 'action-item', role: 'button', title: it.title, 'aria-label': it.title },
      h('span', { class: `action-label codicon codicon-${it.icon}` }),
      it.badge ? h('div', { class: 'badge' }, h('div', { class: 'badge-content' }, String(it.badge))) : null);
    li.addEventListener('click', () => it.onClick?.(li));
    bottom.append(li);
  }
  bar.append(top, bottom);
}

bus.on('layout:changed', () => {
  renderActivityBar();
  for (const [id, r] of rendered) if (isShown(id)) renderContainerTitle(id);
  if (layout.sidebarVisible && active.sidebar) showContainer(active.sidebar);
  if (layout.auxVisible && active.aux) showContainer(active.aux);
});
