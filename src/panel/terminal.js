// Integrated Terminal: xterm-look rendering, input handling (iPhone-first) and terminal instances.
//
//   terminals.create({ cwd })   → TerminalInstance (becomes active)     terminals.active / .list
//   terminals.setActive(inst)   terminals.kill(inst)   terminals.onDidChange(fn)
//   instance.enqueue('ls -la')  → Promise<{ exitCode, output }> (echoed like typed input)
//   instance.clear()  instance.focus({ gesture })  instance.recentOutput(n)
//
// Rendering: output is kept as a line model of styled runs (see ansi.js) and synced to the DOM in one
// animation frame (scrollback trimmed first). The prompt, the typed text and the block cursor are drawn
// inside the last line; the real keyboard target is a transparent <textarea> positioned at the cursor, so
// iOS shows the keyboard on tap, autocorrect/IME/dictation work, and the caret is replaced by our cursor.

import { h, codicon, isTouch, isApple, copyText } from '../core/dom.js';
import { bus, Emitter } from '../core/events.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { kvSet } from '../core/db.js';
import { log } from '../core/output.js';
import { posix } from '../core/path.js';
import { AnsiParser, styleToAttrs, stripAnsi, sgr } from './ansi.js';
import { Shell } from './shell.js';
import { columnize } from './builtins.js';

const HISTORY_KEY = 'terminal.history';
const HISTORY_MAX = 500;
const ALIASES_KEY = 'xcoder.terminal.aliases';

// ---------------------------------------------------------------- shared history (per project)

const history = {
  list: [],
  loadedFor: null,
  async load() {
    const id = workspace.project?.id || null;
    if (this.loadedFor === id) return;
    this.loadedFor = id;
    try { const saved = await workspace.sessionGet(HISTORY_KEY, []); this.list = Array.isArray(saved) ? saved.filter(s => typeof s === 'string').slice(-HISTORY_MAX) : []; }
    catch { this.list = []; }
  },
  add(line) {
    if (!line.trim() || /^\s/.test(line)) return; // HISTCONTROL=ignorespace
    line = line.replace(/\s+$/, '');
    if (this.list[this.list.length - 1] === line) return;
    this.list.push(line);
    if (this.list.length > HISTORY_MAX) this.list.splice(0, this.list.length - HISTORY_MAX);
    this.save();
  },
  clear() { this.list = []; this.save(); },
  // Debounced write, bound to the project that owns the list (even if another project opens first).
  save() {
    const id = this.loadedFor;
    if (!id) return;
    if (this.pending && this.pending.id !== id) this.flush();
    this.pending = { id, list: this.list };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  },
  flush() {
    clearTimeout(this.timer);
    const p = this.pending;
    this.pending = null;
    if (p) kvSet(`${HISTORY_KEY}:${p.id}`, p.list.slice(-HISTORY_MAX)).catch(() => {});
  }
};

function loadAliases(shell) {
  try {
    const saved = JSON.parse(localStorage.getItem(ALIASES_KEY) || 'null');
    if (saved && typeof saved === 'object') shell.aliases = new Map(Object.entries(saved).filter(([k, v]) => typeof v === 'string' && k));
  } catch {}
}
function saveAliases(shell) {
  try { localStorage.setItem(ALIASES_KEY, JSON.stringify(Object.fromEntries(shell.aliases))); } catch {}
}

// ---------------------------------------------------------------- screen model

class Screen {
  constructor(rowsEl, liveEl) {
    this.rowsEl = rowsEl;
    this.liveEl = liveEl;
    this.parser = new AnsiParser();
    this.lines = [];
    this.cr = false;
    this.scheduled = false;
    this.onFlush = null;
    this.pushLine();
  }
  get current() { return this.lines[this.lines.length - 1]; }
  pushLine() { this.lines.push({ runs: [], el: null, dirty: true }); }
  write(text) {
    this.parser.feed(text, (t, style) => this.text(t, style), kind => this.control(kind));
    this.schedule();
  }
  text(t, style) {
    const line = this.current;
    if (this.cr) { line.runs = []; this.cr = false; }
    const attrs = styleToAttrs(style);
    const key = attrs ? `${attrs.class}|${attrs.style}` : '';
    const last = line.runs[line.runs.length - 1];
    if (last && last.key === key) last.text += t;
    else line.runs.push({ text: t, attrs, key });
    line.dirty = true;
  }
  control(kind) {
    if (kind === 'newline') { this.cr = false; this.pushLine(); }
    else if (kind === 'cr') this.cr = true;
    else if (kind === 'eraseLine') { this.current.runs = []; this.current.dirty = true; }
    else if (kind === 'clear') this.reset();
  }
  reset() {
    for (const l of this.lines) l.el?.remove();
    this.lines = [];
    this.cr = false;
    this.pushLine();
    this.schedule();
  }
  /** Ends the current line if it has content (so the prompt starts at column 0, like zsh). */
  ensureLineStart() {
    if (this.current.runs.some(r => r.text.length)) { this.pushLine(); this.schedule(); }
    this.cr = false;
  }
  lineText(l) { return l.runs.map(r => r.text).join(''); }
  plainText(from = 0) { return this.lines.slice(from).map(l => this.lineText(l)).join('\n'); }
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => this.flush());
  }
  flush() {
    this.scheduled = false;
    const limit = Math.max(100, Number(settings.get('terminal.integrated.scrollback', 1000)) || 1000);
    if (this.lines.length > limit) {
      const removed = this.lines.splice(0, this.lines.length - limit);
      for (const l of removed) l.el?.remove();
    }
    // Only the tail of the buffer changes: find the first line that needs work.
    let i = this.lines.length - 1;
    while (i > 0 && (this.lines[i - 1].dirty || !this.lines[i - 1].el)) i--;
    for (; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (!l.el) { l.el = h('div', { class: 'xterm-line' }); this.rowsEl.append(l.el); l.dirty = true; }
      if (l.dirty) {
        l.el.textContent = '';
        // Links (URLs, project files with :line:col) may span several styled runs.
        const links = this.linkify ? this.linkify(this.lineText(l)) : [];
        let offset = 0;
        for (const r of l.runs) {
          if (!r.text) continue;
          const end = offset + r.text.length;
          let pos = offset;
          while (pos < end) {
            const link = links.find(k => k.start <= pos && k.end > pos);
            const next = link ? Math.min(end, link.end) : Math.min(end, ...links.filter(k => k.start > pos).map(k => k.start), end);
            const text = r.text.slice(pos - offset, next - offset);
            let node;
            if (r.attrs) {
              node = document.createElement('span');
              if (r.attrs.class) node.className = r.attrs.class;
              if (r.attrs.style) node.style.cssText = r.attrs.style;
              node.textContent = text;
            } else node = document.createTextNode(text);
            if (link) {
              const a = document.createElement('a');
              a.className = 'xterm-link';
              if (link.url) { a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = `Follow link (${isApple ? '⌘' : 'Ctrl'} + click)`; }
              else { a.dataset.path = link.path; a.dataset.line = String(link.line || 1); a.dataset.col = String(link.col || 1); a.title = `Open file in editor (${isApple ? '⌘' : 'Ctrl'} + click)`; a.setAttribute('role', 'link'); }
              a.append(node);
              node = a;
            }
            l.el.append(node);
            pos = next;
          }
          offset = end;
        }
        l.dirty = false;
      }
    }
    const last = this.current.el;
    if (this.liveEl.parentNode !== last || last.lastChild !== this.liveEl) last.append(this.liveEl);
    this.onFlush?.();
  }
}

// ---------------------------------------------------------------- terminal instance

let nextId = 1;

export class TerminalInstance {
  constructor(manager, { cwd = '' } = {}) {
    this.manager = manager;
    this.id = nextId++;
    this.running = null;         // { id, controller, line }
    this.queue = [];             // [{ line, resolve }]
    this.historyIndex = -1;      // -1 = editing the draft
    this.draft = '';
    this.search = null;          // reverse-i-search state { query, index, match }
    this.stickToBottom = true;
    this.disposed = false;
    this.title = 'xsh';

    this.shell = new Shell({
      columns: () => this.columns(),
      clear: () => this.clear(),
      exit: () => { this.exitRequested = true; },
      history: () => history.list.slice(),
      clearHistory: () => history.clear(),
      projectName: () => workspace.project?.name || '',
      saveAliases: () => saveAliases(this.shell)
    });
    loadAliases(this.shell);
    try { if (cwd && workspace.fs && this.shell.isDir(cwd)) this.shell.setCwd(cwd); } catch {}

    this.build();
    this.applySettings();
    this.screen.write(sgr.gray(`xsh — the X Coder shell. Type 'help' to list commands. ~ is the project root.`) + '\n');
    this.renderLive();
  }

  // ---- DOM
  build() {
    this.liveEl = h('span', { class: 'xterm-live' });
    this.rowsEl = h('div', { class: 'xterm-rows', role: 'list', 'aria-live': 'polite' });
    this.measureEl = h('span', { class: 'xterm-char-measure', 'aria-hidden': 'true' }, 'W'.repeat(40));
    this.input = h('textarea', {
      class: 'xterm-helper-textarea', rows: '1', wrap: 'off', 'aria-label': 'Terminal input',
      autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'send',
      'data-gramm': 'false', tabindex: '0'
    });
    this.screenEl = h('div', { class: 'xterm-screen' }, this.rowsEl, this.input, this.measureEl);
    this.viewport = h('div', { class: 'xterm-viewport' }, this.screenEl);
    this.keysEl = this.buildKeyRow();
    this.el = h('div', { class: 'terminal-instance xterm', 'data-terminal-id': String(this.id) }, this.viewport, this.keysEl);
    this.screen = new Screen(this.rowsEl, this.liveEl);
    this.screen.onFlush = () => this.afterFlush();
    this.screen.linkify = text => this.linkify(text);

    this.input.addEventListener('keydown', e => this.onKeyDown(e));
    this.input.addEventListener('input', e => { if (e.inputType !== 'insertFromPaste') undoSmartPunctuation(this.input); this.onInput(); });
    this.input.addEventListener('beforeinput', e => {
      if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); this.submit(); }
    });
    this.input.addEventListener('focus', () => { this.el.classList.add('focused'); this.manager.setFocused(this, true); this.renderLive(); this.scrollToBottom(); });
    this.input.addEventListener('blur', () => { this.el.classList.remove('focused'); this.manager.setFocused(this, false); this.renderLive(); });
    this.input.addEventListener('keyup', () => this.renderLive());
    this.input.addEventListener('select', () => this.renderLive());
    this.input.addEventListener('compositionend', () => this.renderLive());

    // Tap/click anywhere focuses the input — unless the user just selected output text.
    // Links open on tap (touch) or Ctrl/⌘+click (mouse), like VS Code's terminal link provider.
    this.viewport.addEventListener('click', e => {
      const link = e.target.closest('.xterm-link');
      if (link) {
        const modifier = isApple ? e.metaKey : e.ctrlKey;
        if (modifier || e.pointerType === 'touch' || isTouch()) {
          e.preventDefault();
          this.openLink(link);
          return;
        }
        e.preventDefault();
      }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && this.el.contains(sel.anchorNode)) return;
      this.focus({ gesture: true });
    });
    this.viewport.addEventListener('scroll', () => {
      const v = this.viewport;
      this.stickToBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 8;
    }, { passive: true });
    this.viewport.addEventListener('contextmenu', e => {
      if (isTouch()) return; // long-press keeps native text selection (copy); actions live in the ••• menu
      e.preventDefault();
      this.manager.showContextMenu(this, { x: e.clientX, y: e.clientY });
    });
    new ResizeObserver(() => {
      this.cols = 0;
      this.positionInput();
      if (this.stickToBottom) this.scrollToBottom(); // e.g. the software keyboard opened
    }).observe(this.viewport);
  }

  buildKeyRow() {
    const keys = [
      { label: 'Tab', title: 'Tab (complete)', run: () => this.complete() },
      { icon: 'arrow-up', title: 'Previous command', run: () => this.historyStep(-1) },
      { icon: 'arrow-down', title: 'Next command', run: () => this.historyStep(1) },
      { icon: 'arrow-left', title: 'Move left', run: () => this.moveCursor(-1) },
      { icon: 'arrow-right', title: 'Move right', run: () => this.moveCursor(1) },
      { label: '^C', title: 'Ctrl+C (interrupt)', run: () => this.interrupt() },
      { label: 'Esc', title: 'Escape (clear line)', run: () => this.escape() },
      ...['|', '/', '-', '~', '>', '&'].map(ch => ({ label: ch, title: ch, run: () => this.insertText(ch) })),
      { icon: 'chevron-down', title: 'Hide Keyboard', run: () => this.input.blur(), noRefocus: true }
    ];
    const row = h('div', { class: 'terminal-keys', role: 'toolbar', 'aria-label': 'Terminal keys' });
    for (const k of keys) {
      const b = h('button', { class: ['terminal-key', k.icon && 'icon-key'], type: 'button', tabindex: '-1', title: k.title, 'aria-label': k.title, 'data-key': k.label || k.icon },
        k.icon ? codicon(k.icon) : k.label);
      // Never take focus from the textarea (the software keyboard must stay up); a horizontal swipe
      // scrolls the row instead of pressing a key.
      let startX = 0, moved = false;
      b.addEventListener('pointerdown', e => { e.preventDefault(); startX = e.clientX; moved = false; b.classList.add('pressed'); });
      b.addEventListener('pointermove', e => { if (Math.abs(e.clientX - startX) > 8) { moved = true; b.classList.remove('pressed'); } });
      for (const ev of ['pointerleave', 'pointercancel']) b.addEventListener(ev, () => b.classList.remove('pressed'));
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        b.classList.remove('pressed');
        if (moved) { moved = false; return; }
        try { k.run(); } catch (err) { log.error('Terminal key failed', err); }
        if (!k.noRefocus) this.focus({ gesture: false });
      });
      row.append(b);
    }
    return row;
  }

  /** Finds URLs and existing project files (optionally with :line:col) in a line of output. */
  linkify(text) {
    if (!text || text.length > 2000) return [];
    const links = [];
    const urlRe = /\bhttps?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g;
    let m;
    while ((m = urlRe.exec(text))) links.push({ start: m.index, end: m.index + m[0].length, url: m[0] });
    const fs = workspace.fs;
    if (fs) {
      const pathRe = /(?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]+(?:(?::(\d+)(?::(\d+))?)|(?:\((\d+),\s?(\d+)\)))?/g;
      while ((m = pathRe.exec(text))) {
        const start = m.index, end = start + m[0].length;
        if (links.some(k => start < k.end && end > k.start)) continue;
        if (start > 0 && /[\w/.:-]/.test(text[start - 1])) continue;
        const raw = m[0].replace(/(?::\d+(?::\d+)?|\(\d+,\s?\d+\))$/, '');
        let path;
        try { path = this.shell.resolve(raw); } catch { continue; }
        if (!path || !fs.isFile(path)) { try { if (!fs.isFile(raw.replace(/^\/+/, ''))) continue; path = raw.replace(/^\/+/, ''); } catch { continue; } }
        links.push({ start, end, path, line: Number(m[1] || m[3]) || 1, col: Number(m[2] || m[4]) || 1 });
      }
    }
    return links.sort((a, b) => a.start - b.start);
  }

  openLink(a) {
    if (a.href && !a.dataset.path) { window.open(a.href, '_blank', 'noopener,noreferrer'); return; }
    const path = a.dataset.path;
    if (!path) return;
    import('../workbench/editors.js').then(({ editors }) => editors.open({ type: 'file', path }, {
      pinned: true, reveal: { line: Number(a.dataset.line) || 1, col: Number(a.dataset.col) || 1 }
    })).catch(err => log.error('Could not open terminal link', err));
  }

  applySettings() {
    const size = Number(settings.get('terminal.integrated.fontSize', 13)) || 13;
    const family = String(settings.get('terminal.integrated.fontFamily', '') || '').trim();
    const lh = Number(settings.get('terminal.integrated.lineHeight', 1)) || 1;
    this.el.style.setProperty('--terminal-font-size', `${size}px`);
    this.el.style.setProperty('--terminal-line-height', String(Math.round(1.2 * lh * 100) / 100));
    if (family) this.el.style.setProperty('--terminal-font-family', family); else this.el.style.removeProperty('--terminal-font-family');
    const style = settings.get('terminal.integrated.cursorStyle', 'block');
    this.el.dataset.cursorStyle = ['block', 'line', 'underline'].includes(style) ? style : 'block';
    this.el.classList.toggle('cursor-blink', !!settings.get('terminal.integrated.cursorBlinking', true));
    this.cols = 0;
    this.renderLive();
  }

  /** Terminal width in character cells (ls columns, $COLUMNS). */
  columns() {
    if (this.cols) return this.cols;
    const w = this.measureEl.getBoundingClientRect().width / 40;
    const avail = this.screenEl.clientWidth;
    if (!w || !avail) return 80;
    this.cols = Math.max(20, Math.floor(avail / w) - 1);
    return this.cols;
  }

  // ---- prompt + live input line
  promptText() {
    const shell = this.shell;
    try { if (shell.cwd && workspace.fs && !shell.isDir(shell.cwd)) shell.cwd = ''; } catch {}
    const user = shell.vars.get('USER') || 'user', host = shell.vars.get('HOSTNAME') || 'xcoder';
    return `${sgr.boldGreen(`${user}@${host}`)}:${sgr.boldBlue(shell.promptPath())}$ `;
  }

  renderLive() {
    if (this.disposed) return;
    const live = this.liveEl;
    live.textContent = '';
    const value = this.input.value;
    let start = this.input.selectionStart ?? value.length, end = this.input.selectionEnd ?? start;
    let prefix = '', text = value;
    if (this.search) {
      const s = this.search;
      prefix = `(${s.failed ? 'failed ' : ''}reverse-i-search)\`${s.query}': `;
      text = s.match ?? '';
      start = end = Math.max(0, s.matchPos ?? text.length);
    } else if (!this.running) prefix = this.promptText();
    if (prefix) {
      const parser = new AnsiParser();
      parser.feed(prefix, (t, style) => {
        const attrs = styleToAttrs(style);
        live.append(attrs ? h('span', { class: attrs.class || null, style: attrs.style || null }, t) : t);
      }, () => {});
    }
    const focused = document.activeElement === this.input;
    if (start !== end && focused) {
      live.append(text.slice(0, start), h('span', { class: 'xterm-input-selection' }, text.slice(start, end)), text.slice(end));
      this.cursorEl = null;
    } else {
      const ch = text[start] ?? ' ';
      this.cursorEl = h('span', { class: ['xterm-cursor', focused ? 'xterm-cursor-focused' : 'xterm-cursor-blurred'] }, ch === ' ' ? '\u00a0' : ch);
      live.append(text.slice(0, start), this.cursorEl, text.slice(start + 1));
    }
    this.screen.schedule();
  }

  afterFlush() {
    this.positionInput();
    if (this.stickToBottom) this.scrollToBottom();
  }

  positionInput() {
    const c = this.cursorEl || this.liveEl;
    if (!c || !c.isConnected) return;
    this.input.style.top = `${c.offsetTop}px`;
    this.input.style.left = `${Math.min(c.offsetLeft, Math.max(0, this.screenEl.clientWidth - 2))}px`;
  }

  scrollToBottom() {
    const v = this.viewport;
    v.scrollTop = v.scrollHeight;
    this.stickToBottom = true;
  }

  focus({ gesture = false } = {}) {
    if (this.disposed) return;
    // iOS only raises the keyboard for a focus() inside a user gesture; if the textarea is already
    // focused (e.g. programmatically, without a keyboard), blur first so the tap brings it up.
    if (gesture && document.activeElement === this.input && isTouch()) this.input.blur();
    try { this.input.focus({ preventScroll: true }); } catch { this.input.focus(); }
    this.scrollToBottom();
  }

  onShow() {
    this.cols = 0;
    this.applySettingsIfNeeded();
    this.screen.schedule();
    requestAnimationFrame(() => this.scrollToBottom());
  }
  applySettingsIfNeeded() { if (this.settingsDirty) { this.settingsDirty = false; this.applySettings(); } }

  // ---- input handling
  onInput() {
    if (this.search) {
      this.search.query = this.input.value;
      this.findHistory(this.search.index ?? history.list.length, this.search.query);
      this.renderLive();
      return;
    }
    const v = this.input.value;
    if (/[\r\n]/.test(v)) {
      const parts = v.split(/\r?\n|\r/);
      const rest = parts.pop();
      this.input.value = '';
      for (const line of parts) this.submitLine(line);
      this.input.value = rest;
      this.input.setSelectionRange(rest.length, rest.length);
    }
    this.historyIndex = -1;
    this.stickToBottom = true;
    this.renderLive();
  }

  onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); this.renderLive(); };

    if (this.search) {
      if (key === 'Enter') { e.preventDefault(); this.acceptSearch(true); return; }
      if (ctrl && key === 'r') { this.findHistory((this.search.index ?? history.list.length), this.search.query, true); return handled(); }
      if ((ctrl && (key === 'g' || key === 'c')) || key === 'Escape') { this.cancelSearch(key === 'Escape'); return handled(); }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab'].includes(key) || (ctrl && (key === 'a' || key === 'e'))) { this.acceptSearch(false); return handled(); }
      return;
    }

    if (key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); this.submit(); return; }
    if (key === 'Tab' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); this.complete(); return; }
    if (key === 'ArrowUp' && !e.shiftKey && !e.metaKey) { this.historyStep(-1); return handled(); }
    if (key === 'ArrowDown' && !e.shiftKey && !e.metaKey) { this.historyStep(1); return handled(); }
    if (key === 'Escape') { this.escape(); return handled(); }
    if (key === 'PageUp' || key === 'PageDown') { this.viewport.scrollBy(0, (key === 'PageUp' ? -1 : 1) * this.viewport.clientHeight * 0.9); e.preventDefault(); return; }
    if (e.metaKey && isApple && key === 'k') { this.clear(); return handled(); }
    if (!ctrl) return;
    switch (key) {
      case 'c': {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && this.el.contains(sel.anchorNode)) { copyText(sel.toString()); return handled(); }
        this.interrupt(); return handled();
      }
      case 'l': this.clear(); return handled();
      case 'u': this.editLine(v => ({ value: v.slice(this.input.selectionStart), pos: 0 })); return handled();
      case 'k': this.editLine(v => ({ value: v.slice(0, this.input.selectionStart), pos: this.input.selectionStart })); return handled();
      case 'w': this.editLine(v => {
        const p = this.input.selectionStart;
        const before = v.slice(0, p).replace(/\S+\s*$/, '');
        return { value: before + v.slice(p), pos: before.length };
      }); return handled();
      case 'a': this.input.setSelectionRange(0, 0); return handled();
      case 'e': { const n = this.input.value.length; this.input.setSelectionRange(n, n); return handled(); }
      case 'd':
        if (!this.input.value && !this.running) { this.submitLine('exit'); return handled(); }
        this.editLine(v => { const p = this.input.selectionStart; return { value: v.slice(0, p) + v.slice(p + 1), pos: p }; });
        return handled();
      case 'r': this.startSearch(); return handled();
      default: return;
    }
  }

  editLine(fn) {
    const { value, pos } = fn(this.input.value);
    this.input.value = value;
    this.input.setSelectionRange(pos, pos);
    this.historyIndex = -1;
  }

  insertText(text) {
    const s = this.input.selectionStart ?? this.input.value.length, e = this.input.selectionEnd ?? s;
    this.input.setRangeText(text, s, e, 'end');
    this.onInput();
  }

  moveCursor(delta) {
    if (this.search) this.acceptSearch(false);
    const n = this.input.value.length;
    const p = Math.max(0, Math.min(n, (delta < 0 ? this.input.selectionStart : this.input.selectionEnd) + delta));
    this.input.setSelectionRange(p, p);
    this.renderLive();
  }

  escape() {
    if (this.search) { this.cancelSearch(true); return; }
    // Like PowerShell/PSReadLine: Escape reverts the current line.
    this.input.value = '';
    this.historyIndex = -1;
    this.renderLive();
  }

  historyStep(dir) {
    if (this.search) this.acceptSearch(false);
    const list = history.list;
    if (!list.length) return;
    if (this.historyIndex === -1) {
      if (dir > 0) return;
      this.draft = this.input.value;
      this.historyIndex = list.length - 1;
    } else {
      this.historyIndex += dir;
      if (this.historyIndex >= list.length) { this.historyIndex = -1; this.setInput(this.draft); return; }
      if (this.historyIndex < 0) this.historyIndex = 0;
    }
    this.setInput(list[this.historyIndex]);
  }

  setInput(value) {
    this.input.value = value;
    this.input.setSelectionRange(value.length, value.length);
    this.renderLive();
  }

  // ---- reverse-i-search (Ctrl+R)
  startSearch() {
    if (this.search) { this.findHistory(this.search.index ?? history.list.length, this.search.query, true); return; }
    this.search = { query: '', index: history.list.length, match: '', matchPos: 0, saved: this.input.value };
    this.input.value = '';
    this.renderLive();
  }
  findHistory(from, query, older = false) {
    const s = this.search;
    const list = history.list;
    let i = older ? from - 1 : Math.min(from, list.length - 1);
    if (!query) { s.match = ''; s.matchPos = 0; s.failed = false; s.index = list.length; return; }
    for (; i >= 0; i--) {
      const k = list[i].indexOf(query);
      if (k >= 0) { s.index = i; s.match = list[i]; s.matchPos = k; s.failed = false; return; }
    }
    s.failed = true;
  }
  acceptSearch(run) {
    const s = this.search;
    this.search = null;
    const value = s.match || s.saved || '';
    this.input.value = value;
    this.input.setSelectionRange(value.length, value.length);
    if (run) this.submit(); else this.renderLive();
  }
  cancelSearch(keepMatch) {
    const s = this.search;
    this.search = null;
    this.input.value = keepMatch && s.match ? s.match : s.saved;
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.renderLive();
  }

  // ---- tab completion
  complete() {
    if (this.running) return;
    const value = this.input.value;
    const pos = this.input.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    let wordStart = 0, q = null, cmdStart = 0;
    for (let k = 0; k < before.length; k++) {
      const c = before[k];
      if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') k++; continue; }
      if (c === '\\') { k++; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (/[\s<>]/.test(c)) wordStart = k + 1;
      if (/[|;&(]/.test(c)) { wordStart = k + 1; cmdStart = k + 1; }
    }
    const rawWord = before.slice(wordStart);
    const quote = /^["']/.test(rawWord) ? rawWord[0] : '';
    const word = rawWord.replace(/^["']/, '').replace(/\\(.)/g, '$1');
    const prefixText = before.slice(cmdStart, wordStart).trim();
    const words = prefixText ? prefixText.split(/\s+/) : [];
    const atCommand = !words.length || (words.length && words.every(w => /^[A-Za-z_]\w*=/.test(w)));
    const cmdName = words.find(w => !/^[A-Za-z_]\w*=/.test(w)) || '';
    let candidates = [];
    const shell = this.shell;
    if ((atCommand && !word.includes('/')) || ((cmdName === 'help' || cmdName === 'which' || cmdName === 'type' || cmdName === 'man') && !word.includes('/'))) {
      candidates = shell.commandNames().filter(n => n.startsWith(word) && !n.startsWith('__')).map(n => ({ label: n, insert: n, suffix: ' ' }));
    } else {
      try {
        const slash = word.lastIndexOf('/');
        const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
        const base = word.slice(slash + 1);
        const dirPath = dirPart ? shell.resolve(dirPart) : shell.cwd;
        const dirsOnly = cmdName === 'cd' || cmdName === 'rmdir' || cmdName === 'pushd';
        if (workspace.fs && shell.isDir(dirPath)) {
          candidates = workspace.fs.list(dirPath)
            .map(r => ({ name: posix.basename(r.path), folder: r.type === 'folder' }))
            .filter(r => r.name.startsWith(base) && (base.startsWith('.') || !r.name.startsWith('.')) && (!dirsOnly || r.folder))
            .map(r => ({ label: r.name + (r.folder ? '/' : ''), insert: dirPart + r.name, suffix: r.folder ? '/' : ' ', folder: r.folder }));
        }
      } catch {}
    }
    if (!candidates.length) return;
    const esc = s => (quote ? s.replace(new RegExp(quote === '"' ? '(["\\\\$`])' : "(')", 'g'), quote === '"' ? '\\$1' : "'\\''") : s.replace(/([\s'"\\$`&|;<>()*?[\]{}#!])/g, '\\$1'));
    const replaceWord = (text, suffix) => {
      let rep = quote + esc(text);
      if (suffix === ' ') rep += (quote || '') + ' ';
      else if (suffix === '/') rep += '/';
      const next = value.slice(0, wordStart) + rep + value.slice(pos);
      this.input.value = next;
      const at = wordStart + rep.length;
      this.input.setSelectionRange(at, at);
      this.historyIndex = -1;
      this.renderLive();
    };
    if (candidates.length === 1) { replaceWord(candidates[0].insert, candidates[0].suffix); return; }
    let common = candidates[0].insert;
    for (const c of candidates) { let i = 0; while (i < common.length && i < c.insert.length && common[i] === c.insert[i]) i++; common = common.slice(0, i); }
    if (common.length > word.length) { replaceWord(common, ''); return; }
    // Ambiguous: list the candidates below the prompt (bash style), then redraw the prompt.
    const names = candidates.map(c => (c.folder ? sgr.boldBlue(c.label) : c.label)).sort((a, b) => stripAnsi(a).localeCompare(stripAnsi(b)));
    this.screen.write(this.promptText() + escapeControls(value) + '\n' + columnize(names, this.columns()));
    this.stickToBottom = true;
    this.renderLive();
  }

  // ---- execution
  submit() {
    const line = this.input.value;
    this.input.value = '';
    this.historyIndex = -1;
    this.draft = '';
    this.submitLine(line);
  }

  /** Runs a typed line (queued behind a running command, like terminal type-ahead). */
  submitLine(line, resolve) {
    if (this.running) { this.queue.push({ line, resolve }); this.renderLive(); return; }
    this.execute(line).then(r => resolve?.(r));
  }

  enqueue(line) { return new Promise(resolve => this.submitLine(line, resolve)); }

  async execute(line) {
    await history.load();
    // History expansion: !!, !n, !-n, !prefix (outside single quotes).
    const expanded = expandHistory(line);
    if (expanded.error) {
      this.screen.write(this.promptText() + escapeControls(line) + '\n' + `xsh: ${expanded.error}: event not found\n`);
      this.shell.status = 1;
      this.renderLive();
      return { exitCode: 1, output: '' };
    }
    this.screen.write(this.promptText() + escapeControls(line) + '\n');
    if (expanded.line !== line) this.screen.write(escapeControls(expanded.line) + '\n');
    line = expanded.line;
    history.add(line);
    this.stickToBottom = true;
    if (!line.trim() || /^\s*#/.test(line)) { this.renderLive(); this.next(); return { exitCode: this.shell.status, output: '' }; }

    const id = Symbol('run');
    const controller = new AbortController();
    const captured = [];
    let capturedLen = 0;
    const sink = {
      isTTY: true,
      write: t => {
        if (this.running?.id !== id) return;
        const s = String(t);
        this.screen.write(s);
        if (capturedLen < 65536) { captured.push(s); capturedLen += s.length; }
      }
    };
    this.running = { id, controller, line };
    this.setTitle(firstWord(line) || 'xsh');
    this.renderLive();
    let status = 0;
    try {
      status = await this.shell.run(line, { stdout: sink, stderr: sink, stdin: '', signal: controller.signal });
    } catch (err) {
      if (this.running?.id === id) sink.write(`xsh: ${err?.message || err}\n`);
      status = 1;
      log.error('Terminal command failed', err);
    }
    const output = stripAnsi(captured.join(''));
    if (this.running?.id !== id) return { exitCode: 130, output }; // interrupted: prompt already restored
    this.running = null;
    this.setTitle('xsh');
    this.screen.ensureLineStart();
    this.renderLive();
    if (this.exitRequested || this.shell.exitRequested) { this.manager.kill(this); return { exitCode: status, output }; }
    this.next();
    return { exitCode: status, output };
  }

  next() {
    if (this.running || !this.queue.length) return;
    const { line, resolve } = this.queue.shift();
    this.execute(line).then(r => resolve?.(r));
  }

  interrupt() {
    if (this.search) { this.cancelSearch(false); return; }
    if (this.running) {
      const r = this.running;
      this.running = null;
      try { r.controller.abort(); } catch {}
      this.screen.write('^C');
      this.screen.ensureLineStart();
      this.shell.status = 130;
      this.setTitle('xsh');
      for (const q of this.queue.splice(0)) q.resolve?.({ exitCode: 130, output: '' });
      this.renderLive();
      return;
    }
    this.screen.write(this.promptText() + escapeControls(this.input.value) + '^C\n');
    this.input.value = '';
    this.historyIndex = -1;
    this.shell.status = 130;
    this.renderLive();
  }

  clear() {
    this.screen.reset();
    this.stickToBottom = true;
    this.renderLive();
  }

  setTitle(t) {
    if (this.title === t) return;
    this.title = t;
    this.manager.changed();
  }

  /** Last N lines (plain text, no ANSI), including prompts and the current input. */
  recentOutput(n = 80) {
    const lines = this.screen.lines.map(l => this.screen.lineText(l));
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.slice(-n).join('\n');
  }

  /** Project switched: stop work, reset the working directory and start a fresh screen. */
  resetForProject() {
    if (this.running) { try { this.running.controller.abort(); } catch {} this.running = null; }
    for (const q of this.queue.splice(0)) q.resolve?.({ exitCode: 130, output: '' });
    this.shell.cwd = ''; this.shell.oldCwd = '';
    this.shell.status = 0;
    this.search = null;
    this.input.value = '';
    this.setTitle('xsh');
    this.clear();
  }

  dispose() {
    this.disposed = true;
    if (this.running) { try { this.running.controller.abort(); } catch {} this.running = null; }
    for (const q of this.queue.splice(0)) q.resolve?.({ exitCode: 130, output: '' });
    this.el.remove();
  }
}

/**
 * iOS "Smart Punctuation" turns typed quotes into curly quotes and -- into an em dash, which breaks
 * shell syntax. Typed (not pasted) text is mapped back to ASCII, keeping the caret in place.
 */
const SMART = { '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u2018': "'", '\u2019': "'", '\u2014': '--', '\u2013': '-', '\u2026': '...' };
export function undoSmartPunctuation(input) {
  const v = input.value;
  if (!/[\u201c\u201d\u201e\u2018\u2019\u2014\u2013\u2026]/.test(v)) return false;
  const caret = input.selectionStart ?? v.length;
  const before = v.slice(0, caret).replace(/[\u201c\u201d\u201e\u2018\u2019\u2014\u2013\u2026]/g, c => SMART[c]);
  const after = v.slice(caret).replace(/[\u201c\u201d\u201e\u2018\u2019\u2014\u2013\u2026]/g, c => SMART[c]);
  input.value = before + after;
  input.setSelectionRange(before.length, before.length);
  return true;
}

function firstWord(line) { return (line.trim().match(/^(?:[A-Za-z_]\w*=\S*\s+)*([^\s|;&<>]+)/) || [])[1] || ''; }
/** Echoed input must not inject escape sequences into the screen. */
function escapeControls(s) { return String(s).replace(/\x1b/g, '^[').replace(/[\x00-\x08\x0b-\x1f]/g, c => `^${String.fromCharCode(c.charCodeAt(0) + 64)}`); }

export function expandHistory(line) {
  if (!line.includes('!')) return { line };
  const list = history.list;
  let out = '', q = null, error = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { out += c + (line[i + 1] ?? ''); i++; continue; }
    if (q === "'") { if (c === "'") q = null; out += c; continue; }
    if (c === "'" && !q) { q = "'"; out += c; continue; }
    if (c === '"') q = q === '"' ? null : '"';
    if (c === '!' && i + 1 < line.length) {
      const rest = line.slice(i + 1);
      let m;
      if (rest[0] === '!') { if (!list.length) { error = '!!'; break; } out += list[list.length - 1]; i += 1; continue; }
      if ((m = rest.match(/^-?\d+/))) {
        const n = parseInt(m[0], 10);
        const entry = n < 0 ? list[list.length + n] : list[n - 1];
        if (entry == null) { error = `!${m[0]}`; break; }
        out += entry; i += m[0].length; continue;
      }
      if ((m = rest.match(/^[A-Za-z][\w.-]*/)) && !q) {
        const entry = [...list].reverse().find(l => l.startsWith(m[0]));
        if (entry == null) { error = `!${m[0]}`; break; }
        out += entry; i += m[0].length; continue;
      }
    }
    out += c;
  }
  return error ? { line, error } : { line: out };
}

// ---------------------------------------------------------------- manager

export const terminals = {
  list: [],
  active: null,
  focused: null,
  events: new Emitter(), // 'changed' | 'focus' (instance|null)
  create(opts = {}) {
    const inst = new TerminalInstance(this, opts);
    this.list.push(inst);
    this.active = inst;
    history.load().catch(() => {});
    this.changed();
    return inst;
  },
  ensure() { return this.active || this.create(); },
  setActive(inst) {
    if (!inst || this.active === inst) return;
    this.active = inst;
    this.changed();
  },
  kill(inst = this.active) {
    if (!inst) return;
    const i = this.list.indexOf(inst);
    if (i < 0) return;
    this.list.splice(i, 1);
    inst.dispose();
    if (this.active === inst) this.active = this.list[Math.min(i, this.list.length - 1)] || null;
    if (this.focused === inst) this.setFocused(inst, false);
    this.changed({ killed: inst });
  },
  labelOf(inst) { return `${this.list.indexOf(inst) + 1}: ${inst.title}`; },
  changed(detail = {}) { this.events.emit('changed', detail); },
  setFocused(inst, on) {
    const next = on ? inst : (this.focused === inst ? null : this.focused);
    if (next === this.focused) return;
    this.focused = next;
    this.events.emit('focus', next);
  },
  showContextMenu: () => {}, // replaced by the terminal view
  history
};

bus.on('project:willClose', () => history.flush());
bus.on('project:opened', () => {
  history.loadedFor = null;
  history.load().catch(() => {});
  for (const t of terminals.list) t.resetForProject();
});

bus.on('settings:changed', ({ key }) => {
  if (key?.startsWith('terminal.integrated.')) { for (const t of terminals.list) t.settingsDirty = true; terminals.active?.applySettingsIfNeeded(); }
});
