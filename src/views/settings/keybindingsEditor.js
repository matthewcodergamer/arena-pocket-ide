// Keyboard Shortcuts editor (VS Code "Keybindings editor"): a searchable, sortable table of every
// command — Command | Keybinding | When | Source. X Coder's keybindings are built in; customizing
// them is not supported yet and the editor says so.

import { h, clear, codicon, debounce, copyText, onContextMenu, isTouch, isApple, escapeHtml, highlightMatches } from '../../core/dom.js';
import { commands, fullTitle, keybindingLabel } from '../../core/commands.js';
import { showContextMenu } from '../../platform/contextmenu.js';
import { notify } from '../../platform/notifications.js';

/** Splits a keybinding label into keycaps: '⇧⌘P' → ['⇧', '⌘', 'P'], 'Ctrl+Shift+P' → ['Ctrl', 'Shift', 'P']. */
export function keycaps(label) {
  if (!label) return [];
  if (label.includes('+') && label.length > 1) return label.split('+').filter(Boolean);
  return label.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g) || [label];
}

/** Search text for a keybinding spec so users can type "cmd+s", "ctrl shift p" or the symbols. */
function keySearchText(spec) {
  const specs = [spec].flat().filter(Boolean);
  return specs.map(s => {
    const lower = s.toLowerCase();
    const words = lower.replace(/mod/g, isApple ? 'cmd meta command' : 'ctrl control').replace(/alt/g, isApple ? 'alt option opt' : 'alt').replace(/\+/g, ' ');
    return `${keybindingLabel(s)} ${lower} ${words} ${lower.replace(/mod/g, isApple ? 'cmd' : 'ctrl')}`;
  }).join(' ').toLowerCase();
}

function entries() {
  const out = [];
  for (const c of commands.all()) {
    if (!c.title) continue;
    const specs = [c.keybinding].flat().filter(Boolean);
    const base = { id: c.id, title: fullTitle(c), when: c.when ? 'when available' : '', source: 'System', cmd: c };
    if (specs.length) for (const spec of specs) out.push({ ...base, spec, label: keybindingLabel(spec), search: keySearchText(spec) });
    else out.push({ ...base, spec: null, label: '', search: '' });
  }
  return out;
}

export function createKeybindingsEditor(input, container) {
  let sort = { by: 'default', dir: 1 };
  const searchInput = h('input', {
    class: 'input', type: 'text', placeholder: 'Type to search in keybindings', 'aria-label': 'Type to search in keybindings',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search'
  });
  const count = h('div', { class: 'keybindings-count' });
  const clearBtn = h('a', { class: 'action-label codicon codicon-clear-all', role: 'button', tabindex: '0', title: 'Clear Keybindings Search Input', 'aria-label': 'Clear Keybindings Search Input' });
  const sortBtn = h('a', { class: 'action-label codicon codicon-sort-precedence', role: 'button', tabindex: '0', title: 'Sort by Precedence (Highest first)', 'aria-label': 'Sort by Precedence' });
  clearBtn.addEventListener('click', () => { searchInput.value = ''; render(); searchInput.focus(); });
  sortBtn.addEventListener('click', () => { sort = sort.by === 'precedence' ? { by: 'default', dir: 1 } : { by: 'precedence', dir: 1 }; sortBtn.classList.toggle('checked', sort.by === 'precedence'); render(); });
  const searchBox = h('div', { class: 'keybindings-search-container monaco-inputbox' }, h('span', { class: 'settings-search-icon' }, codicon('search')), searchInput, h('div', { class: 'controls monaco-toolbar' }, sortBtn, clearBtn));
  const notice = h('div', { class: 'keybindings-notice' }, codicon('info'),
    h('span', {}, isTouch() ? 'Built-in shortcuts for hardware keyboards; customizing them is not supported yet. Tap a command for actions.' : 'These are X Coder’s built-in keyboard shortcuts. Customizing keybindings is not supported yet.'));
  const headRow = h('div', { class: 'keybindings-table-header', role: 'row' });
  const tbody = h('div', { class: 'keybindings-table-rows', role: 'rowgroup' });
  const table = h('div', { class: 'keybindings-table', role: 'table', 'aria-label': 'Keybindings' }, headRow, tbody);
  const root = h('div', { class: 'keybindings-editor' },
    h('div', { class: 'keybindings-header' }, searchBox, h('div', { class: 'keybindings-header-actions' }, count)), notice, table);
  container.append(root);

  const columns = [['command', 'Command'], ['keybinding', 'Keybinding'], ['when', 'When'], ['source', 'Source']];
  function renderHeader() {
    clear(headRow);
    for (const [key, label] of columns) {
      const active = sort.by === key;
      const cell = h('div', { class: ['keybindings-cell', `col-${key}`, active && 'sorted'], role: 'columnheader', tabindex: '0', 'aria-sort': active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none', title: `Sort by ${label}` },
        label, active ? codicon(sort.dir > 0 ? 'arrow-up' : 'arrow-down') : null);
      cell.addEventListener('click', () => { sort = sort.by === key ? { by: key, dir: -sort.dir } : { by: key, dir: 1 }; sortBtn.classList.remove('checked'); render(); });
      cell.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cell.click(); } });
      headRow.append(cell);
    }
  }

  function filterAndSort(list, query) {
    let q = query.trim();
    let exactKey = null;
    const quoted = q.match(/^"(.+)"$/);
    if (quoted) { exactKey = quoted[1].toLowerCase(); q = ''; }
    const lower = q.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    let out = list.map(e => {
      if (exactKey) return e.label.toLowerCase() === exactKey || e.spec?.toLowerCase() === exactKey ? { e, score: 1 } : null;
      if (!lower) return { e, score: 0 };
      // VS Code matches every word of the query against the title, the command id or the keybinding.
      const title = e.title.toLowerCase(), id = e.id.toLowerCase();
      const titleHits = [];
      let score = 0, idMatch = false;
      for (const w of words) {
        const at = title.indexOf(w);
        if (at >= 0) { for (let k = 0; k < w.length; k++) titleHits.push(at + k); score += at === 0 || title[at - 1] === ' ' ? 30 : 20; }
        else if (id.includes(w)) { idMatch = true; score += 10; }
        else if (e.search && e.search.includes(w)) score += 5;
        else return null;
      }
      if (title.includes(lower)) score += 40;
      return { e, score, m: titleHits.length ? { matches: [...new Set(titleHits)].sort((a, b) => a - b) } : null, idMatch };
    }).filter(Boolean);
    const byTitle = (a, b) => a.e.title.localeCompare(b.e.title);
    if (sort.by === 'command') out.sort((a, b) => byTitle(a, b) * sort.dir);
    else if (sort.by === 'keybinding') out.sort((a, b) => ((a.e.label ? 0 : 1) - (b.e.label ? 0 : 1)) || a.e.label.localeCompare(b.e.label) * sort.dir || byTitle(a, b));
    else if (sort.by === 'when') out.sort((a, b) => a.e.when.localeCompare(b.e.when) * sort.dir || byTitle(a, b));
    else if (sort.by === 'source') out.sort((a, b) => a.e.source.localeCompare(b.e.source) * sort.dir || byTitle(a, b));
    else if (sort.by === 'precedence') out.sort((a, b) => ((a.e.label ? 0 : 1) - (b.e.label ? 0 : 1)) || a.e.label.localeCompare(b.e.label) || byTitle(a, b));
    else if (lower) out.sort((a, b) => b.score - a.score || byTitle(a, b));
    else out.sort((a, b) => ((a.e.label ? 0 : 1) - (b.e.label ? 0 : 1)) || byTitle(a, b));
    return out;
  }

  function rowMenu(e) {
    return [
      { label: 'Copy', run: () => copy(`${e.title}${e.label ? ` (${e.label})` : ''}`) },
      { label: 'Copy Command ID', run: () => copy(e.id) },
      { label: 'Copy Command Title', run: () => copy(e.title) },
      { separator: true },
      { label: 'Change Keybinding…', disabled: true, tooltip: 'Customizing keybindings is not supported yet' },
      { label: 'Show Same Keybindings', disabled: !e.label, run: () => { searchInput.value = `"${e.label}"`; render(); } },
      { separator: true },
      { label: 'Run Command', disabled: !commands.isEnabled(e.id), run: () => commands.execute(e.id).catch(() => {}) }
    ];
  }
  async function copy(text) {
    if (await copyText(text)) notify.info('Copied to the clipboard.', { source: 'Keyboard Shortcuts' });
  }

  function render() {
    renderHeader();
    clear(tbody);
    const list = filterAndSort(entries(), searchInput.value);
    count.textContent = `${list.length} ${list.length === 1 ? 'result' : 'results'}`;
    clearBtn.classList.toggle('disabled', !searchInput.value);
    const frag = document.createDocumentFragment();
    for (const { e, m, idMatch } of list) {
      const enabled = commands.isEnabled(e.id);
      const row = h('div', { class: ['keybindings-row', !enabled && 'disabled-command'], role: 'row', tabindex: '-1', 'data-command': e.id, title: e.id },
        h('div', { class: 'keybindings-cell col-command', role: 'cell' },
          h('div', { class: 'command-title', html: m ? highlightMatches(e.title, m.matches) : escapeHtml(e.title) }),
          h('div', { class: ['command-id', idMatch && 'highlight-id'] }, e.id)),
        h('div', { class: 'keybindings-cell col-keybinding', role: 'cell' },
          e.label ? h('span', { class: 'monaco-keybinding' }, ...keycaps(e.label).map(k => h('span', { class: 'monaco-keybinding-key' }, k))) : null),
        h('div', { class: 'keybindings-cell col-when', role: 'cell' }, e.when || '—'),
        h('div', { class: 'keybindings-cell col-source', role: 'cell' }, e.source));
      row.addEventListener('click', ev => {
        if (ev.detail > 1) return;
        tbody.querySelector('.keybindings-row.selected')?.classList.remove('selected');
        row.classList.add('selected');
        if (isTouch()) showContextMenu(rowMenu(e), { x: ev.clientX, y: ev.clientY });
      });
      row.addEventListener('dblclick', () => { if (enabled) commands.execute(e.id).catch(() => {}); });
      onContextMenu(row, (x, y) => showContextMenu(rowMenu(e), { x, y }));
      frag.append(row);
    }
    tbody.append(frag);
    if (!list.length) tbody.append(h('div', { class: 'keybindings-no-results' }, 'No keybindings found.'));
  }

  const onInput = debounce(render, 100);
  searchInput.addEventListener('input', onInput);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); e.stopPropagation(); searchInput.value = ''; render(); } });
  root.addEventListener('keydown', e => {
    if ((isApple ? e.metaKey : e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); searchInput.focus(); searchInput.select(); }
  });

  if (typeof input?.query === 'string') searchInput.value = input.query;
  render();
  return {
    root,
    setQuery(q) { if (typeof q === 'string') { searchInput.value = q; render(); } },
    focus() { if (!isTouch()) searchInput.focus({ preventScroll: true }); },
    onShow() { render(); },
    getState() { return { query: searchInput.value }; },
    setState(s) { if (s?.query) { searchInput.value = s.query; render(); } },
    dispose() {}
  };
}
