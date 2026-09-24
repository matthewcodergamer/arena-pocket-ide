// Suggest widget: CodeMirror autocompletion styled like VS Code's (codicon symbol icons per kind,
// highlighted matches, details on the focused row) + word-based suggestions.

import { autocomplete as AC, state as S, view as V } from './cm.js';
import { settings } from '../core/settings.js';

const { autocompletion, completeAnyWord, completionStatus, closeCompletion } = AC;
const { EditorState, Prec } = S;
const { keymap } = V;

const KIND_ICON = {
  function: 'symbol-method', method: 'symbol-method', constructor: 'symbol-method',
  class: 'symbol-class', interface: 'symbol-interface', enum: 'symbol-enum', 'enum-member': 'symbol-enum-member',
  variable: 'symbol-variable', constant: 'symbol-constant', property: 'symbol-property', field: 'symbol-field',
  type: 'symbol-class', namespace: 'symbol-namespace', module: 'symbol-module', keyword: 'symbol-keyword',
  text: 'symbol-text', snippet: 'symbol-snippet', emmet: 'symbol-snippet', color: 'symbol-color', unit: 'symbol-unit',
  value: 'symbol-value', operator: 'symbol-operator', event: 'symbol-event', file: 'symbol-file', folder: 'symbol-folder',
  reference: 'symbol-reference', struct: 'symbol-struct', parameter: 'symbol-parameter', 'type-parameter': 'symbol-type-parameter',
  tag: 'symbol-field', attribute: 'symbol-field', string: 'symbol-string', number: 'symbol-number', boolean: 'symbol-boolean'
};

function iconFor(completion) {
  const type = String(completion.type || 'text').split(/\s+/)[0];
  return KIND_ICON[type] || 'symbol-misc';
}

/** Word-based suggestions ("abc" words from the document) ranked after language suggestions. */
async function wordSuggestions(ctx) {
  if (!settings.get('editor.wordBasedSuggestions', true)) return null;
  const result = await completeAnyWord(ctx);
  if (!result) return null;
  return { ...result, options: result.options.map(o => ({ ...o, type: 'text', boost: -20 })) };
}

export function completionExtensions() {
  const acceptOnEnter = settings.get('editor.acceptSuggestionOnEnter', 'on') !== 'off';
  return [
    autocompletion({
      activateOnTyping: settings.get('editor.quickSuggestions', true) !== false,
      icons: false,
      closeOnBlur: true,
      maxRenderedOptions: 60,
      defaultKeymap: true,
      aboveCursor: false,
      selectOnOpen: true,
      tooltipClass: () => 'suggest-widget',
      optionClass: c => `suggest-kind-${String(c.type || 'text').split(/\s+/)[0]}`,
      addToOptions: [{
        position: 20,
        render(completion) {
          const el = document.createElement('span');
          el.className = `suggest-icon codicon codicon-${iconFor(completion)}`;
          el.setAttribute('aria-hidden', 'true');
          return el;
        }
      }]
    }),
    // editor.acceptSuggestionOnEnter = off: Enter closes the suggest widget and inserts a new line.
    acceptOnEnter ? [] : Prec.highest(keymap.of([{ key: 'Enter', run: view => { if (completionStatus(view.state) === 'active') closeCompletion(view); return false; } }])),
    EditorState.languageData.of(() => [{ autocomplete: wordSuggestions }])
  ];
}
