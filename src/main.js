// X Coder bootstrap: VS Code–style workbench for iPhone and the browser.
// Core services start first; feature modules ("contributions") are loaded in isolation so one
// failing feature can never take down the editor.

import { $ } from './core/dom.js';
import { bus } from './core/events.js';
import { settings, migrateLegacySettings, migrateLegacyEditorSettings } from './core/settings.js';
import { installKeybindings } from './core/commands.js';
import { kvGet, requestPersistentStorage } from './core/db.js';
import { workspace } from './core/workspace.js';
import { log } from './core/output.js';
import { notify } from './platform/notifications.js';
import { initTheme } from './workbench/theme.js';
import { layout } from './workbench/layout.js';
import { views } from './workbench/views.js';
import { panel } from './workbench/panel.js';
import { editors, initEditorPart } from './workbench/editors.js';
import { initTitlebar } from './workbench/titlebar.js';
import { initFileIcons } from './workbench/icons.js';
import { registerCoreCommands, initCoreStatusbar } from './workbench/coreCommands.js';

export const VERSION = '6.0.0';

const FEATURES = [
  ['Editor', () => import('./editor/index.js')],
  ['Explorer', () => import('./views/explorer.js')],
  ['Search', () => import('./views/search.js')],
  ['Source Control', () => import('./scm/index.js')],
  ['Preview', () => import('./preview/index.js')],
  ['Run and Debug', () => import('./views/run.js')],
  ['Panel', () => import('./panel/index.js')],
  ['Extensions', () => import('./views/extensions.js')],
  ['X Coder AI', () => import('./ai/index.js')],
  ['Accounts & Cloud', () => import('./cloud/index.js')],
  ['Welcome', () => import('./views/welcome.js')],
  ['Settings', () => import('./views/settingsEditor.js')],
  ['Workbench', () => import('./workbench/contributions.js')]
];

async function activateFeatures() {
  const failures = [];
  for (const [name, load] of FEATURES) {
    const started = performance.now();
    try {
      const mod = await load();
      await mod.activate?.();
      log.debug(`Activated ${name} in ${Math.round(performance.now() - started)} ms`);
    } catch (err) {
      console.error(`[X Coder] ${name} failed to activate`, err);
      log.error(`${name} failed to activate:`, err);
      failures.push(name);
    }
  }
  if (failures.length) notify.error(`Some features failed to load: ${failures.join(', ')}. Check Output → X Coder for details.`, { source: 'X Coder' });
}

async function restoreEditorsForProject() {
  let session = await workspace.sessionGet('workbench.session', null);
  if (!session) {
    // X Coder ≤5.1 stored { openTabs, activePath }.
    const legacy = await workspace.sessionGet('session', null);
    if (legacy?.openTabs?.length) {
      session = {
        editors: legacy.openTabs.filter(p => workspace.fs.exists(p)).map(path => ({ type: 'file', data: { type: 'file', path }, pinned: true })),
        active: legacy.activePath ? `file:${legacy.activePath}` : null
      };
    }
  }
  let restored = 0;
  try { restored = await editors.restoreSession(session); } catch (err) { log.error('Could not restore editors', err); }
  if (!restored) {
    const startup = settings.get('workbench.startupEditor', 'welcomePage');
    try {
      if (startup === 'welcomePage' && editors.provider('welcome')) await editors.open({ type: 'welcome' }, { pinned: true, focus: false });
      else if (startup === 'readme') {
        const readme = workspace.fs.files().find(r => /^readme(\.md)?$/i.test(r.path));
        if (readme) await editors.open({ type: 'file', path: readme.path }, { pinned: true, focus: false });
      }
    } catch (err) { log.error('Startup editor failed', err); }
  }
}

function hideBootScreen() {
  const boot = $('#boot-screen');
  if (!boot) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 350);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing || !window.__xcoderUpdateRequested) return;
      refreshing = true; location.reload();
    });
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          notify.info('A new version of X Coder is available.', {
            source: 'X Coder', actions: [{ label: 'Reload to Update', run: () => { window.__xcoderUpdateRequested = true; worker.postMessage({ type: 'skipWaiting' }); setTimeout(() => location.reload(), 1500); } }]
          });
        }
      });
    });
    window.__xcoderSW = reg;
  } catch (err) { log.warn('Service worker registration failed', err); }
}

async function boot() {
  migrateLegacySettings();
  initTheme();
  installKeybindings();
  layout.init();
  initTitlebar();
  initEditorPart();
  registerCoreCommands();
  initCoreStatusbar();
  await initFileIcons();

  await activateFeatures();
  views.restore();
  panel.restore();

  bus.on('project:opened', () => { restoreEditorsForProject(); });
  try {
    await workspace.init();
  } catch (err) {
    console.error(err);
    log.error('Could not open the project database', err);
    notify.error(`X Coder could not open local storage: ${err.message}. Private Browsing and storage limits can block IndexedDB.`, { sticky: true });
  }
  migrateLegacyEditorSettings(kvGet);
  requestPersistentStorage();
  hideBootScreen();
  registerServiceWorker();
  document.documentElement.dataset.xcoderVersion = VERSION;
  bus.emit('workbench:ready');
  log.info(`X Coder ${VERSION} ready · ${navigator.userAgent}`);
}

window.addEventListener('error', e => log.error(`Uncaught: ${e.message}`, e.error?.stack || ''));
window.addEventListener('unhandledrejection', e => log.error('Unhandled rejection:', e.reason?.stack || e.reason));
document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });

boot().catch(err => {
  console.error(err);
  hideBootScreen();
  const pre = document.createElement('pre');
  pre.className = 'fatal-error';
  pre.textContent = `X Coder failed to start:\n${err?.stack || err}`;
  document.body.append(pre);
});
