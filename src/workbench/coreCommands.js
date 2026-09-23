// Core workbench commands (layout, quick access, editor group) + core status bar items
// + the Activity Bar's global Accounts / Manage buttons.

import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { quickInput } from '../platform/quickinput.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { notify, toggleNotificationCenter, notificationEvents } from '../platform/notifications.js';
import { layout } from './layout.js';
import { views, activityBar } from './views.js';
import { panel } from './panel.js';
import { editors } from './editors.js';
import { statusbar } from './statusbar.js';
import { showApplicationMenu } from './titlebar.js';

export function registerCoreCommands() {
  commands.registerAll([
    { id: 'workbench.action.showCommands', title: 'Show All Commands', category: 'View', keybinding: ['Mod+Shift+P', 'F1'], allowInInput: true, run: () => quickInput.open('>') },
    { id: 'workbench.action.quickOpen', title: 'Go to File…', category: 'Go', keybinding: 'Mod+P', allowInInput: true, run: (value = '') => quickInput.open(typeof value === 'string' ? value : '') },
    { id: 'workbench.action.gotoLine', title: 'Go to Line/Column…', category: 'Go', keybinding: 'Ctrl+G', run: () => quickInput.open(':') },
    { id: 'workbench.action.gotoSymbol', title: 'Go to Symbol in Editor…', category: 'Go', keybinding: 'Mod+Shift+O', run: () => quickInput.open('@') },
    { id: 'workbench.action.quickOpenHelp', title: 'Quick Open Help', category: 'Help', run: () => quickInput.open('?') },
    { id: 'workbench.action.showApplicationMenu', title: 'Show Application Menu', category: 'View', palette: false, run: anchor => showApplicationMenu(anchor) },
    { id: 'workbench.action.toggleSidebarVisibility', title: 'Toggle Primary Side Bar Visibility', category: 'View', keybinding: 'Mod+B', run: () => {
      if (!layout.sidebarVisible && !views.activeContainer('sidebar')) { const first = views.containers().find(c => c.location === 'sidebar'); if (first) return views.open(first.id); }
      layout.toggleSidebar();
    } },
    { id: 'workbench.action.togglePanel', title: 'Toggle Panel Visibility', category: 'View', keybinding: 'Mod+J', run: () => panel.toggle() },
    { id: 'workbench.action.toggleMaximizedPanel', title: 'Toggle Maximized Panel', category: 'View', run: () => layout.togglePanelMaximized() },
    { id: 'workbench.action.toggleAuxiliaryBar', title: 'Toggle Secondary Side Bar Visibility', category: 'View', keybinding: 'Mod+Alt+B', run: () => {
      if (!layout.auxVisible && views.activeContainer('aux')) return views.open(views.activeContainer('aux'));
      layout.toggleAux();
    } },
    { id: 'workbench.action.closeSidebar', title: 'Close Primary Side Bar', category: 'View', run: () => layout.setSidebarVisible(false) },
    { id: 'workbench.action.closePanel', title: 'Close Panel', category: 'View', run: () => panel.close() },
    { id: 'workbench.action.files.save', title: 'Save', category: 'File', keybinding: 'Mod+S', allowInInput: true, run: async () => { if (await editors.save()) bus.emit('workbench:saved'); } },
    { id: 'workbench.action.files.saveAll', title: 'Save All', category: 'File', keybinding: 'Mod+Alt+S', allowInInput: true, run: () => editors.saveAll() },
    { id: 'workbench.action.closeActiveEditor', title: 'Close Editor', category: 'View', keybinding: ['Mod+W', 'Ctrl+F4'], allowInInput: true, when: () => !!editors.active, run: () => editors.close() },
    { id: 'workbench.action.closeAllEditors', title: 'Close All Editors', category: 'View', run: () => editors.closeAll() },
    { id: 'workbench.action.closeOtherEditors', title: 'Close Other Editors in Group', category: 'View', when: () => !!editors.active, run: () => editors.closeOthers() },
    { id: 'workbench.action.closeUnmodifiedEditors', title: 'Close Saved Editors in Group', category: 'View', run: () => editors.closeAll({ saved: true }) },
    { id: 'workbench.action.keepEditor', title: 'Keep Editor', category: 'View', when: () => !!editors.active, run: () => editors.pin() },
    { id: 'workbench.action.nextEditor', title: 'Open Next Editor', category: 'View', keybinding: ['Ctrl+PageDown', 'Mod+Alt+ArrowRight', 'Ctrl+Tab'], allowInInput: true, run: () => editors.cycle(1) },
    { id: 'workbench.action.previousEditor', title: 'Open Previous Editor', category: 'View', keybinding: ['Ctrl+PageUp', 'Mod+Alt+ArrowLeft', 'Ctrl+Shift+Tab'], allowInInput: true, run: () => editors.cycle(-1) },
    { id: 'workbench.action.reloadWindow', title: 'Reload Window', category: 'Developer', run: async () => { await editors.saveAll().catch(() => {}); location.reload(); } },
    { id: 'workbench.action.toggleFullScreen', title: 'Toggle Full Screen', category: 'View', keybinding: 'F11', when: () => !!document.documentElement.requestFullscreen, run: () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.() },
    { id: 'notifications.toggleList', title: 'Toggle Notifications', category: 'Notifications', run: () => toggleNotificationCenter() },
    { id: 'notifications.clearAll', title: 'Clear All Notifications', category: 'Notifications', run: () => notify.clearAll() },
    { id: 'notifications.toggleDoNotDisturbMode', title: 'Toggle Do Not Disturb Mode', category: 'Notifications', run: () => notify.setDoNotDisturb(!notify.doNotDisturb) },
    { id: 'workbench.action.focusActiveEditorGroup', title: 'Focus Active Editor Group', category: 'View', palette: false, run: () => editors.active?.instance?.focus?.() }
  ]);
}

export function initCoreStatusbar() {
  // Remote indicator (far left). In code-server this shows the host; X Coder shows where your work lives.
  const remote = statusbar.add({ id: 'status.host', alignment: 'left', priority: 10000, kind: 'remote', text: '$(remote)', tooltip: 'X Coder', run: el => showHostMenu(el) });
  const updateRemote = () => {
    const online = navigator.onLine;
    // Like code-server, the remote indicator shows the host the IDE is served from.
    const host = location.host || 'X Coder';
    remote.update({ text: online ? `$(remote) ${host}` : '$(debug-disconnect) Offline', tooltip: online ? `X Coder on ${host} · ${workspace.name} is stored on this device` : 'Offline — local editing, preview and terminal still work', kind: online ? 'remote' : 'warning' });
  };
  updateRemote();
  window.addEventListener('online', updateRemote);
  window.addEventListener('offline', updateRemote);
  bus.on('project:opened', updateRemote);

  const bell = statusbar.add({ id: 'status.notifications', alignment: 'right', priority: -10000, text: '$(bell)', tooltip: 'Notifications', className: 'notifications', command: 'notifications.toggleList' });
  notificationEvents.on('changed', ({ unread, doNotDisturb }) => bell.update({ text: doNotDisturb ? '$(bell-slash)' : unread ? '$(bell-dot)' : '$(bell)', tooltip: unread ? `${unread} New Notifications` : 'No Notifications' }));

  activityBar.addGlobalItem({ id: 'accounts', icon: 'account', title: 'Accounts', order: 1, onClick: el => {
    const items = menus.resolve('accounts');
    const r = el.getBoundingClientRect();
    showContextMenu(items.length ? items : [{ label: 'You are not signed in to any accounts', disabled: true }], { x: r.right + 2, y: r.bottom });
  } });
  activityBar.addGlobalItem({ id: 'manage', icon: 'settings-gear', title: 'Manage', order: 2, onClick: el => {
    const r = el.getBoundingClientRect();
    showContextMenu(menus.resolve('manage'), { x: r.right + 2, y: r.bottom });
  } });
}

function showHostMenu(el) {
  const r = el.getBoundingClientRect();
  showContextMenu([
    { label: navigator.onLine ? 'Online' : 'Offline — changes are saved on this device', disabled: true },
    { label: `Project: ${workspace.name}`, disabled: true },
    { separator: true },
    { label: 'Switch Project…', run: () => commands.execute('workbench.action.openRecent') },
    { label: 'Install X Coder on Home Screen…', run: () => commands.execute('xcoder.showInstallHelp') },
    { label: 'Reload Window', run: () => commands.execute('workbench.action.reloadWindow') }
  ], { x: r.left, y: r.top - 4 });
}

settings.register({ key: 'workbench.startupEditor', type: 'enum', enum: ['none', 'welcomePage', 'readme', 'newUntitledFile'], enumLabels: ['None', 'Welcome Page', 'README', 'New File'], default: 'welcomePage', title: 'Startup Editor', description: 'Controls which editor is shown at startup, if none are restored from the previous session.', category: 'Workbench', common: true });
