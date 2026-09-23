// Go to Next/Previous Problem (F8 / Shift+F8): VS Code's marker navigation zone widget, shown under the
// problem's line with "n of m problems", next/previous/close actions and the message + source.

import { state as S, view as V } from './cm.js';
import { h, codicon } from '../core/dom.js';
import { diagnostics } from '../core/diagnostics.js';
import { posix } from '../core/path.js';
import { editors } from '../workbench/editors.js';
import { notify } from '../platform/notifications.js';
import { posOf } from './ops.js';

const { StateEffect, StateField, Prec, EditorSelection } = S;
const { EditorView, Decoration, WidgetType, keymap } = V;

const setMarker = StateEffect.define();

class MarkerZone extends WidgetType {
  constructor(info) { super(); this.info = info; }
  eq(other) { return other.info === this.info; }
  toDOM(view) {
    const { marker, index, total, path } = this.info;
    const sev = marker.severity === 'warning' ? 'warning' : marker.severity === 'error' ? 'error' : 'info';
    const btn = (icon, title, run) => {
      const b = h('a', { class: `action-label codicon codicon-${icon}`, role: 'button', title, 'aria-label': title, tabindex: '0' });
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', e => { e.preventDefault(); run(); });
      return b;
    };
    return h('div', { class: `marker-widget severity-${sev}`, role: 'alert' },
      h('div', { class: 'head' },
        codicon(sev, 'severity-icon'),
        h('span', { class: 'title' }, posix.basename(path)),
        h('span', { class: 'count' }, `${index + 1} of ${total} problem${total === 1 ? '' : 's'}`),
        h('span', { class: 'actions monaco-toolbar' },
          btn('arrow-down', 'Next Problem (F8)', () => gotoMarker(1)),
          btn('arrow-up', 'Previous Problem (⇧F8)', () => gotoMarker(-1)),
          btn('close', 'Close', () => clearMarkerWidget(view)))),
      h('div', { class: 'body selectable' },
        h('span', { class: 'message' }, marker.message),
        marker.source ? h('span', { class: 'source' }, ` ${marker.source}${marker.code ? `(${marker.code})` : ''}`) : null,
        h('span', { class: 'location' }, ` [Ln ${marker.line}, Col ${marker.col}]`)));
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 64; }
}

const markerField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarker)) return e.value;
    if (value && tr.docChanged) return null;
    return value;
  },
  provide: f => EditorView.decorations.from(f, v => {
    if (!v) return Decoration.none;
    return Decoration.set([Decoration.widget({ widget: new MarkerZone(v.info), block: true, side: 1 }).range(v.lineEnd)]);
  })
});

export function clearMarkerWidget(view) {
  if (!view || view.destroyed || !view.state.field(markerField, false)) return false;
  queueMicrotask(() => { if (!view.destroyed && view.state.field(markerField, false)) view.dispatch({ effects: setMarker.of(null) }); });
  return true;
}

export const markerExtensions = [
  markerField,
  Prec.high(keymap.of([{ key: 'Escape', run: view => clearMarkerWidget(view) }]))
];

function sortMarkers(list) { return [...list].sort((a, b) => a.line - b.line || a.col - b.col); }

/** Moves to the next (dir 1) / previous (dir -1) problem, crossing files like VS Code. */
export async function gotoMarker(dir = 1) {
  const all = diagnostics.all().filter(f => f.markers.length);
  if (!all.length) { notify.info('No problems have been detected in the workspace.', { source: 'Problems' }); return false; }
  const active = editors.active;
  const inst = active?.instance?.kind === 'code' ? active.instance : null;
  const path = inst?.path || null;
  let targetPath = null, targetIndex = -1;
  if (inst) {
    const markers = sortMarkers(diagnostics.forFile(path));
    const state = inst.view.state;
    const cur = state.selection.main;
    const shown = state.field(markerField, false);
    if (markers.length) {
      const positions = markers.map(m => posOf(state.doc, m.line, m.col));
      if (dir > 0) targetIndex = positions.findIndex((p, i) => p > cur.head || (p === cur.head && !(shown && shown.index === i)));
      else { for (let i = positions.length - 1; i >= 0; i--) if (positions[i] < cur.from || (positions[i] === cur.from && !(shown && shown.index === i) && positions[i] !== cur.head)) { targetIndex = i; break; } }
      if (targetIndex >= 0) targetPath = path;
    }
  }
  if (!targetPath) {
    const files = all.map(f => f.path);
    const idx = path ? files.indexOf(path) : -1;
    let next;
    if (idx >= 0) {
      if (files.length === 1) next = files[0];
      else next = files[(idx + (dir > 0 ? 1 : -1) + files.length) % files.length];
    } else next = dir > 0 ? files[0] : files[files.length - 1];
    targetPath = next;
    const count = diagnostics.forFile(next).length;
    targetIndex = dir > 0 ? 0 : count - 1;
  }
  const inst2 = await editors.open({ type: 'file', path: targetPath }, { pinned: false });
  if (!inst2?.view) return false;
  showMarker(inst2, targetIndex);
  return true;
}

function showMarker(inst, index) {
  const markers = sortMarkers(diagnostics.forFile(inst.path));
  const marker = markers[index];
  if (!marker) return;
  const view = inst.view;
  const doc = view.state.doc;
  const from = posOf(doc, marker.line, marker.col);
  const to = marker.endLine ? Math.max(from, posOf(doc, marker.endLine, marker.endCol || marker.col)) : from;
  const line = doc.lineAt(from);
  view.dispatch({
    selection: EditorSelection.single(from, Math.min(to, line.to) > from ? Math.min(to, line.to) : from),
    effects: [setMarker.of({ index, lineEnd: line.to, info: { marker, index, total: markers.length, path: inst.path } }), EditorView.scrollIntoView(from, { y: 'center' })],
    userEvent: 'select.marker'
  });
  view.focus();
}
