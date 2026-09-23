// Syntax highlighting: lezer tags → VS Code Dark+/Light+ token classes (tok-*), colored by css/editor.css
// through var(--tok-*) so switching color themes never rebuilds an editor.
//
//   xcHighlighters            [general, css]  (use with syntaxHighlighting / highlightTree)
//   highlightCode(code, lang) → Promise<HTML string> (static highlight for chat, markdown preview, hovers)

import { highlight as HL } from './cm.js';
import { escapeHtml } from '../core/dom.js';
import { languageByAlias, loadSupport } from './languages.js';

const { tags: t, tagHighlighter, highlightTree } = HL;

export const xcHighlighter = tagHighlighter([
  { tag: [t.controlKeyword, t.moduleKeyword], class: 'tok-control' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.self, t.definitionKeyword, t.changed], class: 'tok-keyword' },
  { tag: [t.null, t.bool, t.atom], class: 'tok-constant' },
  { tag: t.function(t.punctuation), class: 'tok-keyword' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'tok-function' },
  { tag: t.variableName, class: 'tok-variable' },
  { tag: t.constant(t.variableName), class: 'tok-constant-var' },
  { tag: [t.propertyName], class: 'tok-property' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
  { tag: [t.string, t.character, t.docString, t.attributeValue, t.monospace], class: 'tok-string' },
  { tag: t.special(t.string), class: 'tok-string' },
  { tag: t.regexp, class: 'tok-regexp' },
  { tag: t.escape, class: 'tok-escape' },
  { tag: [t.number, t.integer, t.float, t.unit], class: 'tok-number' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.quote, class: 'tok-comment' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.punctuation, class: 'tok-punctuation' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.angleBracket, class: 'tok-tag-bracket' },
  { tag: t.attributeName, class: 'tok-attribute' },
  { tag: t.heading, class: 'tok-heading' },
  { tag: [t.link, t.url], class: 'tok-link' },
  { tag: [t.meta, t.documentMeta, t.annotation, t.processingInstruction, t.contentSeparator], class: 'tok-meta' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: t.invalid, class: 'tok-invalid' },
  { tag: t.inserted, class: 'tok-inserted' },
  { tag: t.deleted, class: 'tok-deleted' },
  { tag: t.color, class: 'tok-css-value' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.strikethrough, class: 'tok-strikethrough' }
]);

/** Stylesheet-only overrides (VS Code colors selectors gold, values orange, at-rules purple, functions yellow). */
export const cssHighlighter = tagHighlighter([
  { tag: [t.tagName, t.className, t.labelName, t.constant(t.className), t.definitionOperator], class: 'tok-css-selector' },
  { tag: [t.atom, t.color], class: 'tok-css-value' },
  { tag: t.operatorKeyword, class: 'tok-css-function' },
  { tag: t.definitionKeyword, class: 'tok-css-atrule' },
  { tag: t.variableName, class: 'tok-css-variable' }
], { scope: type => type.name === 'StyleSheet' });

export const xcHighlighters = [xcHighlighter, cssHighlighter];

/** Renders `code` as HTML with tok-* spans using the language's lezer parser. Everything is escaped. */
export async function highlightCode(code = '', lang = '') {
  const text = String(code ?? '');
  if (!text || text.length > 300_000) return escapeHtml(text);
  try {
    const language = typeof lang === 'object' && lang?.id ? lang : languageByAlias(lang);
    const support = await loadSupport(language);
    if (!support) return escapeHtml(text);
    const tree = support.language.parser.parse(text);
    let out = '', pos = 0;
    highlightTree(tree, xcHighlighters, (from, to, classes) => {
      if (from > pos) out += escapeHtml(text.slice(pos, from));
      out += `<span class="${classes}">${escapeHtml(text.slice(from, to))}</span>`;
      pos = to;
    });
    if (pos < text.length) out += escapeHtml(text.slice(pos));
    return out;
  } catch (err) {
    console.warn('[X Coder] highlightCode failed', err);
    return escapeHtml(text);
  }
}
