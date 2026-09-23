// VS Code notification toasts (bottom-right) + notification center.
//
//   notify.info('Pushed to origin/main');
//   notify.error('Push failed: 403', { actions: [{ label: 'Open Settings', run: () => … }], source: 'Git' });
//   const n = notify.progress('Cloning repository…'); n.update('Cloning 40/120'); n.close();
//   await withProgress({ title: 'Formatting' }, async p => { p.report('50%'); … });
//
// Every notification is also kept in the notification center (status bar bell).

import { h, codicon, escapeHtml } from '../core/dom.js';
import { Emitter } from '../core/events.js';

export const notificationEvents = new Emitter(); // 'changed' ({count, unread, doNotDisturb})
const history = [];
let doNotDisturb = false;
let unread = 0;

function host() {
  let el = document.getElementById('notifications-toasts');
  if (!el) { el = h('div', { id: 'notifications-toasts', class: 'notifications-toasts', 'aria-live': 'polite' }); document.body.append(el); }
  return el;
}

const ICONS = { info: 'info', warning: 'warning', error: 'error' };

function emitChanged() { notificationEvents.emit('changed', { count: history.length, unread, doNotDisturb }); }

function create(message, { severity = 'info', actions = [], source = '', sticky = false, progress = false, timeout, detail = '' } = {}) {
  const record = { id: Math.random().toString(36).slice(2), message: String(message), severity, source, actions, time: Date.now(), progress, detail, closed: false };
  history.unshift(record);
  if (history.length > 100) history.pop();
  if (!(doNotDisturb && severity !== 'error')) unread++;
  emitChanged();

  const toast = h('div', { class: `notification-toast ${severity}`, role: severity === 'error' ? 'alert' : 'status' });
  const msg = h('div', { class: 'notification-list-item-message' });
  const renderMessage = text => { msg.innerHTML = linkify(text); };
  renderMessage(record.message);
  const closeBtn = h('a', { class: 'action-label codicon codicon-close', role: 'button', title: 'Clear Notification', 'aria-label': 'Clear Notification' });
  const main = h('div', { class: 'notification-list-item-main-row' },
    h('div', { class: `notification-list-item-icon codicon codicon-${ICONS[severity] || 'info'}` }),
    msg,
    h('div', { class: 'notification-list-item-toolbar-container' }, closeBtn));
  const details = h('div', { class: 'notification-list-item-details-row' },
    h('div', { class: 'notification-list-item-source' }, source ? `Source: ${source}` : ''),
    h('div', { class: 'notification-list-item-buttons-container' },
      ...actions.map((a, i) => {
        const b = h('button', { class: ['monaco-button', i === 0 ? 'primary' : 'secondary'] }, a.label);
        b.addEventListener('click', async () => { if (a.keepOpen !== true) close(); await a.run?.(); });
        return b;
      })));
  const bar = h('div', { class: 'monaco-progress-container' + (progress ? ' active infinite' : ' hidden') }, h('div', { class: 'progress-bit' }));
  toast.append(bar, main);
  if (detail) toast.append(h('div', { class: 'notification-list-item-detail' }, detail));
  if (source || actions.length) toast.append(details);

  let timer = 0;
  const close = () => {
    if (record.closed) return; record.closed = true;
    clearTimeout(timer);
    toast.classList.add('closing');
    setTimeout(() => toast.remove(), 160);
  };
  closeBtn.addEventListener('click', close);

  const quiet = doNotDisturb && severity !== 'error';
  if (!quiet) {
    host().append(toast);
    const toasts = host().children;
    while (toasts.length > 3) toasts[0].remove();
    const ms = timeout ?? (sticky || progress ? 0 : severity === 'error' ? 14000 : actions.length ? 12000 : 6000);
    if (ms) {
      const arm = () => { clearTimeout(timer); timer = setTimeout(close, ms); };
      arm();
      toast.addEventListener('pointerenter', () => clearTimeout(timer));
      toast.addEventListener('pointerleave', arm);
    }
  }

  return {
    record,
    close,
    update(text) { record.message = String(text); renderMessage(record.message); emitChanged(); },
    report(text) { this.update(text); },
    done(text, sev) {
      bar.classList.add('hidden');
      if (text) this.update(text);
      if (sev) { toast.classList.remove('info'); toast.classList.add(sev); }
      clearTimeout(timer); timer = setTimeout(close, 3500);
    }
  };
}

function linkify(text) {
  return escapeHtml(text).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export const notify = Object.assign((message, opts) => create(message, opts), {
  info: (message, opts = {}) => create(message, { ...opts, severity: 'info' }),
  warn: (message, opts = {}) => create(message, { ...opts, severity: 'warning' }),
  error: (message, opts = {}) => create(message instanceof Error ? message.message : message, { ...opts, severity: 'error' }),
  progress: (message, opts = {}) => create(message, { ...opts, severity: 'info', progress: true }),
  history: () => history,
  clearAll() { history.length = 0; unread = 0; host().replaceChildren(); emitChanged(); },
  markRead() { unread = 0; emitChanged(); },
  get doNotDisturb() { return doNotDisturb; },
  setDoNotDisturb(v) { doNotDisturb = !!v; emitChanged(); }
});

/** Runs task(progress) while showing a progress notification. progress.report(text). */
export async function withProgress({ title = 'Working…', source = '' } = {}, task) {
  const n = notify.progress(title, { source });
  try {
    const result = await task({ report: text => n.update(`${title} ${text}`) });
    n.close();
    return result;
  } catch (err) {
    n.close();
    throw err;
  }
}

/** Toggle the notification center (list of recent notifications). */
export function toggleNotificationCenter(force) {
  let el = document.getElementById('notifications-center');
  const open = force ?? !el;
  if (!open) { el?.remove(); return false; }
  if (el) el.remove();
  unread = 0; emitChanged();
  el = h('div', { id: 'notifications-center', class: 'notifications-center', role: 'dialog', 'aria-label': 'Notifications' });
  const header = h('div', { class: 'notifications-center-header' },
    h('div', { class: 'notifications-center-header-title' }, history.length ? 'NOTIFICATIONS' : 'NO NEW NOTIFICATIONS'),
    h('div', { class: 'notifications-center-header-toolbar' },
      iconButton(doNotDisturb ? 'bell-slash' : 'bell', doNotDisturb ? 'Disable Do Not Disturb Mode' : 'Toggle Do Not Disturb Mode', () => { notify.setDoNotDisturb(!doNotDisturb); toggleNotificationCenter(true); }),
      iconButton('clear-all', 'Clear All Notifications', () => { notify.clearAll(); toggleNotificationCenter(true); }),
      iconButton('chevron-down', 'Hide Notifications', () => toggleNotificationCenter(false))));
  const list = h('div', { class: 'notifications-list-container' },
    ...history.map(r => h('div', { class: `notification-list-item ${r.severity}` },
      h('div', { class: 'notification-list-item-main-row' },
        h('div', { class: `notification-list-item-icon codicon codicon-${ICONS[r.severity] || 'info'}` }),
        h('div', { class: 'notification-list-item-message', html: linkify(r.message) })),
      r.source ? h('div', { class: 'notification-list-item-source' }, `Source: ${r.source}`) : null)));
  el.append(header, list);
  document.body.append(el);
  const onDown = e => { if (!el.contains(e.target) && !e.target.closest?.('.statusbar-item.notifications')) { toggleNotificationCenter(false); document.removeEventListener('pointerdown', onDown, true); } };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  return true;
}

function iconButton(icon, title, run) {
  const b = h('a', { class: `action-label codicon codicon-${icon}`, role: 'button', title, 'aria-label': title });
  b.addEventListener('click', run);
  return b;
}
