// Extensions view (feature entry point). VS Code's Extensions viewlet look — search box, INSTALLED and
// BUILT-IN FEATURES sections, one row per extension with icon, name, description, publisher and a
// manage gear — listing X Coder's own capabilities as built-in extensions (there is no marketplace;
// every entry is labeled Built-in). Tapping a row opens the extension editor.

import { h, clear, codicon, debounce, onContextMenu, isTouch } from '../core/dom.js';
import { bus } from '../core/events.js';
import { commands } from '../core/commands.js';
import { views } from '../workbench/views.js';
import { editors } from '../workbench/editors.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { EXTENSIONS, extensionById } from './extensions/catalog.js';
import { extensionState, setExtensionEnabled, manageMenu, iconTile, openExtension } from './extensions/shared.js';
import { createExtensionEditor } from './extensions/extensionEditor.js';

const CONTAINER = 'workbench.view.extensions';
const VIEW = 'workbench.extensions.list';
let viewApi = null; // { setQuery(q), focus() } once rendered
let pendingQuery = null;

const SECTIONS = [
  { id: 'installed', title: 'Installed', filter: e => e.section === 'installed' },
  { id: 'builtin', title: 'Built-in Features', filter: e => e.section === 'builtin' }
];

function parseQuery(q) {
  const out = { words: [], filters: new Set() };
  for (const t of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (t.startsWith('@')) out.filters.add(t.slice(1)); else out.words.push(t);
  }
  return out;
}
function matches(ext, q) {
  const state = extensionState(ext);
  for (const f of q.filters) {
    if (f === 'installed' || f === 'builtin') continue; // every X Coder extension is installed and built in
    if (f === 'enabled' && !state.enabled) return false;
    if (f === 'disabled' && state.enabled) return false;
    if (!['installed', 'builtin', 'enabled', 'disabled'].includes(f)) return false;
  }
  const hay = `${ext.name} ${ext.id} ${ext.description}`.toLowerCase();
  return q.words.every(w => hay.includes(w));
}

function renderView(body) {
  const collapsed = new Set();
  const input = h('input', {
    class: 'input', type: 'text', placeholder: 'Search Extensions', 'aria-label': 'Search Extensions',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search'
  });
  const header = h('div', { class: 'extensions-search-container' }, h('div', { class: 'monaco-inputbox extensions-search-box' }, input));
  const lists = h('div', { class: 'extensions-sections' });
  const root = h('div', { class: 'extensions-viewlet' }, header, lists);
  body.append(root);

  function row(ext) {
    const state = extensionState(ext);
    const gear = h('a', { class: 'action-label codicon codicon-gear extension-manage', role: 'button', tabindex: '0', title: 'Manage', 'aria-label': `Manage ${ext.name}` });
    gear.addEventListener('click', e => { e.stopPropagation(); showContextMenu(manageMenu(ext), { anchor: gear, align: 'right' }); });
    const actions = h('div', { class: 'extension-actions monaco-toolbar' });
    if (!state.enabled && ext.toggle) {
      const enable = h('button', { class: 'monaco-button prominent extension-action', type: 'button', title: `Enable ${ext.name}` }, 'Enable');
      enable.addEventListener('click', e => { e.stopPropagation(); setExtensionEnabled(ext, true); });
      actions.append(enable);
    }
    actions.append(gear);
    const el = h('div', {
      class: ['extension-list-item', 'monaco-list-row', !state.enabled && 'disabled'], role: 'listitem', tabindex: '0',
      'data-extension': ext.id, 'aria-label': `${ext.name}, ${ext.description}${state.enabled ? '' : ', disabled'}`
    },
      iconTile(ext, 'small'),
      h('div', { class: 'details' },
        h('div', { class: 'header-container' },
          h('div', { class: 'header' },
            h('span', { class: 'name' }, ext.name),
            h('span', { class: 'extension-builtin-label' }, 'Built-in'))),
        h('div', { class: 'description' }, ext.description),
        h('div', { class: 'footer' },
          h('div', { class: 'author' }, h('span', { class: 'publisher-name' }, 'X Coder'), codicon('verified-filled', 'verified-publisher'),
            state.enabled ? null : h('span', { class: 'extension-status' }, '· Disabled')),
          actions)));
    el.addEventListener('click', () => openExtension(ext.id));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); openExtension(ext.id, { pinned: true }); } });
    el.addEventListener('dblclick', () => editors.pin(`extension:${ext.id}`));
    onContextMenu(el, (x, y) => showContextMenu(manageMenu(ext), { x, y }));
    return el;
  }

  function render() {
    const q = parseQuery(input.value);
    const scroll = lists.scrollTop;
    clear(lists);
    let total = 0;
    for (const section of SECTIONS) {
      const items = EXTENSIONS.filter(section.filter).filter(e => matches(e, q))
        .sort((a, b) => extensionState(b).enabled - extensionState(a).enabled || a.name.localeCompare(b.name));
      if (!items.length && (q.words.length || q.filters.size)) continue;
      total += items.length;
      const isCollapsed = collapsed.has(section.id);
      const head = h('div', { class: 'extensions-section-header pane-header', role: 'button', tabindex: '0', 'aria-expanded': String(!isCollapsed), 'data-section': section.id },
        codicon(isCollapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
        h('h3', { class: 'title' }, section.title.toUpperCase()),
        h('span', { class: 'monaco-count-badge' }, String(items.length)));
      head.addEventListener('click', () => { isCollapsed ? collapsed.delete(section.id) : collapsed.add(section.id); render(); });
      head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } });
      const list = h('div', { class: ['extensions-list', 'monaco-list', isCollapsed && 'hidden'], role: 'list', 'aria-label': section.title });
      for (const ext of items) list.append(row(ext));
      lists.append(h('div', { class: 'extensions-section', 'data-section': section.id }, head, list));
    }
    if (!total && (q.words.length || q.filters.size)) lists.append(h('div', { class: 'view-message extensions-empty' }, 'No extensions found.'));
    lists.scrollTop = scroll;
  }

  input.addEventListener('input', debounce(render, 80));
  input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; render(); } });
  const off = bus.on('settings:changed', e => { if (EXTENSIONS.some(x => x.toggle === e.key)) render(); });
  render();

  viewApi = {
    setQuery(q) { input.value = q; render(); },
    query: () => input.value,
    focus() { if (!isTouch()) input.focus({ preventScroll: true }); }
  };
  if (pendingQuery !== null) { viewApi.setQuery(pendingQuery); pendingQuery = null; }
  return { focus: () => viewApi.focus(), dispose() { off(); viewApi = null; } };
}

function showExtensions(query) {
  views.open(CONTAINER, { focus: false });
  if (viewApi) viewApi.setQuery(query); else pendingQuery = query;
}

function filterMenu() {
  const set = q => () => showExtensions(q);
  return [
    { label: 'Installed', run: set('@installed') },
    { label: 'Built-in', run: set('@builtin') },
    { label: 'Enabled', run: set('@enabled') },
    { label: 'Disabled', run: set('@disabled') }
  ];
}

export async function activate() {
  views.registerContainer({ id: CONTAINER, title: 'Extensions', icon: 'extensions', order: 5, keybinding: 'Mod+Shift+X' });
  views.registerView({
    id: VIEW, containerId: CONTAINER, name: 'Extensions', containerTitle: 'Extensions',
    render: body => renderView(body),
    actions: () => [
      { icon: 'filter', title: 'Filter Extensions…', run: e => showContextMenu(filterMenu(), { anchor: e?.currentTarget || e?.target, align: 'right' }) },
      { icon: 'clear-all', title: 'Clear Extensions Search Results', run: () => showExtensions('') }
    ],
    moreActions: () => [
      { label: 'Show Installed Extensions', run: () => showExtensions('@installed') },
      { label: 'Show Enabled Extensions', run: () => showExtensions('@enabled') },
      { label: 'Show Disabled Extensions', run: () => showExtensions('@disabled') },
      { separator: true },
      { label: 'Enable All Extensions', run: () => EXTENSIONS.filter(e => e.toggle).forEach(e => setExtensionEnabled(e, true)) },
      { label: 'Disable All Extensions', run: () => EXTENSIONS.filter(e => e.toggle).forEach(e => setExtensionEnabled(e, false)) }
    ]
  });

  editors.registerProvider('extension', {
    title: input => `Extension: ${extensionById(input.id)?.name || input.id}`,
    tooltip: input => `Extension: ${extensionById(input.id)?.name || input.id}`,
    icon: () => '<span class="codicon codicon-extensions" aria-hidden="true"></span>',
    create: (input, container) => { container.classList.add('extension-editor-container'); return createExtensionEditor(input, container); }
  });

  commands.register({
    id: 'workbench.extensions.action.showInstalledExtensions', title: 'Show Installed Extensions', category: 'Extensions', icon: 'extensions',
    run: () => showExtensions('@installed')
  });
}
