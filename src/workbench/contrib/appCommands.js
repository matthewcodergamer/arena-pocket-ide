// Workbench-level commands: Preferences: Color Theme (live preview), Toggle Auto Save, Open View,
// Toggle Developer Tools (Eruda for the IDE itself), About, Check for Updates, Release Notes,
// Documentation and Report Issue.

import { commands } from '../../core/commands.js';
import { settings } from '../../core/settings.js';
import { bus } from '../../core/events.js';
import { $$, h, codiconHtml, copyText, formatBytes, isStandalone, isIOS, isApple } from '../../core/dom.js';
import { log } from '../../core/output.js';
import { quickInput } from '../../platform/quickinput.js';
import { dialogs } from '../../platform/dialogs.js';
import { notify } from '../../platform/notifications.js';
import { THEMES, applyTheme, currentTheme } from '../theme.js';
import { views, activityBar } from '../views.js';
import { editors } from '../editors.js';
import { panel } from '../panel.js';
import { updateWaiting, applyWaitingUpdate } from './menubar.js';

export const REPO_URL = 'https://github.com/matthewcodergamer/arena-pocket-ide';
const ERUDA_URL = 'https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js';

export function appVersion() { return document.documentElement.dataset.xcoderVersion || '6.0.0'; }

function openExternal(url) {
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (!w) notify.info(`Open this link in your browser: ${url}`, { source: 'X Coder', actions: [{ label: 'Copy Link', run: () => copyText(url) }] });
}

// ---------------- Preferences: Color Theme ----------------
async function selectTheme() {
  const groups = [['light', 'light themes'], ['dark', 'dark themes'], ['hc', 'high contrast themes']];
  const items = [];
  for (const [type, label] of groups) {
    const list = THEMES.filter(t => t.type === type);
    if (!list.length) continue;
    items.push({ kind: 'separator', label });
    for (const t of list) items.push({ id: t.id, label: t.label, theme: t });
  }
  const active = items.find(i => i.id === currentTheme().id);
  let previewed = null;
  const picked = await quickInput.pick(items, {
    title: 'Color Theme', placeholder: 'Select Color Theme (Up/Down Keys to Preview)', activeItem: active,
    onDidChangeActive: item => {
      if (!item?.theme || item.id === previewed) return;
      previewed = item.id;
      applyTheme(item.id);
    }
  });
  if (!picked?.theme) { applyTheme(); return null; }
  if (settings.get('window.autoDetectColorScheme')) settings.set('window.autoDetectColorScheme', false);
  settings.set('workbench.colorTheme', picked.id);
  applyTheme();
  return picked.id;
}

// ---------------- Toggle Auto Save ----------------
function toggleAutoSave() {
  const on = (settings.get('files.autoSave', 'off') || 'off') !== 'off';
  settings.set('files.autoSave', on ? 'off' : 'afterDelay');
  return !on;
}

// ---------------- View: Open View ----------------
async function openView() {
  const items = [];
  const groups = [['sidebar', 'Side Bar'], ['aux', 'Secondary Side Bar']];
  for (const [loc, label] of groups) {
    const list = views.containers().filter(c => (c.location || 'sidebar') === loc && !c.hidden);
    if (!list.length) continue;
    items.push({ kind: 'separator', label });
    for (const c of list) items.push({ label: c.title, icon: c.icon, run: () => views.open(c.id, { focus: true }) });
  }
  // panel.tabs() when the core exposes it; otherwise read the rendered panel switcher.
  const panelTabs = typeof panel.tabs === 'function'
    ? panel.tabs().map(t => ({ title: t.title, open: () => panel.open(t.id, { focus: true }) }))
    : $$('#panel .panel-switcher [role="tab"]').map(tab => ({ title: tab.getAttribute('title') || tab.textContent.trim(), open: () => tab.click() }));
  if (panelTabs.length) {
    items.push({ kind: 'separator', label: 'Panel' });
    for (const t of panelTabs) items.push({ label: t.title, icon: 'layout-panel', run: t.open });
  }
  const picked = await quickInput.pick(items, { title: 'Open View', placeholder: 'Type the name of a view, output channel or terminal to open' });
  picked?.run?.();
}

// ---------------- Developer: Toggle Developer Tools ----------------
let erudaState = 'idle'; // idle | loading | shown
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = h('script', { src, async: true, crossorigin: 'anonymous' });
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error(`Could not download ${new URL(src).host}`)); };
    document.head.append(s);
  });
}
async function toggleDevTools() {
  if (erudaState === 'loading') return;
  if (erudaState === 'shown' && window.eruda) {
    try { window.eruda.destroy(); } catch (err) { log.warn('Eruda destroy failed', err); }
    erudaState = 'idle';
    return false;
  }
  if (!window.eruda) {
    if (!navigator.onLine) { notify.warn('Developer Tools need an internet connection the first time: Eruda is downloaded from cdn.jsdelivr.net.', { source: 'X Coder' }); return false; }
    erudaState = 'loading';
    const n = notify.progress('Loading Developer Tools (Eruda)…', { source: 'X Coder' });
    try { await loadScript(ERUDA_URL); }
    catch (err) {
      erudaState = 'idle'; n.close();
      log.warn('Developer Tools could not be loaded', err);
      notify.error('Developer Tools could not be loaded: cdn.jsdelivr.net is unreachable. Check your connection (content blockers can also block it) and try again.', { source: 'X Coder' });
      return false;
    }
    n.close();
  }
  try {
    window.eruda.init({ useShadowDom: true, autoScale: true, defaults: { theme: document.documentElement.dataset.themeType === 'light' ? 'Light' : 'Dark' } });
    window.eruda.show();
    erudaState = 'shown';
    return true;
  } catch (err) {
    erudaState = 'idle';
    notify.error(`Developer Tools failed to start: ${err.message}`, { source: 'X Coder' });
    return false;
  }
}

// ---------------- Help: About ----------------
function browserName() {
  const ua = navigator.userAgent;
  const rules = [
    ['Edge', /Edg(?:iOS|A)?\/([\d.]+)/],
    ['Chrome', /(?:CriOS|Chrome)\/([\d.]+)/],
    ['Firefox', /(?:FxiOS|Firefox)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/]
  ];
  for (const [name, re] of rules) { const m = ua.match(re); if (m) return `${name} ${m[1]}`; }
  return 'Unknown browser';
}
function osName() {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/);
  if (ios) return `${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${ios[1]}.${ios[2]}${ios[3] ? '.' + ios[3] : ''}`;
  if (isIOS) return 'iPadOS';
  if (/Android ([\d.]+)/.test(ua)) return `Android ${ua.match(/Android ([\d.]+)/)[1]}`;
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return navigator.platform || 'Unknown';
}
function fmtBytes(n) { return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : formatBytes(n); }
async function storageLine() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return 'unknown';
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    return `${fmtBytes(est.usage || 0)} used of ${fmtBytes(est.quota || 0)}${persisted ? ' (persistent)' : ''}`;
  } catch { return 'unknown'; }
}
async function showAbout() {
  const date = new Date(document.lastModified);
  const detail = [
    `Version: ${appVersion()}`,
    `Date: ${Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10)}`,
    `Browser: ${browserName()}`,
    `OS: ${osName()}`,
    `Mode: ${isStandalone() ? 'Home Screen app' : 'Browser tab'}${navigator.onLine ? '' : ' (offline)'}`,
    `Storage: ${await storageLine()}`,
    `Service Worker: ${window.__xcoderSW ? 'active (works offline)' : 'not active'}`
  ].join('\n');
  const choice = await dialogs.show({ type: 'info', message: 'X Coder', detail, buttons: ['Copy', 'OK'], defaultId: 1, cancelId: 1 });
  if (choice === 0) { await copyText(detail); notify.info('Copied version information to the clipboard.', { source: 'X Coder' }); }
  return detail;
}

// ---------------- Check for Updates ----------------
let checking = false;
async function checkForUpdates() {
  if (checking) return;
  if (updateWaiting()) {
    notify.info('An update to X Coder has been downloaded.', { source: 'X Coder', actions: [{ label: 'Restart to Update', run: () => applyWaitingUpdate() }] });
    return 'ready';
  }
  const reg = window.__xcoderSW;
  if (!reg) {
    notify.info(`X Coder ${appVersion()} · updates are installed automatically when the app is served over HTTPS with its service worker. The service worker is not active here (private browsing, a local file, or the page was loaded without it) — reload to get the latest version.`, { source: 'X Coder', actions: [{ label: 'Reload', run: () => commands.execute('workbench.action.reloadWindow') }] });
    return 'unavailable';
  }
  if (!navigator.onLine) { notify.warn('You are offline. Connect to the internet to check for updates.', { source: 'X Coder' }); return 'offline'; }
  checking = true;
  const n = notify.progress('Checking for Updates…', { source: 'X Coder' });
  try {
    await reg.update();
    n.close();
    if (reg.installing || reg.waiting) {
      if (reg.waiting) notify.info('An update to X Coder is ready.', { source: 'X Coder', actions: [{ label: 'Restart to Update', run: () => applyWaitingUpdate() }] });
      else notify.info('Downloading an update to X Coder… You will be asked to reload when it is ready.', { source: 'X Coder' });
      refreshUpdateBadge();
      return 'available';
    }
    notify.info(`There are currently no updates available. X Coder ${appVersion()} is up to date.`, { source: 'X Coder' });
    return 'current';
  } catch (err) {
    n.close();
    notify.error(`Could not check for updates: ${err.message}`, { source: 'X Coder' });
    return 'error';
  } finally { checking = false; }
}

function refreshUpdateBadge() {
  try { activityBar.setGlobalBadge('manage', updateWaiting() ? 1 : null); } catch {}
}

// ---------------- Release Notes editor ----------------
async function renderMarkdownInto(el, markdown) {
  const { marked, DOMPurify } = await import('../../../vendor/markdown.js');
  const html = DOMPurify.sanitize(marked.parse(markdown, { gfm: true }), { ADD_ATTR: ['target'] });
  el.innerHTML = html;
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  }
}
export { renderMarkdownInto };

function registerReleaseNotesEditor() {
  if (editors.provider('release-notes')) return; // the Welcome feature may provide its own
  editors.registerProvider('release-notes', {
    title: () => `Release Notes: ${appVersion()}`,
    tooltip: () => `X Coder ${appVersion()} Release Notes`,
    icon: () => codiconHtml('info'),
    create(input, container) {
      container.classList.add('xc-release-notes-editor');
      const body = h('div', { class: 'xc-markdown release-notes-body', role: 'document' }, h('p', { class: 'xc-muted' }, 'Loading release notes…'));
      const scroller = h('div', { class: 'xc-release-notes-scroll' }, body);
      container.append(scroller);
      (async () => {
        try {
          const res = await fetch(new URL('../../../docs/RELEASE_NOTES.md', import.meta.url), { cache: 'no-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await renderMarkdownInto(body, await res.text());
        } catch (err) {
          body.replaceChildren(h('h1', {}, `X Coder ${appVersion()}`), h('p', {}, `The release notes could not be loaded (${err.message}). They are available online at `, h('a', { href: `${REPO_URL}/blob/main/docs/RELEASE_NOTES.md`, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub'), '.'));
        }
      })();
      return { dispose() {}, focus() { scroller.focus?.({ preventScroll: true }); } };
    }
  });
}

// ---------------- registration ----------------
export function registerAppCommands() {
  registerReleaseNotesEditor();
  if (!settings.schema('files.autoSave')) {
    settings.register([
      { key: 'files.autoSave', type: 'enum', enum: ['off', 'afterDelay', 'onFocusChange'], enumLabels: ['off', 'afterDelay', 'onFocusChange'], enumDescriptions: ['An editor with changes is never automatically saved.', 'An editor with changes is automatically saved after the configured Auto Save Delay.', 'An editor with changes is automatically saved when the editor loses focus.'], default: 'off', title: 'Auto Save', description: 'Controls auto save of editors that have unsaved changes.', category: 'Text Editor/Files', common: true, order: 1 },
      { key: 'files.autoSaveDelay', type: 'number', default: 1000, min: 100, max: 60000, integer: true, title: 'Auto Save Delay', description: 'Controls the delay in milliseconds after which an editor with unsaved changes is saved automatically. Only applies when Auto Save is set to afterDelay.', category: 'Text Editor/Files', order: 2 }
    ]);
  }
  commands.registerAll([
    { id: 'workbench.action.selectTheme', title: 'Color Theme', category: 'Preferences', icon: 'color-mode', run: () => selectTheme() },
    { id: 'workbench.action.toggleAutoSave', title: 'Toggle Auto Save', category: 'File', run: () => toggleAutoSave() },
    { id: 'workbench.action.openView', title: 'Open View', category: 'View', run: () => openView() },
    { id: 'workbench.action.toggleDevTools', title: 'Toggle Developer Tools', category: 'Developer', keybinding: isApple ? 'Mod+Alt+I' : 'Ctrl+Shift+I', run: () => toggleDevTools() },
    { id: 'workbench.action.showAboutDialog', title: 'About', category: 'Help', icon: 'info', run: () => showAbout() },
    { id: 'update.checkForUpdates', title: 'Check for Updates…', category: 'Help', run: () => checkForUpdates() },
    { id: 'update.showCurrentReleaseNotes', title: 'Show Release Notes', category: 'Help', run: () => editors.open({ type: 'release-notes' }, { pinned: true }) },
    { id: 'workbench.action.openDocumentationUrl', title: 'Documentation', category: 'Help', icon: 'book', run: () => openExternal(`${REPO_URL}#readme`) },
    { id: 'workbench.action.openIssueReporter', title: 'Report Issue', category: 'Help', icon: 'report', run: () => openExternal(`${REPO_URL}/issues/new`) }
  ]);
  // The Welcome feature owns the reference command; provide it when that feature is unavailable.
  if (!commands.has('workbench.action.keybindingsReference')) {
    commands.register({ id: 'workbench.action.keybindingsReference', title: 'Keyboard Shortcuts Reference', category: 'Help', run: () => commands.execute('workbench.action.openGlobalKeybindings') });
  }

  // Manage gear badge when a downloaded update is waiting (VS Code shows "Restart to Update (1)").
  refreshUpdateBadge();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUpdateBadge(); });
  bus.on('workbench:ready', () => {
    const reg = window.__xcoderSW;
    reg?.addEventListener?.('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => refreshUpdateBadge());
    });
    refreshUpdateBadge();
  });
}
