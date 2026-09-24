// OUTPUT panel tab: renders core/output.js channels in VS Code's log format
// ('2026-09-23 10:00:00.123 [info] message') with log colouring, a channel dropdown, Clear Output,
// Turn Auto Scrolling Off/On (lock) and Toggle Word Wrap.

import { h, codicon, clear, copyText } from '../core/dom.js';
import { output, outputEvents } from '../core/output.js';
import { layout } from '../workbench/layout.js';
import { panel } from '../workbench/panel.js';
import { showContextMenu } from '../platform/contextmenu.js';

const STORE = 'xcoder.output.view';
const prefs = { channel: 'X Coder', scrollLock: false, wordWrap: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
const savePrefs = () => { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch {} };

const p2 = n => String(n).padStart(2, '0');
/** VS Code log timestamp in local time: 2026-09-23 10:00:00.123 */
export function formatLogTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
export function formatLogLine(line) { return `${formatLogTime(line.time)} [${line.level}] ${line.text}`; }

function currentChannel() {
  const list = output.channels();
  return list.find(c => c.name === prefs.channel) || list.find(c => c.name === 'X Coder') || list[0] || null;
}

function renderLine(line) {
  const level = ['error', 'warning', 'info', 'debug', 'trace'].includes(line.level) ? line.level : 'info';
  const text = h('span', { class: 'log-text' });
  // Colour quoted strings and URLs like VS Code's log grammar.
  const re = /(https?:\/\/[^\s"'<>)]+)|("[^"\n]*"|'[^'\n]*')/g;
  let last = 0, m;
  const src = String(line.text);
  while ((m = re.exec(src))) {
    if (m.index > last) text.append(src.slice(last, m.index));
    text.append(h('span', { class: m[1] ? 'log-link' : 'log-string' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < src.length) text.append(src.slice(last));
  return h('div', { class: ['output-line', `level-${level}`] },
    h('span', { class: 'log-date' }, formatLogTime(line.time)), ' ',
    h('span', { class: 'log-level' }, `[${line.level}]`), ' ', text);
}

let view = null;

class OutputView {
  constructor(host) {
    host.classList.add('output-panel');
    this.host = host;
    this.log = h('div', { class: 'output-log', tabindex: '0', role: 'document', 'aria-label': 'Output' });
    this.empty = h('div', { class: 'output-empty' });
    host.append(this.log);
    this.atBottom = true;
    this.log.addEventListener('scroll', () => {
      this.atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 12;
    }, { passive: true });
    this.load();
  }
  get channel() { return currentChannel(); }
  load() {
    const ch = this.channel;
    clear(this.log);
    this.log.classList.toggle('wrap', !!prefs.wordWrap);
    if (!ch) return;
    const frag = document.createDocumentFragment();
    for (const l of ch.lines) frag.append(renderLine(l));
    this.log.append(frag);
    this.scrollIfNeeded(true);
  }
  append(channel, line) {
    if (channel !== this.channel) return;
    this.log.append(renderLine(line));
    while (this.log.childElementCount > 2000) this.log.firstElementChild.remove();
    this.scrollIfNeeded();
  }
  scrollIfNeeded(force = false) {
    if (prefs.scrollLock && !force) return;
    if (!force && !this.atBottom) return; // smart scroll: the user scrolled up to read
    requestAnimationFrame(() => { this.log.scrollTop = this.log.scrollHeight; this.atBottom = true; });
  }
}

function channelSwitcher() {
  const ch = currentChannel();
  if (!layout.isPhone) {
    const sel = h('select', { class: 'xc-select output-channel-select', title: 'Output Channels', 'aria-label': 'Output Channels' });
    for (const c of [...output.channels()].sort((a, b) => a.name.localeCompare(b.name))) sel.append(h('option', { value: c.name, selected: c === ch }, c.name));
    sel.addEventListener('change', () => showChannel(sel.value));
    return sel;
  }
  const btn = h('a', { class: 'output-channel-button', role: 'button', tabindex: '0', title: 'Output Channels', 'aria-label': `Output Channels: ${ch?.name || ''}` },
    h('span', { class: 'label' }, ch?.name || 'Output'), codicon('chevron-down'));
  btn.addEventListener('click', () => showContextMenu(
    [...output.channels()].sort((a, b) => a.name.localeCompare(b.name)).map(c => ({ label: c.name, checked: c === currentChannel(), run: () => showChannel(c.name) })),
    { anchor: btn, align: 'right' }));
  return btn;
}

export function showChannel(name) {
  prefs.channel = name;
  savePrefs();
  view?.load();
  if (panel.activeId === 'output') panel.refreshActions();
}

export function clearOutput() { currentChannel()?.clear(); }

function toggleWrap() { prefs.wordWrap = !prefs.wordWrap; savePrefs(); view?.log.classList.toggle('wrap', prefs.wordWrap); panel.refreshActions(); }
function toggleLock() { prefs.scrollLock = !prefs.scrollLock; savePrefs(); if (!prefs.scrollLock) view?.scrollIfNeeded(true); panel.refreshActions(); }

export const outputTab = {
  id: 'output',
  title: 'Output',
  order: 2,
  keybinding: 'Mod+Shift+U',
  render(host) {
    view = new OutputView(host);
    return { onShow: () => {}, focus: () => view?.log.focus({ preventScroll: true }), dispose: () => { view = null; } };
  },
  actions() {
    return [
      { element: channelSwitcher() },
      ...(layout.isPhone ? [] : [{ icon: 'word-wrap', title: 'Toggle Word Wrap', checked: prefs.wordWrap, run: toggleWrap }]),
      { icon: prefs.scrollLock ? 'lock' : 'unlock', title: prefs.scrollLock ? 'Turn Auto Scrolling On' : 'Turn Auto Scrolling Off', checked: prefs.scrollLock, run: toggleLock },
      { icon: 'clear-all', title: 'Clear Output', run: clearOutput }
    ];
  },
  moreActions() {
    return [
      { label: 'Toggle Word Wrap', checked: prefs.wordWrap, run: toggleWrap },
      { label: prefs.scrollLock ? 'Turn Auto Scrolling On' : 'Turn Auto Scrolling Off', run: toggleLock },
      { separator: true },
      { label: 'Copy All', icon: 'copy', run: () => copyText(currentChannel()?.lines.map(formatLogLine).join('\n') || '') },
      { label: 'Clear Output', icon: 'clear-all', run: clearOutput }
    ];
  }
};

outputEvents.on('append', (channel, line) => view?.append(channel, line));
outputEvents.on('clear', channel => { if (channel === currentChannel()) view?.load(); });
outputEvents.on('added', () => { if (panel.activeId === 'output') panel.refreshActions(); });
outputEvents.on('show', channel => {
  showChannel(channel.name);
  panel.open('output');
});
