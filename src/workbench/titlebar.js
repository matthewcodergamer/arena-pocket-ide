// Title bar (tablet/desktop): application icon, menubar (File Edit Selection View Go Run Terminal Help),
// command center, and layout toggles. On phones the title bar is hidden and the same menus open from
// the ☰ button at the top of the Activity Bar — exactly like VS Code in a phone browser (code-server).

import { $, h, codicon, clear } from '../core/dom.js';
import { bus } from '../core/events.js';
import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { workspace } from '../core/workspace.js';
import { quickInput } from '../platform/quickinput.js';
import { showContextMenu, isContextMenuOpen, closeContextMenu } from '../platform/contextmenu.js';
import { layout } from './layout.js';

export function initTitlebar() {
  const bar = $('#titlebar');
  if (!bar) return;
  const menubar = h('div', { class: 'menubar', role: 'menubar' });
  const center = h('div', { class: 'command-center' });
  const right = h('div', { class: 'layout-controls monaco-toolbar' });
  bar.append(
    h('div', { class: 'titlebar-left' }, h('div', { class: 'window-appicon', title: 'X Coder' }), menubar),
    h('div', { class: 'titlebar-center' }, center),
    h('div', { class: 'titlebar-right' }, right));

  const renderMenubar = () => {
    clear(menubar);
    const top = menus.resolve('menubar').filter(i => !i.separator);
    for (const item of top) {
      const btn = h('div', { class: 'menubar-menu-button', role: 'menuitem', tabindex: '0' }, h('div', { class: 'menubar-menu-title' }, item.label));
      const open = () => { btn.classList.add('open'); showContextMenu(item.submenu(), { anchor: btn, onClose: () => btn.classList.remove('open') }); };
      btn.addEventListener('click', () => { if (btn.classList.contains('open')) { closeContextMenu(); return; } open(); });
      btn.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && isContextMenuOpen() && $('.menubar-menu-button.open') && !btn.classList.contains('open')) { closeContextMenu(); open(); } });
      menubar.append(btn);
    }
  };

  const renderCenter = () => {
    clear(center);
    const cc = h('div', { class: 'command-center-center', role: 'button', tabindex: '0', title: `Search ${workspace.name} (${commands.keybindingLabel('workbench.action.quickOpen')})` },
      codicon('search'), h('span', { class: 'search-label' }, workspace.name));
    cc.addEventListener('click', () => quickInput.open(''));
    center.append(
      navButton('arrow-left', 'Go Back', 'workbench.action.navigateBack'),
      navButton('arrow-right', 'Go Forward', 'workbench.action.navigateForward'),
      cc);
  };

  const renderRight = () => {
    clear(right);
    right.append(
      toggle(layout.sidebarVisible ? 'layout-sidebar-left' : 'layout-sidebar-left-off', 'Toggle Primary Side Bar', 'workbench.action.toggleSidebarVisibility'),
      toggle(layout.panelVisible ? 'layout-panel' : 'layout-panel-off', 'Toggle Panel', 'workbench.action.togglePanel'),
      toggle(layout.auxVisible ? 'layout-sidebar-right' : 'layout-sidebar-right-off', 'Toggle Secondary Side Bar', 'workbench.action.toggleAuxiliaryBar'));
  };

  renderMenubar(); renderCenter(); renderRight();
  bus.on('layout:changed', renderRight);
  bus.on('project:opened', renderCenter);
  bus.on('project:renamed', renderCenter);
  bus.on('menus:changed', renderMenubar);
  setTimeout(renderMenubar, 0); // after feature modules contribute their menus
}

function navButton(icon, title, command) {
  const b = h('a', { class: `action-label codicon codicon-${icon}`, role: 'button', title, 'aria-label': title });
  b.addEventListener('click', () => commands.has(command) && commands.execute(command));
  return b;
}
function toggle(icon, title, command) {
  const b = h('a', { class: `action-label codicon codicon-${icon}`, role: 'button', title: `${title} (${commands.keybindingLabel(command)})`, 'aria-label': title });
  b.addEventListener('click', () => commands.execute(command));
  return b;
}

/** The ☰ application menu (phones / when the title bar is hidden). */
export function showApplicationMenu(anchor) {
  const items = menus.resolve('menubar');
  const withPalette = [
    { label: 'Command Palette…', keybinding: commands.keybindingLabel('workbench.action.showCommands'), run: () => commands.execute('workbench.action.showCommands') },
    { label: 'Go to File…', keybinding: commands.keybindingLabel('workbench.action.quickOpen'), run: () => commands.execute('workbench.action.quickOpen') },
    { separator: true },
    ...items
  ];
  const el = anchor instanceof Element ? anchor : $('#activitybar .menubar-toggle');
  const r = el?.getBoundingClientRect();
  return showContextMenu(withPalette, r ? { x: r.right + 2, y: r.top } : { x: 50, y: 40 });
}
