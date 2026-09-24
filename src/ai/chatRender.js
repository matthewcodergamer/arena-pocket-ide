// Chat list rows in the VS Code Chat look: request rows (avatar, "You", text, attachment chips) and response
// rows (X Coder avatar, model label, streamed markdown parts, tool progress lists, reasoning disclosure,
// "Changed N files" edit review block, status line, error box and the footer toolbar).
//
//   renderRequest(turn, ctx)            → element
//   createResponseRow(turn, ctx)        → { el, update(turn) }
//   ctx = { keep(respId, editId?), undo(respId, editId?), openDiff(respId, editId), retry(respId), vote(respId, v),
//           readAloud(respId), isSpeaking(respId), copy(respId), previewImage(att), openFile(path) }

import { h, codicon, clear, append, relativeTime } from '../core/dom.js';
import { posix } from '../core/path.js';
import { fileIconHtml } from '../workbench/icons.js';
import { renderMarkdownInto } from './markdown.js';
import { describe } from './attachments.js';

const MODE_LABEL = { ask: 'Ask', edit: 'Edit', agent: 'Agent' };

function iconHtml(path) { try { return fileIconHtml(path); } catch { return ''; } }

function actionButton(icon, title, run, extra = '') {
  const b = h('a', { class: `action-label codicon codicon-${icon} ${extra}`, role: 'button', tabindex: '0', title, 'aria-label': title });
  const go = e => { e.preventDefault(); e.stopPropagation(); run(b, e); };
  b.addEventListener('click', go);
  b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') go(e); });
  return b;
}

function header({ avatar, name, detail, time }) {
  return h('div', { class: 'header' },
    h('div', { class: 'avatar-container' }, avatar),
    h('div', { class: 'username' }, name),
    detail ? h('div', { class: 'detail', title: detail }, detail) : null,
    time ? h('div', { class: 'time', title: new Date(time).toLocaleString() }, relativeTime(time)) : null);
}

// ------------------------------------------------------------------ attachments chips (read-only, in requests)

export function attachmentChip(att, { onRemove, onPreview, extraClass = '', title } = {}) {
  const d = describe(att);
  const chip = h('div', { class: ['chat-attached-context-attachment', att.type === 'image' && 'image', extraClass], title: title || d.detail || d.label, tabindex: '0', role: 'listitem' });
  if (att.type === 'image' && (att.thumb || att.dataUrl)) {
    chip.append(h('img', { class: 'chat-attached-image-thumb', src: att.thumb || att.dataUrl, alt: att.name || 'image', draggable: 'false' }));
  } else if (d.iconHtml) chip.append(h('span', { class: 'chip-icon', html: d.iconHtml }));
  else chip.append(h('span', { class: 'chip-icon' }, codicon(d.icon || 'file')));
  chip.append(h('span', { class: 'chip-label' }, d.label));
  if (onPreview) {
    chip.classList.add('clickable');
    chip.addEventListener('click', e => { if (e.target.closest('.chip-remove')) return; onPreview(att); });
    chip.addEventListener('keydown', e => { if (e.key === 'Enter') onPreview(att); });
  }
  if (onRemove) chip.append(actionButton('close', `Remove ${d.label}`, () => onRemove(att), 'chip-remove'));
  return chip;
}

// ------------------------------------------------------------------ request row

export function renderRequest(turn, ctx) {
  const avatar = h('div', { class: 'avatar codicon-avatar user' }, codicon('account'));
  const text = turn.display || turn.text || '';
  const value = h('div', { class: 'value request-text' });
  const slash = text.match(/^\/([a-z]+)(\s+|$)/i);
  if (slash) { value.append(h('span', { class: 'chat-slash-command' }, `/${slash[1]}`), text.slice(slash[0].length - (slash[2] ? slash[2].length : 0))); }
  else value.append(text);
  const atts = turn.attachments || [];
  const row = h('div', { class: 'interactive-item-container interactive-request', 'data-id': turn.id, role: 'listitem', 'aria-label': `You: ${text}` },
    header({ avatar, name: 'You', detail: turn.mode && turn.mode !== 'agent' ? MODE_LABEL[turn.mode] : '' }),
    value,
    atts.length ? h('div', { class: 'chat-attached-context request-attachments', role: 'list' },
      atts.map(a => attachmentChip(a, { onPreview: a.type === 'image' ? ctx.previewImage : a.type === 'file' ? () => ctx.openFile(a.path) : null }))) : null);
  return row;
}

// ------------------------------------------------------------------ response row

function toolIcon(state) {
  if (state === 'running') return codicon('loading', 'codicon-modifier-spin');
  if (state === 'error') return codicon('error', 'tool-error');
  return codicon('check', 'tool-done');
}

function renderToolsPart(part, el, { running }) {
  const items = part.items || [];
  const runningItem = items.find(i => i.state === 'running');
  if (el._open == null) el._open = true;
  if (!running && !el._userToggled) el._open = items.length <= 3;
  const errors = items.filter(i => i.state === 'error').length;
  const summary = runningItem ? runningItem.label : items.length === 1 ? items[0].label : `Used ${items.length} tools${errors ? ` · ${errors} failed` : ''}`;
  clear(el);
  el.classList.toggle('collapsed', !el._open);
  if (items.length > 1) {
    const head = h('div', { class: 'chat-used-context-label', role: 'button', tabindex: '0', 'aria-expanded': String(el._open) },
      codicon(el._open ? 'chevron-down' : 'chevron-right', 'twistie'),
      runningItem ? codicon('loading', 'codicon-modifier-spin') : null,
      h('span', { class: 'label' }, summary));
    const toggle = () => { el._open = !el._open; el._userToggled = true; renderToolsPart(part, el, { running }); };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    el.append(head);
  }
  if (items.length === 1 || el._open) {
    const list = h('div', { class: 'chat-used-context-list', role: 'list' });
    for (const it of items) {
      list.append(h('div', { class: ['chat-progress-item', `state-${it.state}`], role: 'listitem', title: it.detail || it.label },
        toolIcon(it.state),
        h('span', { class: 'progress-label' }, it.label),
        it.detail ? h('span', { class: 'progress-detail' }, it.detail) : null));
    }
    el.append(list);
  }
}

const EDIT_STATE = {
  pending: ['Pending', 'pending'], applied: ['Applied', 'applied'], kept: ['Kept', 'kept'],
  undone: ['Undone', 'undone'], discarded: ['Discarded', 'undone'], failed: ['Failed', 'failed']
};
const KIND_LABEL = { create: 'Created', modify: 'Modified', delete: 'Deleted', rename: 'Renamed' };

function renderEdits(turn, el, ctx) {
  clear(el);
  const edits = turn.edits || [];
  if (!edits.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const files = edits.filter(e => e.state !== 'failed');
  const reviewable = edits.filter(e => e.state === 'pending' || e.state === 'applied');
  const count = new Set(files.map(e => e.to || e.path)).size;
  const plural = `${count} file${count === 1 ? '' : 's'}`;
  const allUndone = files.length > 0 && files.every(e => e.state === 'undone' || e.state === 'discarded');
  const title = edits.some(e => e.state === 'pending') ? `${plural} with proposed changes` : allUndone ? `Changes to ${plural} undone` : `Changed ${plural}`;
  const head = h('div', { class: 'chat-edits-header' },
    codicon('diff'), h('span', { class: 'chat-edits-title' }, files.length ? title : 'No files were changed'));
  el.append(head);
  const list = h('div', { class: 'chat-edits-list', role: 'list' });
  for (const e of edits) {
    const path = e.to || e.path;
    const [stateLabel, stateCls] = EDIT_STATE[e.state] || [e.state, e.state];
    const canReview = e.state === 'pending' || e.state === 'applied';
    const row = h('div', { class: ['chat-edit-row', `state-${stateCls}`, `kind-${e.kind}`], role: 'listitem', tabindex: '0', 'data-edit-id': e.id, 'data-path': path,
      title: `${KIND_LABEL[e.kind] || 'Changed'} ${e.to ? `${e.path} → ${e.to}` : path}${e.error ? ` — ${e.error}` : ''}` },
      h('span', { class: 'chip-icon', html: iconHtml(path) }),
      h('span', { class: 'edit-name' }, posix.basename(path)),
      h('span', { class: 'edit-dir' }, e.to ? `← ${posix.basename(e.path)}` : posix.dirname(path)),
      h('span', { class: 'edit-stats' },
        e.kind === 'delete' ? h('span', { class: 'removed' }, 'deleted') : null,
        e.added ? h('span', { class: 'added' }, `+${e.added}`) : null,
        e.removed ? h('span', { class: 'removed' }, `-${e.removed}`) : null),
      h('span', { class: 'edit-state' }, stateLabel),
      h('span', { class: 'edit-actions monaco-toolbar' },
        canReview ? actionButton('check', e.state === 'pending' ? 'Keep (write this change)' : 'Keep', () => ctx.keep(turn.id, e.id)) : null,
        canReview ? actionButton('discard', e.state === 'pending' ? 'Undo (discard this change)' : 'Undo (restore this file)', () => ctx.undo(turn.id, e.id)) : null));
    if (e.state !== 'failed') {
      row.classList.add('clickable');
      row.addEventListener('click', ev => { if (!ev.target.closest('.edit-actions')) ctx.openDiff(turn.id, e.id); });
      row.addEventListener('keydown', ev => { if (ev.key === 'Enter') ctx.openDiff(turn.id, e.id); });
    }
    list.append(row);
    if (e.state === 'failed' && e.error) list.append(h('div', { class: 'chat-edit-error' }, e.error));
  }
  el.append(list);
  if (reviewable.length) {
    const keepAll = h('button', { class: 'monaco-button chat-keep-all', type: 'button' }, reviewable.length > 1 ? 'Keep All' : 'Keep');
    const undoAll = h('button', { class: 'monaco-button secondary chat-undo-all', type: 'button' }, reviewable.length > 1 ? 'Undo All' : 'Undo');
    keepAll.addEventListener('click', () => ctx.keep(turn.id));
    undoAll.addEventListener('click', () => ctx.undo(turn.id));
    el.append(h('div', { class: 'chat-edits-actions' }, keepAll, undoAll,
      h('span', { class: 'chat-edits-hint' }, reviewable.some(e => e.state === 'pending') ? 'Nothing is written until you keep it.' : 'Changes are applied — Undo restores the previous files.')));
  }
}

function stoppedMessage(turn) {
  const changed = (turn.edits || []).filter(e => e.state === 'applied' || e.state === 'kept');
  const pending = (turn.edits || []).filter(e => e.state === 'pending');
  if (changed.length) return `Stopped. X Coder had already changed ${changed.length} file${changed.length === 1 ? '' : 's'} (${changed.slice(0, 3).map(e => posix.basename(e.to || e.path)).join(', ')}${changed.length > 3 ? '…' : ''}) — review or undo ${changed.length === 1 ? 'it' : 'them'} below.`;
  if (pending.length) return 'Stopped. Your files were not changed — the proposed edits below are waiting for review.';
  return 'Stopped. Your files were not changed.';
}

export function createResponseRow(turn, ctx) {
  const avatar = h('div', { class: 'avatar codicon-avatar xcoder' }, codicon('chat-sparkle'));
  const detailEl = h('div', { class: 'detail' });
  const headerEl = h('div', { class: 'header' }, h('div', { class: 'avatar-container' }, avatar), h('div', { class: 'username' }, 'X Coder'), detailEl);
  const thinking = h('details', { class: 'chat-thinking hidden' }, h('summary', {}, codicon('chevron-right', 'twistie'), h('span', { class: 'thinking-label' }, 'Thinking')), h('div', { class: 'chat-thinking-content' }));
  const partsEl = h('div', { class: 'chat-response-parts' });
  const editsEl = h('div', { class: 'chat-edits hidden', role: 'group', 'aria-label': 'Changed files' });
  const statusEl = h('div', { class: 'chat-response-status hidden', role: 'status' });
  const noteEl = h('div', { class: 'chat-response-note hidden' });
  const errorEl = h('div', { class: 'chat-error hidden', role: 'alert' });
  const footer = h('div', { class: 'chat-footer-toolbar monaco-toolbar hidden', role: 'toolbar', 'aria-label': 'Response actions' });
  const value = h('div', { class: 'value' }, thinking, partsEl, editsEl, statusEl, noteEl, errorEl);
  const el = h('div', { class: 'interactive-item-container interactive-response', 'data-id': turn.id, role: 'listitem' }, headerEl, value, footer);
  const partEls = [];
  let lastFooterKey = '';
  let lastEditsKey = '';

  function update(t) {
    turn = t;
    const running = t.state === 'running';
    el.classList.toggle('running', running);
    el.classList.toggle('error', t.state === 'error');
    const detail = t.model ? `via ${t.model}` : '';
    if (detailEl.textContent !== detail) { detailEl.textContent = detail; detailEl.title = detail; }
    // reasoning (collapsed "Thinking" disclosure)
    if (t.reasoning) {
      thinking.classList.remove('hidden');
      const content = thinking.querySelector('.chat-thinking-content');
      if (content.textContent !== t.reasoning) content.textContent = t.reasoning;
      thinking.querySelector('summary .thinking-label').textContent = running && !(t.parts || []).length ? 'Thinking…' : 'Thinking';
    } else thinking.classList.add('hidden');
    // content parts
    const parts = t.parts || [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      let pel = partEls[i];
      if (!pel || pel._kind !== p.kind) {
        const fresh = h('div', { class: p.kind === 'markdown' ? 'chat-markdown-part' : 'chat-used-context chat-tools-part' });
        fresh._kind = p.kind;
        if (pel) pel.replaceWith(fresh); else partsEl.append(fresh);
        partEls[i] = pel = fresh;
      }
      if (p.kind === 'markdown') renderMarkdownInto(pel, p.text, { streaming: running && i === parts.length - 1 });
      else if (p.kind === 'tools') renderToolsPart(p, pel, { running });
    }
    while (partEls.length > parts.length) partEls.pop().remove();
    // edits
    const editsKey = JSON.stringify([t.mode, t.edits || []]);
    if (editsKey !== lastEditsKey) { lastEditsKey = editsKey; renderEdits(t, editsEl, ctx); }
    // status line while working
    if (running) {
      statusEl.classList.remove('hidden');
      const text = t.status || 'Working…';
      if (statusEl.dataset.text !== text) { statusEl.dataset.text = text; clear(statusEl).append(codicon('loading', 'codicon-modifier-spin'), h('span', {}, text)); }
    } else statusEl.classList.add('hidden');
    // stopped note
    if (t.state === 'stopped') { noteEl.classList.remove('hidden'); noteEl.textContent = stoppedMessage(t); }
    else noteEl.classList.add('hidden');
    // error box
    if (t.state === 'error') {
      errorEl.classList.remove('hidden');
      if (errorEl.dataset.error !== t.error) {
        errorEl.dataset.error = t.error || '';
        clear(errorEl).append(
          h('div', { class: 'chat-error-message' }, codicon('error'), h('span', {}, t.error || 'The request failed.')),
          h('div', { class: 'chat-error-actions' },
            h('button', { class: 'monaco-button chat-error-retry', type: 'button', onclick: () => ctx.retry(t.id) }, codicon('refresh'), h('span', {}, 'Retry')),
            h('button', { class: 'monaco-button secondary', type: 'button', onclick: () => ctx.testProviders() }, codicon('pulse'), h('span', {}, 'Test AI Providers'))));
      }
    } else errorEl.classList.add('hidden');
    // footer toolbar
    const speaking = ctx.isSpeaking(t.id);
    const footerKey = `${t.state}|${t.vote}|${speaking}|${!!t.local}`;
    if (footerKey !== lastFooterKey) {
      lastFooterKey = footerKey;
      clear(footer);
      footer.classList.toggle('hidden', running);
      if (!running) {
        append(footer, [
          actionButton('copy', 'Copy', b => { ctx.copy(t.id); b.classList.replace('codicon-copy', 'codicon-check'); setTimeout(() => b.classList.replace('codicon-check', 'codicon-copy'), 1200); }),
          actionButton(speaking ? 'debug-stop' : 'unmute', speaking ? 'Stop Speaking' : 'Read Aloud', () => ctx.readAloud(t.id), speaking ? 'speaking' : ''),
          t.local ? null : actionButton('refresh', 'Retry', () => ctx.retry(t.id)),
          h('span', { class: 'footer-spacer' }),
          t.local ? null : actionButton(t.vote === 'up' ? 'thumbsup-filled' : 'thumbsup', 'Helpful', () => ctx.vote(t.id, 'up'), t.vote === 'up' ? 'checked-vote' : ''),
          t.local ? null : actionButton(t.vote === 'down' ? 'thumbsdown-filled' : 'thumbsdown', 'Unhelpful', () => ctx.vote(t.id, 'down'), t.vote === 'down' ? 'checked-vote' : '')]);
      }
    }
  }
  update(turn);
  return { el, update, refreshFooter() { lastFooterKey = ''; update(turn); } };
}

