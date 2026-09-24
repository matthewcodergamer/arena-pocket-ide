// Application menus (File · Edit · Selection · View · Go · Run · Terminal · Help) and the
// Manage (gear) menu. Items reference command ids owned by every feature; entries whose command
// is not registered are hidden by menus.resolve(), so the menus always show only what works.
//
// The title bar renders 'menubar' on tablets/desktops; on phones the same tree opens from the ☰
// button at the top of the Activity Bar (code-server style).

import { menus } from '../../core/menus.js';
import { bus } from '../../core/events.js';
import { settings } from '../../core/settings.js';
import { commands } from '../../core/commands.js';
import { workspace } from '../../core/workspace.js';
import { layout } from '../layout.js';

const TOP = [
  ['menubar/file', '&File'],
  ['menubar/edit', '&Edit'],
  ['menubar/selection', '&Selection'],
  ['menubar/view', '&View'],
  ['menubar/go', '&Go'],
  ['menubar/run', '&Run'],
  ['menubar/terminal', '&Terminal'],
  ['menubar/help', '&Help']
];

/** Appends a list of [group, command | {…item}, title?] rows to a menu, numbering order within each group. */
function contribute(menuId, rows) {
  const orders = new Map();
  for (const row of rows) {
    const [group, target, title] = row;
    const order = (orders.get(group) || 0) + 1;
    orders.set(group, order);
    const item = typeof target === 'string' ? { command: target } : { ...target };
    menus.append(menuId, { group, order, ...(title ? { title } : {}), ...item });
  }
}

const isChecked = key => () => { const v = settings.get(key); return v !== undefined && v !== false && v !== 'off' && v !== 'none'; };

export function registerApplicationMenus() {
  TOP.forEach(([submenu, title], i) => menus.append('menubar', { submenu, title, group: '1', order: i + 1 }));

  // ---- File ----
  contribute('menubar/file', [
    ['1_new', 'workbench.action.files.newUntitledFile', 'New Text File'],
    ['1_new', 'workbench.action.files.newFile', 'New File…'],
    ['1_new', 'xcoder.project.new', 'New Project…'],
    ['2_open', 'workbench.action.files.openFile', 'Open File…'],
    ['2_open', 'xcoder.project.open', 'Open Project…'],
    ['2_open', { submenu: 'menubar/file/recent' }, 'Open Recent'],
    ['2_open', 'git.clone', 'Clone Repository…'],
    ['3_import', { submenu: 'menubar/file/import' }, 'Import'],
    ['4_save', 'workbench.action.files.save', 'Save'],
    ['4_save', 'workbench.action.files.saveAll', 'Save All'],
    ['5_autosave', { command: 'workbench.action.toggleAutoSave', checked: () => (settings.get('files.autoSave', 'off') || 'off') !== 'off' }, 'Auto Save'],
    ['6_share', { submenu: 'menubar/file/share' }, 'Share'],
    ['7_prefs', { submenu: 'menubar/file/preferences' }, 'Preferences'],
    ['8_close', 'workbench.action.files.revert', 'Revert File'],
    ['8_close', 'workbench.action.closeActiveEditor', 'Close Editor'],
    ['8_close', 'workbench.action.closeAllEditors', 'Close All Editors'],
    ['9_project', 'xcoder.project.rename', 'Rename Project…'],
    ['9_project', 'xcoder.project.duplicate', 'Duplicate Project'],
    ['9_project', 'xcoder.project.delete', 'Delete Project…']
  ]);
  contribute('menubar/file/import', [
    ['1_import', 'xcoder.files.importFiles', 'Files…'],
    ['1_import', 'xcoder.files.importFolder', 'Folder…'],
    ['1_import', 'xcoder.files.importZip', 'ZIP…']
  ]);
  contribute('menubar/file/share', [
    ['1_export', 'xcoder.files.exportZip', 'Export Project as ZIP']
  ]);
  contribute('menubar/file/preferences', [
    ['1_settings', 'workbench.action.openSettings', 'Settings'],
    ['1_settings', 'workbench.view.extensions', 'Extensions'],
    ['1_settings', 'workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts'],
    ['2_themes', 'workbench.action.selectTheme', 'Color Theme']
  ]);
  // 'menubar/file/recent' is filled dynamically from the project list (see refreshRecentMenu).

  // ---- Edit ----
  contribute('menubar/edit', [
    ['1_do', 'undo', 'Undo'],
    ['1_do', 'redo', 'Redo'],
    ['2_ccp', 'editor.action.clipboardCutAction', 'Cut'],
    ['2_ccp', 'editor.action.clipboardCopyAction', 'Copy'],
    ['2_ccp', 'editor.action.clipboardPasteAction', 'Paste'],
    ['3_find', 'actions.find', 'Find'],
    ['3_find', 'editor.action.startFindReplaceAction', 'Replace'],
    ['4_find_global', 'workbench.action.findInFiles', 'Find in Files'],
    ['4_find_global', 'workbench.action.replaceInFiles', 'Replace in Files'],
    ['5_insert', 'editor.action.commentLine', 'Toggle Line Comment'],
    ['5_insert', 'editor.action.blockComment', 'Toggle Block Comment'],
    ['5_insert', 'editor.emmet.action.expandAbbreviation', 'Emmet: Expand Abbreviation']
  ]);

  // ---- Selection ----
  contribute('menubar/selection', [
    ['1_basic', 'editor.action.selectAll', 'Select All'],
    ['2_line', 'editor.action.copyLinesUpAction', 'Copy Line Up'],
    ['2_line', 'editor.action.copyLinesDownAction', 'Copy Line Down'],
    ['2_line', 'editor.action.moveLinesUpAction', 'Move Line Up'],
    ['2_line', 'editor.action.moveLinesDownAction', 'Move Line Down'],
    ['2_line', 'editor.action.duplicateSelection', 'Duplicate Selection'],
    ['3_multi', 'editor.action.insertCursorAbove', 'Add Cursor Above'],
    ['3_multi', 'editor.action.insertCursorBelow', 'Add Cursor Below'],
    ['3_multi', 'editor.action.addSelectionToNextFindMatch', 'Add Next Occurrence'],
    ['3_multi', 'editor.action.selectHighlights', 'Select All Occurrences']
  ]);

  // ---- View ----
  contribute('menubar/view', [
    ['1_open', 'workbench.action.showCommands', 'Command Palette…'],
    ['1_open', 'workbench.action.openView', 'Open View…'],
    ['2_appearance', { submenu: 'menubar/view/appearance' }, 'Appearance'],
    ['3_views', 'workbench.view.explorer', 'Explorer'],
    ['3_views', 'workbench.view.search', 'Search'],
    ['3_views', 'workbench.view.scm', 'Source Control'],
    ['3_views', 'workbench.view.debug', 'Run'],
    ['3_views', 'workbench.view.extensions', 'Extensions'],
    ['3_views', 'workbench.view.chat', 'Chat'],
    ['4_panels', 'workbench.actions.view.problems', 'Problems'],
    ['4_panels', 'workbench.action.output.toggleOutput', 'Output'],
    ['4_panels', 'workbench.debug.action.toggleRepl', 'Debug Console'],
    ['4_panels', 'workbench.action.terminal.toggleTerminal', 'Terminal'],
    ['5_editor', { command: 'editor.action.toggleWordWrap', checked: isChecked('editor.wordWrap') }, 'Word Wrap']
  ]);
  contribute('menubar/view/appearance', [
    ['1_toggle_view', { command: 'workbench.action.toggleFullScreen', checked: () => !!document.fullscreenElement }, 'Full Screen'],
    ['2_workbench_layout', { command: 'workbench.action.toggleSidebarVisibility', checked: () => layout.sidebarVisible }, 'Primary Side Bar'],
    ['2_workbench_layout', { command: 'workbench.action.toggleAuxiliaryBar', checked: () => layout.auxVisible }, 'Secondary Side Bar'],
    ['2_workbench_layout', { command: 'workbench.action.togglePanel', checked: () => layout.panelVisible }, 'Panel'],
    ['3_editor', { command: 'editor.action.toggleMinimap', checked: isChecked('editor.minimap.enabled') }, 'Minimap'],
    ['4_zoom', 'editor.action.fontZoomIn', 'Zoom In'],
    ['4_zoom', 'editor.action.fontZoomOut', 'Zoom Out'],
    ['4_zoom', 'editor.action.fontZoomReset', 'Reset Zoom']
  ]);

  // ---- Go ----
  contribute('menubar/go', [
    ['1_history_nav', 'workbench.action.navigateBack', 'Back'],
    ['1_history_nav', 'workbench.action.navigateForward', 'Forward'],
    ['2_switch', { submenu: 'menubar/go/switchEditor' }, 'Switch Editor'],
    ['3_nav', 'workbench.action.quickOpen', 'Go to File…'],
    ['3_nav', 'workbench.action.gotoSymbol', 'Go to Symbol in Editor…'],
    ['3_nav', 'workbench.action.gotoLine', 'Go to Line/Column…'],
    ['4_problems', 'editor.action.marker.next', 'Next Problem'],
    ['4_problems', 'editor.action.marker.prev', 'Previous Problem']
  ]);
  contribute('menubar/go/switchEditor', [
    ['1_any', 'workbench.action.nextEditor', 'Next Editor'],
    ['1_any', 'workbench.action.previousEditor', 'Previous Editor']
  ]);

  // ---- Run ----
  contribute('menubar/run', [
    ['1_debug', 'workbench.action.debug.start', 'Start Debugging'],
    ['1_debug', 'workbench.action.debug.run', 'Run Without Debugging'],
    ['1_debug', 'workbench.action.debug.stop', 'Stop Debugging'],
    ['1_debug', 'workbench.action.debug.restart', 'Restart Debugging'],
    ['2_configuration', 'workbench.action.debug.configure', 'Open Configurations'],
    ['2_configuration', 'debug.addConfiguration', 'Add Configuration…']
  ]);

  // ---- Terminal ----
  contribute('menubar/terminal', [
    ['1_manage', 'workbench.action.terminal.new', 'New Terminal'],
    ['2_run', 'workbench.action.terminal.runActiveFile', 'Run Active File'],
    ['2_run', 'workbench.action.terminal.runSelectedText', 'Run Selected Text'],
    ['3_clear', 'workbench.action.terminal.clear', 'Clear Terminal']
  ]);

  // ---- Help ----
  contribute('menubar/help', [
    ['1_welcome', 'workbench.action.showWelcomePage', 'Welcome'],
    ['1_welcome', 'welcome.showInterfaceOverview', 'Interface Overview'],
    ['1_welcome', 'welcome.showInteractivePlayground', 'Editor Playground'],
    ['1_welcome', 'workbench.action.showCommands', 'Show All Commands'],
    ['1_welcome', 'workbench.action.openDocumentationUrl', 'Documentation'],
    ['1_welcome', 'update.showCurrentReleaseNotes', 'Release Notes'],
    ['2_reference', 'workbench.action.keybindingsReference', 'Keyboard Shortcuts Reference'],
    ['3_feedback', 'workbench.action.openIssueReporter', 'Report Issue'],
    ['4_update', 'update.checkForUpdates', 'Check for Updates…'],
    ['5_tools', 'workbench.action.toggleDevTools', 'Toggle Developer Tools'],
    ['6_about', 'workbench.action.showAboutDialog', 'About']
  ]);

  // ---- Manage (gear, bottom of the Activity Bar) ----
  contribute('manage', [
    ['1_palette', 'workbench.action.showCommands', 'Command Palette…'],
    ['2_configuration', 'workbench.action.openSettings', 'Settings'],
    ['2_configuration', 'workbench.view.extensions', 'Extensions'],
    ['2_configuration', 'workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts'],
    ['3_themes', { submenu: 'manage/themes' }, 'Themes'],
    ['4_update', { command: 'update.checkForUpdates', when: () => !updateWaiting() }, 'Check for Updates…'],
    ['4_update', { run: () => applyWaitingUpdate(), when: () => updateWaiting() }, 'Restart to Update (1)'],
    ['4_update', 'xcoder.showInstallHelp', 'Install X Coder App…'],
    ['5_about', 'workbench.action.showAboutDialog', 'About']
  ]);
  contribute('manage/themes', [
    ['1_themes', 'workbench.action.selectTheme', 'Color Theme']
  ]);

  // ---- Editor title actions for the preference editors (Open Settings (JSON) etc.) ----
  menus.append('editor/title', { command: 'workbench.action.openSettingsJson', icon: 'go-to-file', title: 'Open Settings (JSON)', group: 'navigation', order: 1, when: input => input?.type === 'settings' });
  menus.append('editor/title', { command: 'workbench.action.openSettings', icon: 'settings', title: 'Open Settings (UI)', group: 'navigation', order: 1, when: input => input?.type === 'settings-json' });

  refreshRecentMenu();
  bus.on('projects:changed', () => refreshRecentMenu());
  bus.on('project:opened', () => refreshRecentMenu());
  bus.on('project:renamed', () => refreshRecentMenu());
  bus.emit('menus:changed');
  setTimeout(() => bus.emit('menus:changed'), 0);
}

// ---- File > Open Recent (dynamic) ----
let recentDisposers = [];
let recentToken = 0;
export async function refreshRecentMenu() {
  const token = ++recentToken;
  let projects = [];
  try { projects = await workspace.listProjects(); } catch { projects = []; }
  if (token !== recentToken) return;
  recentDisposers.forEach(d => d());
  recentDisposers = [];
  const others = projects.filter(p => p.id !== workspace.id).slice(0, 10);
  others.forEach((p, i) => {
    recentDisposers.push(menus.append('menubar/file/recent', {
      group: '1_recent', order: i + 1,
      title: p.name,
      run: () => commands.execute('xcoder.project.open', p.id)
    }));
  });
  recentDisposers.push(menus.append('menubar/file/recent', { group: '2_more', order: 1, command: 'workbench.action.openRecent', title: 'More…' }));
  bus.emit('menus:changed');
}

// ---- update helpers used by the Manage menu ----
export function updateWaiting() { try { return !!(window.__xcoderSW?.waiting && navigator.serviceWorker?.controller); } catch { return false; } }
export function applyWaitingUpdate() {
  const waiting = window.__xcoderSW?.waiting;
  if (!waiting) return false;
  window.__xcoderUpdateRequested = true;
  waiting.postMessage({ type: 'skipWaiting' });
  setTimeout(() => location.reload(), 1500);
  return true;
}
