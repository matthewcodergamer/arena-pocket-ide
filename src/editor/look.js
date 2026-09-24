// VS Code look for CodeMirror: the editor theme (colors from --vscode-* variables), font metrics,
// current-line box, bracket pair colorization, whitespace rendering, relative line numbers and
// VS Code folding chevrons.

import { view as V, state as S, language as L } from './cm.js';

const { EditorView, ViewPlugin, Decoration, GutterMarker, gutter } = V;
const { RangeSetBuilder } = S;
const { syntaxTree } = L;

/** Theme specs: EditorView.theme() rules share the base theme's specificity and are mounted after it, so they win. */
export function themeBoth(spec) { return spec; }

export const vscodeTheme = EditorView.theme(themeBoth({
  '&': { color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-editor-background)', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)', padding: '0', WebkitUserModify: 'read-write-plaintext-only' },
  '.cm-line': { padding: '0 16px 0 4px' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--vscode-editorCursor-foreground)', marginLeft: '-1px' },
  '.cm-selectionBackground': { background: 'var(--vscode-editor-inactiveSelectionBackground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: 'var(--vscode-editor-selectionBackground)' },
  '.cm-content ::selection': { backgroundColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'var(--vscode-editorGutter-background)', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none', paddingLeft: '0' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-activeForeground)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-xc-currentLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground)', boxShadow: 'inset 0 0 0 2px var(--vscode-editor-lineHighlightBorder)' },
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', textAlign: 'center', color: 'var(--xc-editor-foldingControl)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--xc-editor-foldBackground)', border: 'none', color: 'var(--vscode-editor-foreground)', borderRadius: '3px', padding: '0 4px', margin: '0 2px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)', outline: '1px solid var(--vscode-editorBracketMatch-border)', outlineOffset: '-1px', color: 'inherit' },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'inherit' },
  '.cm-selectionMatch': { backgroundColor: 'var(--vscode-editor-wordHighlightBackground)' },
  '.cm-searchMatch': { backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)', outline: 'none', borderRadius: '0' },
  '.cm-searchMatch.cm-searchMatch-selected, .cm-searchMatch-selected': { backgroundColor: 'var(--vscode-editor-findMatchBackground)', outline: '1px solid var(--xc-editor-findMatchBorder)', outlineOffset: '-1px' },
  '.cm-xc-findScope': { backgroundColor: 'var(--xc-editor-findRangeHighlight)' },
  '.cm-xc-lineFlash': { backgroundColor: 'var(--xc-editor-rangeHighlight)' },
  '.cm-panels': { backgroundColor: 'transparent', color: 'var(--vscode-editorWidget-foreground)' },
  '.cm-panels.cm-panels-top': { border: 'none' },
  '.cm-panels.cm-panels-bottom': { border: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--vscode-editorHoverWidget-background)', color: 'var(--vscode-editorHoverWidget-foreground, var(--vscode-editorWidget-foreground))', border: '1px solid var(--vscode-editorHoverWidget-border)', borderRadius: '3px', boxShadow: '0 2px 8px var(--vscode-widget-shadow)', fontFamily: 'var(--font-ui)', fontSize: '13px' },
  '.cm-tooltip.cm-tooltip-autocomplete': { backgroundColor: 'var(--vscode-editorSuggestWidget-background)', border: '1px solid var(--vscode-editorSuggestWidget-border)', padding: '0', borderRadius: '3px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-ui)', maxHeight: 'calc(12 * var(--xc-suggest-row))', minWidth: '240px', maxWidth: 'min(430px, calc(100vw - 24px))' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { display: 'flex', alignItems: 'center', height: 'var(--xc-suggest-row)', lineHeight: 'var(--xc-suggest-row)', padding: '0 6px 0 2px', color: 'var(--vscode-editorSuggestWidget-foreground, var(--vscode-editorWidget-foreground))', cursor: 'pointer' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--vscode-editorSuggestWidget-selectedBackground)', color: 'var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground))' },
  '.cm-tooltip-autocomplete-disabled ul li[aria-selected]': { background: 'var(--vscode-list-inactiveSelectionBackground)' },
  '.cm-completionLabel': { flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700', color: 'var(--vscode-editorSuggestWidget-highlightForeground)' },
  '.cm-completionDetail': { marginLeft: '12px', fontStyle: 'normal', opacity: '0.7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%', flex: '0 1 auto' },
  '.cm-completionInfo': { backgroundColor: 'var(--vscode-editorSuggestWidget-background)', border: '1px solid var(--vscode-editorSuggestWidget-border)', padding: '6px 8px', maxWidth: 'min(360px, 60vw)', fontSize: '12px', lineHeight: '1.45', whiteSpace: 'pre-wrap' },
  '.cm-tooltip.cm-completionInfo.cm-completionInfo-right, .cm-tooltip.cm-completionInfo.cm-completionInfo-left': { borderRadius: '3px' },
  '.cm-tooltip-hover, .cm-tooltip-lint': { padding: '0', maxWidth: 'min(500px, calc(100vw - 16px))' },
  '.cm-diagnostic': { padding: '4px 8px', borderLeft: 'none', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-ui)', fontSize: '13px' },
  '.cm-diagnostic-error, .cm-diagnostic-warning, .cm-diagnostic-info, .cm-diagnostic-hint': { borderLeft: 'none' },
  '.cm-diagnosticSource': { display: 'inline', marginLeft: '6px', opacity: '0.7', fontSize: '12px' },
  '.cm-lintRange': { backgroundImage: 'none', backgroundPosition: '0 0', paddingBottom: '0' },
  '.cm-lintRange-error': { textDecoration: 'underline wavy var(--vscode-editorError-foreground)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px', textDecorationThickness: '1px' },
  '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--vscode-editorWarning-foreground)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px', textDecorationThickness: '1px' },
  '.cm-lintRange-info, .cm-lintRange-hint': { textDecoration: 'underline wavy var(--vscode-editorInfo-foreground)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px', textDecorationThickness: '1px' },
  '.cm-lintPoint:after': { borderBottomColor: 'var(--vscode-editorError-foreground)' },
  '.cm-lintPoint-warning:after': { borderBottomColor: 'var(--vscode-editorWarning-foreground)' },
  '.cm-placeholder': { color: 'var(--vscode-editorGhostText-foreground, var(--vscode-descriptionForeground))' },
  '.cm-specialChar': { color: 'var(--vscode-editorError-foreground)' },
  '.cm-highlightSpace, .cm-ws-space': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--vscode-editorWhitespace-foreground) 0 1.2px, transparent 1.7px)', backgroundSize: '1ch 100%', backgroundRepeat: 'repeat-x', backgroundPosition: 'left center' },
  '.cm-highlightTab, .cm-ws-tab': { backgroundImage: 'linear-gradient(var(--vscode-editorWhitespace-foreground), var(--vscode-editorWhitespace-foreground))', backgroundSize: 'calc(100% - 6px) 1px', backgroundPosition: '3px 55%', backgroundRepeat: 'no-repeat' },
  '.cm-trailingSpace': { backgroundColor: 'transparent' },
  '.cm-snippetField': { backgroundColor: 'var(--xc-editor-snippetTabstop)' },
  '.cm-snippetFieldPosition': { borderLeft: '1px solid var(--vscode-editorCursor-foreground)' }
}));

/** Font metrics theme (reconfigured through a Compartment when settings or zoom change). */
export function fontTheme({ size, family, lineHeight }) {
  return EditorView.theme({
    '&': { fontSize: `${size}px` },
    '.cm-scroller': { fontFamily: family, lineHeight: `${lineHeight}px` },
    '.cm-gutters': { fontSize: `${size}px` },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontSize: `${Math.max(12, Math.min(size, 15))}px` }
  });
}

// ---------------- current line box (VS Code draws it only for empty selections) ----------------
const currentLineDeco = Decoration.line({ class: 'cm-xc-currentLine' });
export const currentLineHighlight = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const builder = new RangeSetBuilder();
    let last = -1;
    const lines = [];
    for (const r of view.state.selection.ranges) {
      if (!r.empty) continue;
      const line = view.lineBlockAt(r.head);
      if (line.from !== last) { lines.push(line.from); last = line.from; }
    }
    lines.sort((a, b) => a - b);
    let prev = -1;
    for (const from of lines) if (from !== prev) { builder.add(from, from, currentLineDeco); prev = from; }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ---------------- bracket pair colorization ----------------
const OPEN = '([{', CLOSE = ')]}';
const SKIP_NODE = /string|comment|regexp|regex|text|char|quote|attributevalue|heredoc|docstring|escape/i;
const bracketMarks = [1, 2, 3].map(i => Decoration.mark({ class: `cm-bracket-${i}` }));
const unexpectedMark = Decoration.mark({ class: 'cm-bracket-unexpected' });
const CHECKPOINT_EVERY = 4000;
const MAX_DOC = 1_000_000;

export const bracketPairColorization = ViewPlugin.fromClass(class {
  constructor(view) { this.checkpoints = []; this.decorations = this.build(view); }
  update(u) {
    if (u.docChanged) {
      let min = Infinity;
      u.changes.iterChangedRanges(fromA => { if (fromA < min) min = fromA; });
      this.checkpoints = this.checkpoints.filter(c => c.pos <= min);
    }
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view);
  }
  build(view) {
    const { state } = view;
    if (state.doc.length > MAX_DOC) return Decoration.none;
    const tree = syntaxTree(state);
    const { from: vpFrom, to: vpTo } = view.viewport;
    let start = { pos: 0, stack: [] };
    for (const c of this.checkpoints) if (c.pos <= vpFrom && c.pos > start.pos) start = c;
    const stack = start.stack.slice();
    const text = state.sliceDoc(start.pos, vpTo);
    const builder = new RangeSetBuilder();
    let lastCheckpoint = start.pos;
    const re = /[()[\]{}]/g;
    let m;
    while ((m = re.exec(text))) {
      const pos = start.pos + m.index;
      const ch = m[0];
      const node = tree.resolveInner(pos, 1);
      if (SKIP_NODE.test(node.type.name)) continue;
      const visible = pos >= vpFrom;
      const oi = OPEN.indexOf(ch);
      if (oi >= 0) {
        if (visible) builder.add(pos, pos + 1, bracketMarks[stack.length % 3]);
        stack.push(ch);
      } else {
        const open = OPEN[CLOSE.indexOf(ch)];
        if (stack.length && stack[stack.length - 1] === open) {
          stack.pop();
          if (visible) builder.add(pos, pos + 1, bracketMarks[stack.length % 3]);
        } else if (visible) builder.add(pos, pos + 1, unexpectedMark);
      }
      if (!visible && pos + 1 - lastCheckpoint >= CHECKPOINT_EVERY) {
        this.checkpoints.push({ pos: pos + 1, stack: stack.slice() });
        lastCheckpoint = pos + 1;
      }
    }
    if (this.checkpoints.length > 400) this.checkpoints = this.checkpoints.filter((_, i) => i % 2 === 0);
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ---------------- whitespace rendering (none | boundary | selection | trailing | all) ----------------
const wsSpace = Decoration.mark({ class: 'cm-ws-space' });
const wsTab = Decoration.mark({ class: 'cm-ws-tab' });
export function renderWhitespace(mode) {
  if (!mode || mode === 'none') return [];
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) { if (u.docChanged || u.viewportChanged || (mode === 'selection' && u.selectionSet)) this.decorations = this.build(u.view); }
    build(view) {
      const { state } = view;
      const builder = new RangeSetBuilder();
      const ranges = mode === 'selection' ? state.selection.ranges.filter(r => !r.empty) : null;
      if (ranges && !ranges.length) return Decoration.none;
      let last = -1;
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = state.doc.lineAt(pos);
          const text = line.text;
          const re = /[ \t]+/g;
          let m;
          while ((m = re.exec(text))) {
            const s = line.from + m.index, e = s + m[0].length;
            if (e < from || s > to) continue;
            const trailing = m.index + m[0].length === text.length;
            const leading = m.index === 0;
            if (mode === 'trailing' && !trailing) continue;
            if (mode === 'boundary' && !leading && !trailing && m[0] === ' ') continue;
            for (let i = Math.max(s, last + 1); i < e; i++) {
              if (ranges && !ranges.some(r => i >= r.from && i < r.to)) continue;
              builder.add(i, i + 1, text[i - line.from] === '\t' ? wsTab : wsSpace);
              last = i;
            }
          }
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  }, { decorations: v => v.decorations });
}

// ---------------- wrapped lines keep their indentation (VS Code wrappingIndent: "same") ----------------
const indentCache = new Map();
function hangingIndent(cols) {
  let deco = indentCache.get(cols);
  if (!deco) {
    deco = Decoration.line({ attributes: { style: `text-indent: -${cols}ch; padding-left: calc(${cols}ch + 4px)` } });
    if (indentCache.size < 200) indentCache.set(cols, deco);
  }
  return deco;
}
export const wrappedLineIndent = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged || u.geometryChanged) this.decorations = this.build(u.view); }
  build(view) {
    const builder = new RangeSetBuilder();
    const tab = view.state.tabSize;
    let last = -1;
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos);
        if (line.from > last) {
          const ws = /^[ \t]*/.exec(line.text)[0];
          if (ws && ws.length < line.text.length) {
            let cols = 0;
            for (const ch of ws) cols = ch === '\t' ? cols + tab - (cols % tab) : cols + 1;
            if (cols > 0 && cols <= 80) builder.add(line.from, line.from, hangingIndent(cols));
          }
          last = line.from;
        }
        pos = line.to + 1;
      }
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ---------------- relative line numbers ----------------
class NumberMarker extends GutterMarker {
  constructor(n) { super(); this.n = n; }
  eq(other) { return other.n === this.n; }
  toDOM() { return document.createTextNode(String(this.n)); }
}
export function relativeLineNumbers() {
  return gutter({
    class: 'cm-lineNumbers cm-relativeLineNumbers',
    lineMarker(view, line) {
      const cur = view.state.doc.lineAt(view.state.selection.main.head).number;
      const n = view.state.doc.lineAt(line.from).number;
      return new NumberMarker(n === cur ? n : Math.abs(n - cur));
    },
    lineMarkerChange: u => u.selectionSet || u.docChanged,
    initialSpacer: view => new NumberMarker(view.state.doc.lines)
  });
}

/** VS Code folding chevrons. */
export function foldMarker(open) {
  const el = document.createElement('span');
  el.className = `codicon codicon-${open ? 'chevron-down' : 'chevron-right'} ${open ? 'fold-open' : 'fold-closed'}`;
  el.title = open ? 'Fold' : 'Unfold';
  return el;
}
export function foldPlaceholder(view, onclick) {
  const el = document.createElement('span');
  el.className = 'cm-foldPlaceholder';
  el.textContent = '⋯';
  el.title = 'Unfold';
  el.setAttribute('aria-label', 'folded code');
  el.onclick = onclick;
  return el;
}
