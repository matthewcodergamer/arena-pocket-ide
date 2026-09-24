// The Chat view (Secondary Side Bar on desktop, full-width overlay on phones): welcome state, the request /
// response list with auto-scroll + "scroll to bottom", the input part, drag & drop of files, the image viewer
// and the response actions (keep/undo edits, diff, retry, votes, copy, read aloud).
//
//   renderChatView(body) → view handle { focus, onShow, onHide, dispose }
//   getChatInput()       → the ChatInput of the rendered view (or null)
//   setEngineForTesting(fake) — see chatSession.js

import { h, codicon, clear, copyText } from '../core/dom.js';
import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { commands } from '../core/commands.js';
import { output } from '../core/output.js';
import { chat, submitChat, markdownText, getEngine, engineIfLoaded } from './chatSession.js';
import { renderRequest, createResponseRow } from './chatRender.js';
import { ChatInput, handleFiles, importProjectAndAnalyze, modeInfo, currentMode } from './chatInput.js';
import { saveImageToProject } from './attachments.js';
import { voice } from './voice.js';

export { setEngineForTesting } from './chatSession.js';

const log = output.channel('X Coder AI');
let current = null; // the rendered view

export function getChatInput() { return current?.input || null; }
export function chatHasFocus() { return !!current?.root.contains(document.activeElement); }

async function notify(kind, msg, opts = {}) {
  try { const { notify: n } = await import('../platform/notifications.js'); return n[kind](msg, { source: 'X Coder AI', ...opts }); } catch { return null; }
}

// ------------------------------------------------------------------ image viewer

export function previewImage(att) {
  const src = att?.dataUrl || att?.thumb;
  if (!src) return;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const save = att.dataUrl ? h('button', { class: 'monaco-button secondary', type: 'button' }, codicon('save'), h('span', {}, 'Save to Project')) : null;
  save?.addEventListener('click', async () => {
    try { const path = await saveImageToProject(att); notify('info', `Saved ${path}.`); close(); } catch (err) { notify('error', err.message); }
  });
  const closeBtn = h('button', { class: 'monaco-button', type: 'button' }, 'Close');
  closeBtn.addEventListener('click', close);
  const overlay = h('div', { class: 'chat-image-preview', role: 'dialog', 'aria-modal': 'true', 'aria-label': att.name || 'Image' },
    h('div', { class: 'chat-image-preview-bar' }, h('span', { class: 'name' }, att.name || 'Image'), att.width ? h('span', { class: 'meta' }, `${att.width}×${att.height}`) : null, h('span', { class: 'spacer' }), save, closeBtn),
    h('div', { class: 'chat-image-preview-body' }, h('img', { src, alt: att.name || 'image' })));
  overlay.addEventListener('click', e => { if (e.target === overlay || e.target.classList.contains('chat-image-preview-body')) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}

// ------------------------------------------------------------------ response actions

async function withErrors(fn) {
  try { return await fn(); } catch (err) { log.warn(err?.stack || String(err)); notify('error', err.message || String(err)); return null; }
}

const speakingState = { id: null };

const responseCtx = {
  keep: (id, editId) => withErrors(async () => {
    const res = await chat.keep(id, editId);
    if (res?.errors?.length) notify('warn', `Some changes could not be kept: ${res.errors.join('; ')}`);
  }),
  undo: (id, editId) => withErrors(async () => {
    const res = await chat.undo(id, editId);
    if (res?.errors?.length) notify('warn', `Some files could not be restored: ${res.errors.join('; ')}`);
  }),
  openDiff: (id, editId) => withErrors(() => chat.openEditDiff(id, editId)),
  retry: id => withErrors(() => chat.retry(id)),
  vote: (id, v) => chat.vote(id, v),
  copy: id => { const t = chat.find(id); if (t) copyText(t.text || markdownText(t)); },
  isSpeaking: id => speakingState.id === id && voice.speaking,
  readAloud: id => {
    const t = chat.find(id);
    if (!t) return;
    if (speakingState.id === id && voice.speaking) { voice.stop(); return; }
    speakingState.id = id;
    voice.speak(t.text || markdownText(t)).catch(err => notify('warn', err.message));
  },
  previewImage,
  openFile: path => openProjectLink(path),
  testProviders: () => commands.execute('xcoder.ai.testProviders')
};

/** Opens a project file referenced by a link in an answer ("src/app.js", "src/app.js#L12", "./a.js:12"). */
async function openProjectLink(href) {
  const fs = workspace.fs;
  if (!fs) return;
  let raw = decodeURIComponent(String(href || '')).replace(/^file:\/\//, '').replace(/^\.?\//, '');
  let line = null;
  const hash = raw.match(/#L(\d+)/i); if (hash) line = +hash[1];
  raw = raw.replace(/#.*$/, '');
  const colon = raw.match(/^(.*?):(\d+)(?::\d+)?$/); if (colon && fs.isFile(colon[1])) { raw = colon[1]; line = +colon[2]; }
  const path = posix.clean(raw);
  if (!fs.isFile(path)) { notify('info', `${path} is not a file in this project.`); return; }
  const { editors } = await import('../workbench/editors.js');
  await editors.open({ type: 'file', path }, line ? { pinned: true, reveal: { line, col: 1 } } : { pinned: true });
}

// ------------------------------------------------------------------ welcome

const SUGGESTIONS = [
  { label: 'Build a to-do app', icon: 'rocket', run: () => submitChat({ text: '/new a to-do app: add, complete, edit, delete and filter tasks, saved in localStorage, mobile friendly' }) },
  { label: 'Explain this project', icon: 'book', run: () => submitChat({ text: 'Explain this project: what it does, how it is structured, the tech stack, and how to run it.', attachments: [{ type: 'codebase' }], mode: 'ask' }) },
  { label: 'Fix the problems', icon: 'wrench', run: () => submitChat({ text: 'Fix the problems reported in this project. Explain each cause briefly.', attachments: [{ type: 'problems' }] }) },
  { label: 'Analyze a photo', icon: 'device-camera', run: async () => {
    const { pickFiles } = await import('../core/dom.js');
    const files = await pickFiles({ accept: 'image/*', multiple: true });
    if (!files.length) return;
    await handleFiles(files);
    const input = getChatInput();
    if (input && !input.getText().trim()) input.setText('What is in this photo? If it shows an app, website or UI design, build it for me.');
    input?.focus();
  } }
];

function routeProblem() {
  try {
    const st = engineIfLoaded()?.catalog?.status?.();
    if (!st || st.loading || st.worker === 'loading') return null;
    if (st.worker === 'ready' || st.puter === 'signed-in') return null;
    return st.worker === 'unconfigured' ? 'No AI router is configured and you are not signed in to X Coder Cloud.' : `The X Coder AI router is unreachable${st.error ? ` (${st.error})` : ''}${st.puter === 'signed-out' ? ' and you are not signed in to X Coder Cloud' : ''}.`;
  } catch { return null; }
}

function renderWelcome() {
  const mode = modeInfo(currentMode());
  const chips = h('div', { class: 'chat-welcome-suggestions', role: 'list' },
    SUGGESTIONS.map(s => {
      const b = h('button', { class: 'chat-welcome-suggestion', type: 'button', role: 'listitem' }, codicon(s.icon), h('span', {}, s.label));
      b.addEventListener('click', () => withErrors(s.run));
      return b;
    }));
  const problem = routeProblem();
  return h('div', { class: 'chat-welcome' },
    h('div', { class: 'chat-welcome-icon' }, codicon('chat-sparkle')),
    h('h2', { class: 'chat-welcome-title' }, 'Ask X Coder'),
    h('p', { class: 'chat-welcome-description' }, 'X Coder is your AI pair programmer. It can explain code, fix bugs, build whole projects, analyze uploaded projects and photos, and edit files for you.'),
    h('p', { class: 'chat-welcome-mode' }, codicon(mode.icon), h('span', {}, h('strong', {}, `${mode.label} mode`), ` — ${mode.description}`)),
    chips,
    problem ? h('div', { class: 'chat-welcome-warning' }, codicon('warning'),
      h('span', {}, `${problem} `,
        h('a', { href: '#', onclick: e => { e.preventDefault(); commands.execute('xcoder.ai.testProviders'); } }, 'Test AI Providers'), ' · ',
        h('a', { href: '#', onclick: e => { e.preventDefault(); commands.execute('xcoder.ai.configureRouter'); } }, 'Configure Router'))) : null,
    h('div', { class: 'chat-welcome-tips' },
      h('p', {}, codicon('attach'), h('span', {}, 'or type '), h('code', {}, '#'), h('span', {}, ' to attach context')),
      h('p', {}, h('code', {}, '/'), h('span', {}, ' to use commands like '), h('code', {}, '/new'), h('span', {}, ' or '), h('code', {}, '/fix')),
      h('p', {}, codicon('mic'), h('span', {}, 'tap the microphone to talk; hold '), codicon('send'), h('span', {}, ' to switch models'))),
    h('p', { class: 'chat-welcome-disclaimer' }, 'AI responses may be inaccurate. Review changes before you keep them — every change can be undone.'));
}

// ------------------------------------------------------------------ the view

export function renderChatView(body) {
  current?.dispose?.();
  const list = h('div', { class: 'interactive-list', role: 'list', 'aria-label': 'Chat', 'aria-live': 'polite', tabindex: '-1' });
  const scrollBtn = h('a', { class: 'chat-scroll-down action-label codicon codicon-arrow-down hidden', role: 'button', tabindex: '0', title: 'Scroll to Bottom', 'aria-label': 'Scroll to Bottom' });
  const progress = h('div', { class: 'monaco-progress-container chat-progress' }, h('div', { class: 'progress-bit' }));
  const dropHint = h('div', { class: 'chat-drop-overlay hidden' }, codicon('attach'), h('span', {}, 'Drop files, photos or a project ZIP to attach'));
  const input = new ChatInput({
    onSubmit: payload => { view.stick = true; return submitChat(payload); },
    onStop: () => chat.stop(),
    previewImage,
    promptHistory: () => chat.turns.filter(t => t.role === 'user' && !t.local).map(t => t.display || t.text).filter(Boolean)
  });
  const root = h('div', { class: 'interactive-session chat-view' }, h('div', { class: 'interactive-list-wrap' }, list, scrollBtn), progress, input.el, dropHint);
  body.classList.add('chat-pane-body');
  body.append(root);

  const rows = new Map(); // turn id → { el, update? }
  const view = { root, input, list, stick: true, disposers: [] };
  current = view;

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const scrollToBottom = (smooth = false) => { list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); view.stick = true; scrollBtn.classList.add('hidden'); };
  const afterContent = () => {
    if (view.stick) list.scrollTop = list.scrollHeight;
    scrollBtn.classList.toggle('hidden', view.stick || nearBottom());
  };
  list.addEventListener('scroll', () => {
    view.stick = nearBottom();
    scrollBtn.classList.toggle('hidden', view.stick);
  }, { passive: true });
  scrollBtn.addEventListener('click', () => scrollToBottom(true));

  function rowFor(turn) {
    if (turn.role === 'user') return { el: renderRequest(turn, responseCtx) };
    return createResponseRow(turn, responseCtx);
  }

  function renderAll() {
    rows.clear();
    clear(list);
    const turns = chat.turns;
    if (!turns.length) list.append(renderWelcome());
    for (const t of turns) { const r = rowFor(t); rows.set(t.id, r); list.append(r.el); }
    view.stick = turns.length > 0;
    requestAnimationFrame(() => { if (turns.length) afterContent(); else { list.scrollTop = 0; scrollBtn.classList.add('hidden'); } });
    // late layout (syntax highlighting, fonts, the overlay animation) can grow the list after the first frame
    if (turns.length) setTimeout(() => { if (view.stick) afterContent(); }, 180);
  }

  function upsert(turn) {
    if (!chat.session?.turns.includes(turn)) return;
    const existing = rows.get(turn.id);
    if (existing) {
      if (existing.update) existing.update(turn);
      else { const r = rowFor(turn); existing.el.replaceWith(r.el); rows.set(turn.id, r); }
    } else {
      if (list.querySelector('.chat-welcome')) { list.querySelector('.chat-welcome').remove(); view.stick = true; }
      const r = rowFor(turn);
      rows.set(turn.id, r);
      // keep list order = session order
      const idx = chat.turns.indexOf(turn);
      const next = chat.turns.slice(idx + 1).map(t => rows.get(t.id)?.el).find(Boolean);
      if (next) list.insertBefore(r.el, next); else list.append(r.el);
      if (turn.role === 'user') view.stick = true;
    }
    afterContent();
  }

  function setBusy(busy) {
    input.setBusy(busy);
    progress.classList.toggle('active', busy);
    root.classList.toggle('busy', busy);
  }

  // link clicks inside answers: project files open in the editor
  list.addEventListener('click', e => {
    const a = e.target.closest('a[data-file-link]');
    if (a) { e.preventDefault(); openProjectLink(a.getAttribute('data-file-link')); return; }
    const code = e.target.closest('code.file-link');
    if (code) { e.preventDefault(); openProjectLink(code.dataset.fileLink); }
  });
  list.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const code = e.target.closest?.('code.file-link');
    if (code) { e.preventDefault(); openProjectLink(code.dataset.fileLink); }
  });

  // drag & drop files onto the chat
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  root.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropHint.classList.remove('hidden'); });
  root.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  root.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropHint.classList.add('hidden'); });
  root.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropHint.classList.add('hidden');
    const items = [...(e.dataTransfer.items || [])];
    const folders = items.filter(i => { try { return i.webkitGetAsEntry?.()?.isDirectory; } catch { return false; } });
    const files = [...e.dataTransfer.files].filter(f => !folders.some(i => { try { return i.webkitGetAsEntry?.()?.name === f.name; } catch { return false; } }));
    if (folders.length) {
      notify('info', 'Folders can’t be attached to a message. Import the folder as a new project and X Coder will analyze it.', {
        actions: [{ label: 'Import Folder…', run: () => withErrors(() => importProjectAndAnalyze('folder')) }]
      });
    }
    if (files.length) withErrors(() => handleFiles(files));
  });

  // Mod+L → New Chat while the chat has focus (handled by the command's when-clause); Escape stops
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && chat.busy && !e.defaultPrevented) { e.preventDefault(); chat.stop(); }
  });

  view.disposers.push(
    chat.events.on('session', () => renderAll()),
    chat.events.on('turn', t => upsert(t)),
    chat.events.on('busy', b => setBusy(b)),
    voice.events.on('change', () => { if (!voice.speaking) speakingState.id = null; for (const r of rows.values()) r.refreshFooter?.(); }),
    settings.onChange('xcoder.ai.mode', () => { if (!chat.turns.length) renderAll(); }),
    bus.on('keyboard:changed', ({ open }) => { if (open && view.stick) requestAnimationFrame(afterContent); })
  );
  getEngine().then(e => {
    const off = e?.catalog?.onChange?.(() => { if (!chat.turns.length) { const w = list.querySelector('.chat-welcome'); if (w) w.replaceWith(renderWelcome()); } });
    if (off) view.disposers.push(off);
  }).catch(() => {});

  renderAll();
  setBusy(chat.busy);

  view.dispose = () => {
    for (const d of view.disposers.splice(0)) { try { d(); } catch {} }
    input.dispose();
    root.remove();
    if (current === view) current = null;
  };
  return {
    focus: () => input.focus(),
    onShow: () => requestAnimationFrame(() => { input.autoGrow(); afterContent(); }),
    onHide: () => input.closeSuggest(),
    dispose: () => view.dispose()
  };
}

