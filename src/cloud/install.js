// xcoder.showInstallHelp — how to install X Coder as an app: iPhone/iPad (Safari → Share → Add to Home
// Screen) and browsers with the PWA install prompt (Chrome, Edge, Android), captured from beforeinstallprompt.

import { h, codicon, isIOS, isStandalone } from '../core/dom.js';
import { notify } from '../platform/notifications.js';
import { modal } from '../scm/ui.js';

let deferredPrompt = null;
let installed = false;

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; installed = true; notify.info('X Coder was installed. Open it from your Home Screen or app list.', { source: 'X Coder' }); });
}

export function canPromptInstall() { return !!deferredPrompt; }

export async function showInstallHelp() {
  if (isStandalone() || installed) {
    await modal({ type: 'info', message: 'X Coder is installed', detail: 'You are running X Coder as an app. It opens full-screen from your Home Screen and keeps working offline.', buttons: [{ label: 'OK', primary: true }] });
    return;
  }
  if (isIOS) {
    const steps = h('ol', { class: 'xc-install-steps' },
      h('li', {}, 'Open X Coder in ', h('b', {}, 'Safari'), ' (on iOS 16.4+ other browsers work too).'),
      h('li', {}, 'Tap the ', h('b', {}, 'Share'), ' button ', codicon('share'), ' in the toolbar.'),
      h('li', {}, 'Scroll down and tap ', h('b', {}, 'Add to Home Screen'), ' ', codicon('add'), ', then tap ', h('b', {}, 'Add'), '.'),
      h('li', {}, 'Open ', h('b', {}, 'X Coder'), ' from your Home Screen — it runs full-screen without Safari’s toolbars.'));
    const note = h('p', { class: 'xc-install-note' }, 'The Home Screen app keeps your projects on this device, works offline, and is exempt from Safari’s 7-day storage cleanup.');
    await modal({ type: 'device-mobile', message: 'Install X Coder on your iPhone or iPad', body: [steps, note], buttons: [{ label: 'OK', primary: true }] });
    return;
  }
  if (deferredPrompt) {
    const prompt = deferredPrompt;
    let choice = null;
    const res = await modal({
      type: 'desktop-download', message: 'Install X Coder',
      detail: 'Install X Coder as an app: it opens in its own window, starts from your app list or Home Screen and works offline.',
      buttons: [
        { label: 'Install', primary: true, value: 'install', run: () => { try { prompt.prompt(); choice = prompt.userChoice; } catch (err) { console.error(err); } } },
        { label: 'Cancel', value: 'cancel' }
      ]
    });
    if (res === 'install' && choice) {
      deferredPrompt = null;
      const outcome = await choice.catch(() => null);
      if (outcome?.outcome === 'accepted') notify.info('Installing X Coder…', { source: 'X Coder' });
    }
    return;
  }
  const steps = h('ul', { class: 'xc-install-steps' },
    h('li', {}, h('b', {}, 'Chrome / Edge: '), 'click the install icon ', codicon('desktop-download'), ' at the right of the address bar, or open the browser menu → ', h('b', {}, 'Install X Coder…'), ' (Chrome: Cast, save, and share → Install page as app).'),
    h('li', {}, h('b', {}, 'Android: '), 'browser menu → ', h('b', {}, 'Install app'), ' or ', h('b', {}, 'Add to Home screen'), '.'),
    h('li', {}, h('b', {}, 'Safari on Mac: '), 'File → ', h('b', {}, 'Add to Dock…'), '.'),
    h('li', {}, h('b', {}, 'iPhone / iPad: '), 'open X Coder in Safari → Share → ', h('b', {}, 'Add to Home Screen'), '.'));
  await modal({ type: 'desktop-download', message: 'Install X Coder as an app', body: [steps, h('p', { class: 'xc-install-note' }, 'This browser has not offered an install prompt for X Coder yet (it appears after a short visit, and only over HTTPS). Firefox on desktop does not install web apps.')], buttons: [{ label: 'OK', primary: true }] });
}
