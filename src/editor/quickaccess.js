// Quick access providers: ':' Go to Line/Column and '@' Go to Symbol in Editor (with '@:' grouped by kind).
// Both preview live in the editor while typing / moving through the list, and restore on cancel.

import { quickInput } from '../platform/quickinput.js';
import { fuzzyMatch, codiconHtml } from '../core/dom.js';
import { activeCode } from './registry.js';
import { flattenSymbols, SYMBOL_ICON, SYMBOL_GROUP } from './symbols.js';
import { posOf } from './ops.js';

let saved = null; // { ed, selection, scrollTop } captured when a picker opens
function capture(ed) {
  if (!saved || saved.ed !== ed) saved = { ed, selection: ed.view.state.selection, scrollTop: ed.view.scrollDOM.scrollTop };
}
function restore() {
  const s = saved; saved = null;
  if (!s || s.ed.disposed) return;
  s.ed.flashLine(null);
  s.ed.view.dispatch({ selection: s.selection });
  requestAnimationFrame(() => { if (!s.ed.disposed) s.ed.view.scrollDOM.scrollTop = s.scrollTop; });
}

function parseLine(filter, lines) {
  const m = /^\s*(-?\d+)?\s*(?:[:,#]\s*(\d+)?)?\s*$/.exec(filter);
  if (!m || m[1] == null) return null;
  let line = Number(m[1]);
  if (line < 0) line = lines + line + 1;
  const col = m[2] != null ? Number(m[2]) : null;
  return { line, col };
}

export function registerQuickAccess() {
  quickInput.registerProvider(':', {
    placeholder: 'Type the line number and optional column to go to (e.g. 42:5 for line 42 and column 5).',
    helpText: 'Go to Line/Column',
    filter: false,
    provide(filter) {
      const ed = activeCode();
      if (!ed) return [{ label: 'Open a text editor first to go to a line.', disabled: true }];
      capture(ed);
      const info = ed.statusInfo();
      const target = parseLine(filter, info.lines);
      if (!target) {
        ed.flashLine(null);
        return [{ label: `Current Line: ${info.line}, Character: ${info.col}. Type a line number between 1 and ${info.lines} to navigate to.`, disabled: !filter, goto: null }];
      }
      if (target.line < 1 || target.line > info.lines) {
        return [{ label: `Current Line: ${info.line}, Character: ${info.col}. Type a line number between 1 and ${info.lines} to navigate to.`, disabled: true }];
      }
      const doc = ed.view.state.doc;
      const lineObj = doc.line(target.line);
      const maxCol = lineObj.length + 1;
      if (target.col != null && (target.col < 1 || target.col > maxCol)) {
        return [{ label: `Current Line: ${info.line}, Character: ${info.col}. Type a character between 1 and ${maxCol} to navigate to.`, disabled: true }];
      }
      ed.flashLine(posOf(doc, target.line, target.col || 1));
      return [{ label: target.col != null ? `Go to line ${target.line} and character ${target.col}.` : `Go to line ${target.line}.`, goto: target }];
    },
    accept(item) {
      const ed = saved?.ed || activeCode();
      saved = null;
      if (!ed || !item?.goto) { restore(); return; }
      ed.flashLine(null);
      ed.reveal({ line: item.goto.line, col: item.goto.col || 1, flash: true });
      ed.focus();
    },
    onCancel() { restore(); }
  });

  quickInput.registerProvider('@', {
    placeholder: 'Type the name of a symbol to go to.',
    helpText: 'Go to Symbol in Editor',
    filter: false,
    provide(filter) {
      const ed = activeCode();
      if (!ed) return [{ label: 'To go to a symbol, first open a text editor with symbol information.', disabled: true }];
      capture(ed);
      const byKind = filter.startsWith(':');
      const query = (byKind ? filter.slice(1) : filter).trim();
      const flat = flattenSymbols(ed.symbols());
      if (!flat.length) return [{ label: 'The active text editor does not provide symbol information.', disabled: true }];
      const scored = [];
      for (const s of flat) {
        const m = query ? fuzzyMatch(query, s.name) : { score: 0, matches: [] };
        if (!m) continue;
        scored.push({ s, m });
      }
      if (!scored.length) return [{ label: 'No matching editor symbols', disabled: true }];
      if (query && !byKind) scored.sort((a, b) => b.m.score - a.m.score);
      const item = ({ s, m }) => ({
        label: s.name, description: s.container || '', highlights: m.matches, iconHtml: codiconHtml(SYMBOL_ICON[s.kind] || 'symbol-misc', `symbol-icon kind-${s.kind}`),
        symbol: s, id: `${s.selFrom}:${s.name}`
      });
      if (!byKind) {
        const header = { kind: 'separator', label: `symbols (${scored.length})` };
        return [header, ...scored.map(item)];
      }
      const groups = new Map();
      for (const x of scored) { if (!groups.has(x.s.kind)) groups.set(x.s.kind, []); groups.get(x.s.kind).push(x); }
      const out = [];
      for (const [kind, list] of [...groups.entries()].sort((a, b) => (SYMBOL_GROUP[a[0]] || a[0]).localeCompare(SYMBOL_GROUP[b[0]] || b[0]))) {
        out.push({ kind: 'separator', label: `${SYMBOL_GROUP[kind] || kind} (${list.length})` });
        out.push(...list.map(item));
      }
      return out;
    },
    onDidChangeActive(item) {
      const ed = saved?.ed;
      if (!ed || !item?.symbol) return;
      ed.flashLine(item.symbol.selFrom);
    },
    accept(item) {
      const ed = saved?.ed || activeCode();
      saved = null;
      if (!ed || !item?.symbol) { restore(); return; }
      ed.flashLine(null);
      const doc = ed.view.state.doc;
      const a = doc.lineAt(item.symbol.selFrom), b = doc.lineAt(item.symbol.selTo);
      ed.reveal({ line: a.number, col: item.symbol.selFrom - a.from + 1, endLine: b.number, endCol: item.symbol.selTo - b.from + 1, select: true, flash: true });
      ed.focus();
    },
    onCancel() { restore(); }
  });
}
