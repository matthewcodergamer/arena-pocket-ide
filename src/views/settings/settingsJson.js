// settings.json editor: a CodeMirror JSON editor over the user settings. Save (⌘S) validates the
// JSON (comments and trailing commas are allowed, like VS Code's JSONC) and replaces the user values.
// Unknown keys and values of the wrong type are flagged as warnings, exactly like VS Code does.

import { h, isTouch } from '../../core/dom.js';
import { bus, DisposableStore } from '../../core/events.js';
import { settings } from '../../core/settings.js';
import { log } from '../../core/output.js';
import { parseJsonc, lineColOf } from './jsonc.js';
import { settingLabel, defaultOf } from './model.js';

let cmPromise = null;
function loadCodeMirror() {
  cmPromise ??= import('../../../vendor/codemirror.js').then(async CM => {
    let json = null;
    try { json = await CM.languages.find(l => l.name === 'JSON')?.load(); } catch (err) { log.warn('JSON language support failed to load', err); }
    return { CM, json };
  });
  return cmPromise;
}

export function serializeUserSettings() {
  const values = settings.userValues();
  return Object.keys(values).length ? `${JSON.stringify(values, null, 2)}\n` : '{\n}\n';
}

function typeOk(schema, v) {
  if (Array.isArray(schema.enum)) return schema.enum.some(e => JSON.stringify(e) === JSON.stringify(v));
  switch (schema.type) {
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && Number.isFinite(v) && (!schema.integer || Number.isInteger(v));
    case 'string': case 'text': return typeof v === 'string';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}
function typeMessage(schema, v) {
  if (Array.isArray(schema.enum)) return `Value is not accepted. Valid values: ${schema.enum.map(e => JSON.stringify(e)).join(', ')}.`;
  if (schema.type === 'number' && typeof v === 'number' && schema.integer) return 'Incorrect type. Expected "integer".';
  return `Incorrect type. Expected "${schema.type === 'text' ? 'string' : schema.type}".`;
}

/** Diagnostics for a settings.json text: [{ from, to, severity, message }] */
export function validateSettingsText(text) {
  const r = parseJsonc(text);
  if (r.error) {
    const from = Math.min(r.error.offset, text.length);
    return { parsed: r, diagnostics: [{ from, to: Math.min(text.length, from + 1), severity: 'error', message: r.error.message }] };
  }
  const diagnostics = [];
  if (r.value === null || typeof r.value !== 'object' || Array.isArray(r.value)) {
    diagnostics.push({ from: 0, to: Math.min(text.length, 1), severity: 'error', message: 'Settings must be a JSON object: { "setting.id": value }.' });
    return { parsed: r, diagnostics };
  }
  for (const k of r.keys) {
    const schema = settings.schema(k.key);
    const keyEnd = k.offset + JSON.stringify(k.key).length;
    if (!schema) { diagnostics.push({ from: k.offset, to: keyEnd, severity: 'warning', message: 'Unknown Configuration Setting' }); continue; }
    const v = r.value[k.key];
    if (!typeOk(schema, v)) diagnostics.push({ from: k.valueOffset, to: Math.max(k.valueOffset + 1, k.end), severity: 'warning', message: typeMessage(schema, v) });
    else if (schema.type === 'number' && ((schema.min != null && v < schema.min) || (schema.max != null && v > schema.max))) {
      diagnostics.push({ from: k.valueOffset, to: k.end, severity: 'warning', message: schema.min != null && v < schema.min ? `Value is below the minimum of ${schema.min}.` : `Value is above the maximum of ${schema.max}.` });
    }
  }
  return { parsed: r, diagnostics };
}

export async function createSettingsJsonEditor(input, container, api) {
  const store = new DisposableStore();
  const banner = h('div', { class: 'settings-json-banner hidden', role: 'alert' });
  const host = h('div', { class: 'settings-json-editor' });
  container.classList.add('settings-json-container');
  container.append(banner, host);

  const { CM, json } = await loadCodeMirror();
  const { EditorState, Compartment } = CM.state;
  const { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, dropCursor, MatchDecorator, Decoration, ViewPlugin } = CM.view;
  const { defaultKeymap, history, historyKeymap, indentWithTab } = CM.commands;
  const { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle, foldKeymap, indentUnit, syntaxTree } = CM.language;
  const { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } = CM.autocomplete;
  const { linter, lintGutter, lintKeymap } = CM.lint;
  const { searchKeymap, highlightSelectionMatches } = CM.search;
  const { tags } = CM.highlight;

  const highlight = HighlightStyle.define([
    { tag: tags.propertyName, color: 'var(--tok-property)' },
    { tag: tags.string, color: 'var(--tok-string)' },
    { tag: tags.number, color: 'var(--tok-number)' },
    { tag: [tags.bool, tags.null], color: 'var(--tok-keyword)' },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--tok-comment)' },
    { tag: [tags.separator, tags.brace, tags.squareBracket, tags.punctuation], color: 'var(--tok-punctuation)' },
    { tag: tags.invalid, color: 'var(--tok-invalid)' }
  ]);
  const makeTheme = (fontSize = Number(settings.get('editor.fontSize', 13)) || 13) => EditorView.theme({
    '&': { height: '100%', backgroundColor: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)', fontSize: `${fontSize}px` },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
    '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
    '.cm-gutters': { backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-activeForeground)' },
    '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)', outline: '1px solid var(--vscode-editorBracketMatch-border)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--vscode-editor-selectionHighlightBackground)' },
    '.cm-tooltip': { backgroundColor: 'var(--vscode-editorHoverWidget-background)', border: '1px solid var(--vscode-editorHoverWidget-border)', color: 'var(--vscode-editor-foreground)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground)', color: 'inherit' },
    '.cm-completionMatchedText': { color: 'var(--vscode-editorSuggestWidget-highlightForeground)', textDecoration: 'none', fontWeight: '600' },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--vscode-icon-foreground)' },
    '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--vscode-editorError-foreground)', textUnderlineOffset: '3px' },
    '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--vscode-editorWarning-foreground)', textUnderlineOffset: '3px' },
    '.cm-jsonc-comment, .cm-jsonc-comment *': { color: 'var(--tok-comment) !important' },
    '.cm-panels': { backgroundColor: 'var(--vscode-editorWidget-background)', color: 'var(--vscode-editorWidget-foreground)' }
  });

  // Setting-key completions inside property names: "edi| → "editor.fontSize"
  const completeKeys = ctx => {
    const m = ctx.matchBefore(/"[\w.-]*/);
    if (!m) return null;
    const before = ctx.state.sliceDoc(Math.max(0, m.from - 400), m.from).replace(/\/\/[^\n]*$/gm, '').replace(/\s+$/, '');
    const parsed = parseJsonc(ctx.state.doc.toString());
    if (/:$/.test(before)) {
      // Value position: offer the enum values of the setting being edited.
      const key = before.match(/"([\w.-]+)"\s*:$/)?.[1];
      const schema = key && settings.schema(key);
      const values = (schema?.enum || []).filter(v => typeof v === 'string');
      if (!values.length) return null;
      return {
        from: m.from + 1, validFor: /^[\w.-]*$/,
        options: values.map((v, i) => ({ label: v, type: 'enum', detail: schema.enumLabels?.[i] && schema.enumLabels[i] !== v ? schema.enumLabels[i] : '', info: schema.enumDescriptions?.[i] || '' }))
      };
    }
    if (!/[{,]$/.test(before)) return null;
    const existing = new Set(Object.keys(parsed.value && typeof parsed.value === 'object' ? parsed.value : {}));
    const options = settings.all().filter(s => !existing.has(s.key)).map(s => {
      const def = defaultOf(s);
      const { category, title } = settingLabel(s);
      return {
        label: s.key, type: 'property', detail: `${category ? category + ': ' : ''}${title}`, info: s.description || '',
        apply: (view, completion, from, to) => {
          const closing = view.state.sliceDoc(to, to + 1) === '"' ? 1 : 0;
          const insert = `${s.key}": ${JSON.stringify(def === undefined ? null : def)}`;
          view.dispatch({ changes: { from, to: to + closing, insert }, selection: { anchor: from + insert.length } });
        }
      };
    });
    return { from: m.from + 1, options, validFor: /^[\w.-]*$/ };
  };

  // The JSON grammar has no comments; settings.json (JSONC) does — color // and /* */ comments outside strings.
  const commentMark = Decoration.mark({ class: 'cm-jsonc-comment' });
  const commentDecorator = new MatchDecorator({
    regexp: /\/\/.*|\/\*.*?(?:\*\/|$)/g,
    decorate: (add, from, to, match, view) => {
      const node = syntaxTree(view.state).resolveInner(from, 1);
      if (node.name !== 'String' && node.name !== 'PropertyName') add(from, to, commentMark);
    }
  });
  const comments = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = commentDecorator.createDeco(view); }
    update(u) { this.decorations = commentDecorator.updateDeco(u, this.decorations); }
  }, { decorations: v => v.decorations });

  let baseline = serializeUserSettings();
  let applying = false;
  const lint = linter(view => validateSettingsText(view.state.doc.toString()).diagnostics, { delay: 300 });
  const themeCompartment = new Compartment();

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: baseline,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), foldGutter(), lintGutter(),
        highlightSpecialChars(), history(), drawSelection(), dropCursor(), indentOnInput(), bracketMatching(), closeBrackets(),
        highlightActiveLine(), highlightSelectionMatches(), indentUnit.of('  '), EditorState.tabSize.of(2),
        autocompletion({ override: [completeKeys], activateOnTyping: true }),
        json ? json : [],
        syntaxHighlighting(highlight),
        comments,
        themeCompartment.of(makeTheme()),
        lint,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'settings.json' }),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
        EditorView.updateListener.of(u => {
          if (!u.docChanged || applying) return;
          api.setDirty(u.state.doc.toString() !== baseline);
          if (!banner.classList.contains('hidden')) hideBanner();
        })
      ]
    })
  });

  function showBanner(message) {
    banner.textContent = message;
    banner.classList.remove('hidden');
  }
  function hideBanner() { banner.classList.add('hidden'); banner.textContent = ''; }

  function setText(text) {
    applying = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    applying = false;
    baseline = text;
    api.setDirty(false);
  }

  function reveal(key) {
    if (!key) return;
    const text = view.state.doc.toString();
    const at = text.indexOf(JSON.stringify(key));
    if (at >= 0) {
      view.dispatch({ selection: { anchor: at + 1, head: at + 1 + key.length }, scrollIntoView: true });
    } else {
      // Not configured yet: add it with its default value, like VS Code's "Edit in settings.json".
      const schema = settings.schema(key);
      const r = parseJsonc(text);
      if (r.error || typeof r.value !== 'object' || !r.value) return;
      const close = text.lastIndexOf('}');
      if (close < 0) return;
      const before = text.slice(0, close).replace(/\s*$/, '');
      const needsComma = before.trim() !== '{' && !before.endsWith(',');
      const insert = `${needsComma ? ',' : ''}\n  ${JSON.stringify(key)}: ${JSON.stringify(schema ? (defaultOf(schema) ?? null) : null, null, 2).replace(/\n/g, '\n  ')}\n`;
      view.dispatch({ changes: { from: before.length, to: close, insert }, selection: { anchor: before.length + insert.indexOf(':') + 2 }, scrollIntoView: true });
    }
  }

  // External changes (Settings UI, theme picker…) refresh the JSON unless the user has unsaved edits.
  store.add(bus.on('settings:changed', () => {
    if (applying) return;
    const next = serializeUserSettings();
    const current = view.state.doc.toString();
    if (current === baseline) { if (next !== baseline) setText(next); }
    else if (current === next) { baseline = next; api.setDirty(false); }
  }));

  store.add(settings.onChange('editor.fontSize', v => view.dispatch({ effects: themeCompartment.reconfigure(makeTheme(Number(v) || 13)) })));

  if (input?.revealSetting) setTimeout(() => reveal(input.revealSetting), 0);

  return {
    view,
    async save() {
      const text = view.state.doc.toString();
      const { parsed, diagnostics } = validateSettingsText(text);
      const errors = diagnostics.filter(d => d.severity === 'error');
      if (errors.length) {
        const { line, col } = lineColOf(text, errors[0].from);
        showBanner(`Unable to save settings.json: ${errors[0].message} (line ${line}, column ${col}). Fix the error and save again.`);
        view.dispatch({ selection: { anchor: errors[0].from }, scrollIntoView: true });
        return false;
      }
      applying = true;
      try { settings.replaceUserValues(parsed.value); }
      finally { applying = false; }
      baseline = text;
      api.setDirty(false);
      hideBanner();
      return true;
    },
    isDirty() { return view.state.doc.toString() !== baseline; },
    focus() { if (!isTouch()) view.focus(); },
    setInput(next) { if (next?.revealSetting) reveal(next.revealSetting); },
    onShow() { view.requestMeasure(); },
    getState() { return { selection: view.state.selection.main.head, scroll: view.scrollDOM.scrollTop }; },
    setState(state) {
      if (state?.selection != null && state.selection <= view.state.doc.length) view.dispatch({ selection: { anchor: state.selection } });
      if (state?.scroll) requestAnimationFrame(() => { view.scrollDOM.scrollTop = state.scroll; });
    },
    dispose() { store.dispose(); view.destroy(); }
  };
}
