// Search feature: the SEARCH view container, Find/Replace in Files commands (VS Code IDs and
// argument shape) and search.* settings.

import { settings } from '../core/settings.js';
import { commands } from '../core/commands.js';
import { views } from '../workbench/views.js';
import { layout } from '../workbench/layout.js';
import { codeEditor } from '../editor/api.js';
import { SearchView, SEARCH_VIEW } from './search/view.js';

const CONTAINER = 'workbench.view.search';
let current = null;

function registerSettings() {
  settings.register(
    { key: 'search.exclude', type: 'string', default: '**/node_modules, **/.git, **/bower_components', category: 'Features/Search', title: 'Exclude', order: 1,
      description: 'Comma-separated glob patterns for excluding files and folders in full text searches (e.g. **/node_modules, **/*.min.js). Applied when "Use Exclude Settings and Ignore Files" is on in the Search view.' },
    { key: 'search.smartCase', type: 'boolean', default: false, category: 'Features/Search', title: 'Smart Case', order: 2,
      description: 'Search case-insensitively if the pattern is all lowercase, otherwise, search case-sensitively.' },
    { key: 'search.searchOnType', type: 'boolean', default: true, category: 'Features/Search', title: 'Search On Type', order: 3,
      description: 'Search all files as you type.' },
    { key: 'search.searchOnTypeDebouncePeriod', type: 'number', default: 300, min: 0, max: 5000, integer: true, category: 'Features/Search', title: 'Search On Type Debounce Period', order: 4,
      description: 'When Search On Type is enabled, controls the timeout in milliseconds between a character being typed and the search starting.' },
    { key: 'search.defaultViewMode', type: 'enum', default: 'list', enum: ['tree', 'list'], enumLabels: ['tree', 'list'],
      enumDescriptions: ['Shows search results as a tree.', 'Shows search results as a list.'], category: 'Features/Search', title: 'Default View Mode', order: 5,
      description: 'Controls the default search result view mode.' }
  );
}

/** Opens the Search view (rendering it if needed) and returns the live SearchView. */
function show() {
  views.open(CONTAINER);
  return current;
}

/** VS Code's workbench.action.findInFiles: args { query, replace, isRegex, isCaseSensitive, matchWholeWord,
 *  preserveCase, filesToInclude, filesToExclude, triggerSearch, showIncludesExcludes, onlyOpenEditors }. */
function findInFiles(args, { replace = false } = {}) {
  const view = show();
  if (!view) return null;
  const opts = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const explicitQuery = typeof opts.query === 'string';
  if (!explicitQuery && !opts.filesToInclude && !opts.filesToExclude) {
    // Seed with the editor selection (single line), like VS Code.
    let sel = '';
    try { sel = codeEditor.getActive()?.getSelectionText?.() || ''; } catch {}
    if (sel && !sel.includes('\n') && sel.length <= 300) opts.query = sel;
  }
  if (replace) opts.replace = opts.replace ?? view.state.replace;
  const before = JSON.stringify(view.query());
  view.setQuery(opts);
  const changed = JSON.stringify(view.query()) !== before;
  // Focus synchronously so the iOS keyboard opens from the tap that ran the command.
  if (!layout.isPhone || opts.focus !== false) {
    if (replace && view.state.query) view.focusReplace(); else view.focusSearch();
  }
  if (view.state.query && (changed || opts.triggerSearch || !view.result)) view.search({ addHistory: true });
  return view;
}

export async function activate() {
  registerSettings();
  views.registerContainer({ id: CONTAINER, title: 'Search', icon: 'search', order: 2, keybinding: 'Mod+Shift+F' });
  views.registerView({
    id: SEARCH_VIEW, containerId: CONTAINER, name: 'Search', order: 1, size: 'fill',
    actions: () => current?.actions() || [],
    render(body) {
      current?.dispose();
      const view = new SearchView(body);
      current = view;
      return {
        dispose: () => { view.dispose(); if (current === view) current = null; },
        onShow: () => view.onShow(),
        focus: () => view.focus()
      };
    }
  });
  commands.registerAll([
    { id: 'workbench.action.findInFiles', title: 'Find in Files', category: 'Search', icon: 'search', keybinding: 'Mod+Shift+F', allowInInput: true, run: args => findInFiles(args) },
    { id: 'workbench.action.replaceInFiles', title: 'Replace in Files', category: 'Search', icon: 'replace-all', keybinding: 'Mod+Shift+H', allowInInput: true, run: args => findInFiles(args, { replace: true }) },
    { id: 'search.action.clearSearchResults', title: 'Clear Search Results', category: 'Search', icon: 'clear-all', run: () => { const v = current || show(); v?.clear(); } },
    { id: 'search.action.refreshSearchResults', title: 'Refresh', category: 'Search', icon: 'refresh', run: () => { const v = current || show(); return v?.search({ keepView: true }) || null; } },
    { id: 'search.action.collapseSearchResults', title: 'Collapse All', category: 'Search', icon: 'collapse-all', run: () => { const v = current || show(); v?.collapseAll(); } }
  ]);
}

/** For other features/tests: the live Search view (or null when it has never been shown). */
export function searchView() { return current; }
