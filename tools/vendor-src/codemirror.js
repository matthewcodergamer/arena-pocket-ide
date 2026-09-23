// Single shared CodeMirror 6 entry. Every X Coder module imports CodeMirror from
// vendor/codemirror.js so there is exactly one copy of @codemirror/state in memory.
export * as state from '@codemirror/state';
export * as view from '@codemirror/view';
export * as commands from '@codemirror/commands';
export * as language from '@codemirror/language';
export * as search from '@codemirror/search';
export * as autocomplete from '@codemirror/autocomplete';
export * as lint from '@codemirror/lint';
export * as highlight from '@lezer/highlight';
export * as lezer from '@lezer/common';
export * as merge from '@codemirror/merge';
export { indentationMarkers } from '@replit/codemirror-indentation-markers';
// Language descriptions (~150 languages). Each description's load() is a lazy chunk.
export { languages } from '@codemirror/language-data';
