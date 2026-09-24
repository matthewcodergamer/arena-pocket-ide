// Single CodeMirror 6 entry for the editor feature (re-exports the vendored namespaces).
import * as CM from '../../vendor/codemirror.js';

export { state, view, commands, language, search, autocomplete, lint, highlight, lezer, merge, indentationMarkers, languages } from '../../vendor/codemirror.js';
export default CM;
