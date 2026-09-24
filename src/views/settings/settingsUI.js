// Settings editor (VS Code "Settings UI"): search box with result count and filters, the "User"
// tab, a table of contents (hidden on narrow editors, replaced by category chips), and one row per
// setting with a type-specific control, modified indicator and a gear menu.

import { h, clear, codicon, debounce, copyText, onContextMenu, isTouch, isApple, escapeHtml } from '../../core/dom.js';
import { bus, DisposableStore } from '../../core/events.js';
import { settings } from '../../core/settings.js';
import { commands } from '../../core/commands.js';
import { showContextMenu } from '../../platform/contextmenu.js';
import { notify } from '../../platform/notifications.js';
import { buildTree, settingLabel, parseQuery, isSearching, search, defaultOf, sectionOf, COMMONLY_USED } from './model.js';

function action(icon, title, run) {
  const b = h('a', { class: `action-label codicon codicon-${icon}`, role: 'button', tabindex: '0', title, 'aria-label': title });
  b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); run(e, b); });
  b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(e, b); } });
  return b;
}

/** Renders a setting description: `code` spans and `#setting.id#` links (VS Code markdownDescription subset). */
function descriptionHtml(text = '') {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/#([\w.-]+\.[\w.-]+)#/g, (_, key) => `<a class="setting-link" href="#" data-setting="${key}">${escapeHtml(settingLabel(settings.schema(key) || { key }).title)}</a>`)
    .replace(/\n/g, '<br>');
}

function valueToString(v) { return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }

export function createSettingsEditor(input, container) {
  const store = new DisposableStore();
  let tree = [];
  let order = [];              // every schema once, in TOC order (for search results)
  let tocFilter = null;        // TOC node id restricting search results
  let collapsedToc = new Set();
  let selectedToc = null;
  const rows = new Map();      // key → Set<rowHandle>
  const headers = [];          // [{ node, el }] for scroll spy

  // ---------- header ----------
  const searchInput = h('input', {
    class: 'input', type: 'text', placeholder: 'Search settings', 'aria-label': 'Search settings',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search'
  });
  const count = h('div', { class: 'settings-count-widget hidden', 'aria-live': 'polite' });
  const clearBtn = action('clear-all', 'Clear Settings Search Input', () => { setQuery(''); searchInput.focus(); });
  const filterBtn = action('filter', 'Filter Settings', (_, el) => showFilterMenu(el));
  const searchBox = h('div', { class: 'settings-search-container monaco-inputbox' },
    h('span', { class: 'settings-search-icon' }, codicon('search')), searchInput, count,
    h('div', { class: 'controls monaco-toolbar' }, clearBtn, filterBtn));
  const userTab = h('div', { class: 'settings-tab active', role: 'tab', 'aria-selected': 'true', tabindex: '0', title: 'Settings stored in this browser on this device' }, 'User');
  const tabs = h('div', { class: 'settings-tabs-widget', role: 'tablist' }, userTab);
  const chips = h('div', { class: 'settings-toc-chips', role: 'tablist', 'aria-label': 'Settings categories' });
  const header = h('div', { class: 'settings-header' }, searchBox, h('div', { class: 'settings-header-controls' }, tabs), chips);
  const toc = h('div', { class: 'settings-toc-container', role: 'tree', 'aria-label': 'Settings Table of Contents' });
  const list = h('div', { class: 'settings-tree-container', role: 'list', 'aria-label': 'Settings' });
  const body = h('div', { class: 'settings-body' }, toc, list);
  const root = h('div', { class: 'settings-editor' }, header, body);
  container.append(root);

  // ---------- rows ----------
  function registerRow(key, handle) {
    if (!rows.has(key)) rows.set(key, new Set());
    rows.get(key).add(handle);
  }

  function renderRow(s) {
    const { category, title } = settingLabel(s);
    const type = Array.isArray(s.enum) ? 'enum' : (s.type || 'string');
    const row = h('div', { class: ['setting-item', `setting-item-${type}`], role: 'listitem', tabindex: '-1', 'data-key': s.key, 'aria-label': `${category ? category + ': ' : ''}${title}` });
    const indicator = h('div', { class: 'setting-item-modified-indicator', title: 'The setting has been configured in the current scope.' });
    const more = action('gear', 'More Actions...', (_, el) => { const r = el.getBoundingClientRect(); showContextMenu(rowMenu(s), { x: r.left, y: r.bottom + 2 }); });
    const titleEl = h('div', { class: 'setting-item-title' },
      category ? h('span', { class: 'setting-item-category' }, `${category}: `) : null,
      h('span', { class: 'setting-item-label' }, title));
    row.append(indicator, h('div', { class: 'setting-toolbar-container monaco-toolbar' }, more), titleEl);
    const validation = h('div', { class: 'setting-item-validation-message hidden', role: 'alert' });
    let control = null, update = () => {};

    if (type === 'boolean') {
      control = h('input', { type: 'checkbox', class: 'xc-checkbox', id: `setting-${s.key}`, 'aria-label': title });
      control.addEventListener('change', () => settings.set(s.key, control.checked));
      row.append(h('label', { class: 'setting-item-value-description setting-item-bool', for: `setting-${s.key}` }, control,
        h('span', { class: 'setting-item-description', html: descriptionHtml(s.description) })));
      update = () => { control.checked = !!settings.get(s.key); };
    } else {
      if (s.description) row.append(h('div', { class: 'setting-item-description', html: descriptionHtml(s.description) }));
      const controlHost = h('div', { class: 'setting-item-control' });
      row.append(controlHost);
      if (type === 'enum') {
        control = h('select', { class: 'xc-select', 'aria-label': title });
        s.enum.forEach((v, i) => control.append(h('option', { value: String(i) }, s.enumLabels?.[i] ?? valueToString(v))));
        const enumDesc = h('div', { class: 'setting-item-enum-description' });
        control.addEventListener('change', () => settings.set(s.key, s.enum[Number(control.value)]));
        controlHost.append(control);
        if (s.enumDescriptions?.length) row.append(enumDesc);
        update = () => {
          const i = s.enum.findIndex(v => JSON.stringify(v) === JSON.stringify(settings.get(s.key)));
          control.value = String(i >= 0 ? i : Math.max(0, s.enum.findIndex(v => v === defaultOf(s))));
          enumDesc.textContent = s.enumDescriptions?.[i] || '';
        };
      } else if (type === 'number') {
        control = h('input', { class: 'xc-input', type: 'number', inputmode: s.integer ? 'numeric' : 'decimal', 'aria-label': title, autocomplete: 'off' });
        if (s.min != null) control.min = String(s.min);
        if (s.max != null) control.max = String(s.max);
        control.step = s.step != null ? String(s.step) : s.integer ? '1' : 'any';
        const validate = raw => {
          if (raw.trim() === '') return 'Value must be a number.';
          const n = Number(raw);
          if (!Number.isFinite(n)) return 'Value must be a number.';
          if (s.integer && !Number.isInteger(n)) return 'Value must be an integer.';
          if (s.min != null && n < s.min) return `Value must be greater than or equal to ${s.min}.`;
          if (s.max != null && n > s.max) return `Value must be less than or equal to ${s.max}.`;
          return null;
        };
        const commit = debounce(() => {
          const err = validate(control.value);
          showValidation(err);
          if (!err) settings.set(s.key, Number(control.value));
        }, 350);
        control.addEventListener('input', commit);
        control.addEventListener('change', () => { commit(); });
        control.addEventListener('blur', () => { if (validate(control.value)) { showValidation(null); update(true); } });
        controlHost.append(control);
        update = force => { if (force || document.activeElement !== control) control.value = valueToString(settings.get(s.key)); };
      } else if (type === 'string' || type === 'text') {
        const multiline = type === 'text' || s.multiline;
        control = multiline
          ? h('textarea', { class: 'xc-textarea', rows: '4', 'aria-label': title, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' })
          : h('input', { class: 'xc-input', type: 'text', 'aria-label': title, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', placeholder: s.placeholder || '' });
        const commit = debounce(() => settings.set(s.key, control.value), 400);
        control.addEventListener('input', commit);
        control.addEventListener('change', () => settings.set(s.key, control.value));
        controlHost.append(control);
        update = force => { if (force || document.activeElement !== control) control.value = valueToString(settings.get(s.key)); };
      } else {
        // object / array: edited as JSON, exactly like VS Code's "Edit in settings.json".
        const link = h('a', { class: 'edit-in-settings-button', href: '#', role: 'button' }, 'Edit in settings.json');
        link.addEventListener('click', e => { e.preventDefault(); commands.execute('workbench.action.openSettingsJson', { revealSetting: s.key }); });
        controlHost.append(link);
      }
      row.append(validation);
    }

    function showValidation(message) {
      validation.textContent = message || '';
      validation.classList.toggle('hidden', !message);
      control?.classList.toggle('error', !!message);
    }

    const handle = {
      key: s.key, el: row,
      update(force) {
        const modified = settings.isModified(s.key);
        row.classList.toggle('is-configured', modified);
        row.setAttribute('aria-label', `${category ? category + ': ' : ''}${title}${modified ? ' (modified)' : ''}`);
        try { update(force); } catch (err) { console.error(err); }
      }
    };
    handle.update(true);
    registerRow(s.key, handle);

    row.addEventListener('focusin', () => { list.querySelectorAll('.setting-item.focused').forEach(r => r !== row && r.classList.remove('focused')); row.classList.add('focused'); });
    row.addEventListener('focusout', e => { if (!row.contains(e.relatedTarget)) row.classList.remove('focused'); });
    row.addEventListener('click', e => {
      const link = e.target.closest('a.setting-link');
      if (link) { e.preventDefault(); setQuery(`@id:${link.dataset.setting}`); }
    });
    onContextMenu(row, (x, y, ev) => {
      if (ev?.target?.closest?.('input, textarea, select')) return;
      showContextMenu(rowMenu(s), { x, y });
    });
    return row;
  }

  function rowMenu(s) {
    return [
      { label: 'Reset Setting', disabled: !settings.isModified(s.key), run: () => settings.reset(s.key) },
      { separator: true },
      { label: 'Copy Setting ID', run: () => copy(s.key, 'setting ID') },
      { label: 'Copy Setting as JSON', run: () => copy(`"${s.key}": ${JSON.stringify(settings.get(s.key), null, 2)}`, 'setting') }
    ];
  }
  async function copy(text, what) {
    if (await copyText(text)) notify.info(`Copied ${what} to the clipboard.`, { source: 'Settings' });
    else notify.warn('Could not access the clipboard.', { source: 'Settings' });
  }

  function groupTitle(node) {
    const el = h('div', { class: `settings-group-title settings-group-level-${node.level}`, role: 'heading', 'aria-level': String(node.level + 1), 'data-toc': node.id },
      h('div', { class: 'settings-group-title-label' }, node.label));
    headers.push({ node, el });
    return el;
  }

  // ---------- TOC + chips ----------
  function tocRow(node, countFor) {
    const n = countFor ? countFor(node) : null;
    const hasChildren = node.level === 1 && node.children?.length;
    const collapsed = collapsedToc.has(node.id);
    const row = h('div', {
      class: ['monaco-list-row', 'settings-toc-entry', `level-${node.level}`, selectedToc === node.id && 'selected', tocFilter === node.id && 'filtered'],
      role: 'treeitem', tabindex: '0', 'data-toc': node.id, 'aria-expanded': hasChildren ? String(!collapsed) : null
    },
      h('span', { class: ['monaco-tl-twistie', hasChildren && 'collapsible', hasChildren && !collapsed && 'expanded'] }),
      h('span', { class: 'settings-toc-label' }, node.label),
      n != null ? h('span', { class: 'settings-toc-count' }, `(${n})`) : null);
    row.addEventListener('click', e => {
      if (hasChildren && e.target.closest('.monaco-tl-twistie')) { collapsed ? collapsedToc.delete(node.id) : collapsedToc.add(node.id); renderToc(); return; }
      revealNode(node);
    });
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealNode(node); } });
    return row;
  }

  let lastCounts = null;
  function renderToc(countFor = lastCounts) {
    lastCounts = countFor;
    clear(toc);
    for (const top of tree) {
      if (countFor && !countFor(top)) continue;
      toc.append(tocRow(top, countFor));
      if (collapsedToc.has(top.id)) continue;
      for (const c of top.children) {
        if (countFor && !countFor(c)) continue;
        toc.append(tocRow(c, countFor));
      }
    }
    clear(chips);
    for (const top of tree) {
      const n = countFor ? countFor(top) : null;
      if (countFor && !n) continue;
      const active = countFor ? tocFilter === top.id : selectedToc === top.id || selectedToc?.startsWith(`${top.id}/`);
      const chip = h('button', { class: ['settings-toc-chip', active && 'active'], role: 'tab', 'aria-selected': String(!!active), 'data-toc': top.id, type: 'button' },
        top.label, n != null ? h('span', { class: 'settings-toc-count' }, String(n)) : null);
      chip.addEventListener('click', () => revealNode(top));
      chips.append(chip);
    }
    chips.querySelector('.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function revealNode(node) {
    if (isSearching(parseQuery(searchInput.value))) {
      tocFilter = tocFilter === node.id ? null : node.id;
      render();
      return;
    }
    const target = headers.find(x => x.node.id === node.id)?.el;
    if (target) list.scrollTop = Math.max(0, target.offsetTop - 2); // list is position:relative → offsetTop is relative to it
    selectToc(node.id);
  }

  function selectToc(id) {
    if (selectedToc === id) return;
    selectedToc = id;
    for (const r of toc.querySelectorAll('.settings-toc-entry')) r.classList.toggle('selected', r.dataset.toc === id);
    for (const c of chips.querySelectorAll('.settings-toc-chip')) {
      const on = id === c.dataset.toc || id?.startsWith(`${c.dataset.toc}/`);
      c.classList.toggle('active', !!on);
      c.setAttribute('aria-selected', String(!!on));
      if (on) c.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }

  let spyFrame = 0;
  list.addEventListener('scroll', () => {
    if (spyFrame || isSearching(parseQuery(searchInput.value))) return;
    spyFrame = requestAnimationFrame(() => {
      spyFrame = 0;
      const top = list.scrollTop + 8;
      let current = headers[0]?.node.id || null;
      for (const hd of headers) { if (hd.el.offsetTop <= top) current = hd.node.id; else break; }
      selectToc(current);
    });
  }, { passive: true });

  // ---------- render ----------
  function rebuildModel() {
    const schemas = settings.all();
    tree = buildTree(schemas);
    order = [];
    const seen = new Set();
    for (const top of tree) {
      if (top.label === COMMONLY_USED) continue;
      for (const s of [...top.settings, ...top.children.flatMap(c => c.settings)]) if (!seen.has(s.key)) { seen.add(s.key); order.push(s); }
    }
    return schemas.length;
  }
  let schemaCount = rebuildModel();

  function matchesNode(s, nodeId) {
    const { top, sub } = sectionOf(s);
    if (nodeId === `toc:${COMMONLY_USED}`) return !!s.common;
    return nodeId === `toc:${top}` || nodeId === `toc:${top}/${sub}`;
  }

  function render() {
    const q = parseQuery(searchInput.value);
    const searching = isSearching(q);
    const scroll = list.scrollTop;
    clear(list); rows.clear(); headers.length = 0;
    root.classList.toggle('searching', searching);
    clearBtn.classList.toggle('disabled', !searchInput.value);
    if (searching) {
      const results = search(order, q);
      const countFor = node => results.filter(s => matchesNode(s, node.id)).length;
      if (tocFilter && !tree.some(t => (t.id === tocFilter && countFor(t)) || t.children.some(c => c.id === tocFilter && countFor(c)))) tocFilter = null;
      const shown = tocFilter ? results.filter(s => matchesNode(s, tocFilter)) : results;
      renderToc(countFor);
      count.textContent = shown.length ? `${shown.length} Setting${shown.length === 1 ? '' : 's'} Found` : 'No Settings Found';
      count.classList.remove('hidden');
      for (const s of shown) list.append(renderRow(s));
      if (!shown.length) {
        const clearLink = h('a', { href: '#', class: 'settings-clear-link' }, 'Clear Search');
        clearLink.addEventListener('click', e => { e.preventDefault(); setQuery(''); });
        list.append(h('div', { class: 'settings-no-results' }, q.modified && !q.words.length ? 'No modified settings. ' : 'No Settings Found. ', clearLink));
      }
      list.scrollTop = 0;
    } else {
      tocFilter = null;
      count.classList.add('hidden');
      for (const top of tree) {
        list.append(groupTitle(top));
        for (const s of top.settings) list.append(renderRow(s));
        for (const c of top.children) {
          list.append(groupTitle(c));
          for (const s of c.settings) list.append(renderRow(s));
        }
      }
      if (!tree.length) list.append(h('div', { class: 'settings-no-results' }, 'No settings are registered.'));
      renderToc(null);
      list.scrollTop = scroll;
      if (!selectedToc) selectToc(tree[0]?.id || null);
    }
  }

  function setQuery(value) {
    searchInput.value = value;
    tocFilter = null;
    render();
  }

  const onSearch = debounce(() => { tocFilter = null; render(); }, 120);
  searchInput.addEventListener('input', onSearch);
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
    else if (e.key === 'Enter') { e.preventDefault(); searchInput.blur?.(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('input, select, textarea, a')?.focus(); }
  });
  root.addEventListener('keydown', e => {
    if ((isApple ? e.metaKey : e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); searchInput.focus(); searchInput.select(); }
  });

  function showFilterMenu(anchor) {
    const q = searchInput.value;
    const toggle = token => {
      const has = q.split(/\s+/).includes(token);
      setQuery(has ? q.split(/\s+/).filter(t => t !== token).join(' ') : `${token} ${q}`.trim());
    };
    showContextMenu([
      { label: 'Modified', checked: q.split(/\s+/).includes('@modified'), run: () => toggle('@modified') },
      { label: 'Setting ID…', checked: /(^|\s)@id:/.test(q), run: () => { if (!/(^|\s)@id:/.test(q)) searchInput.value = `@id:${q ? ' ' + q : ''}`; searchInput.focus(); searchInput.setSelectionRange(4, 4); } }
    ], { anchor, align: 'right' });
  }

  // ---------- live updates ----------
  store.add(bus.on('settings:changed', e => {
    for (const r of rows.get(e.key) || []) r.update();
    if (parseQuery(searchInput.value).modified) renderSoon();
  }));
  const renderSoon = debounce(() => render(), 150);

  // Responsive: VS Code hides the TOC when the editor is narrow.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    const w = entries[0]?.contentRect.width || root.clientWidth;
    root.classList.toggle('narrow', w < 640);
  }) : null;
  ro?.observe(root);
  root.classList.toggle('narrow', (container.clientWidth || innerWidth) < 640);

  searchInput.value = typeof input?.query === 'string' ? input.query : '';
  render();

  return {
    root,
    setQuery(q) { if (typeof q === 'string' && q !== searchInput.value) setQuery(q); },
    focus() { if (!isTouch()) { searchInput.focus({ preventScroll: true }); } },
    focusSearch() { searchInput.focus({ preventScroll: true }); searchInput.select(); },
    onShow() {
      if (settings.all().length !== schemaCount) { schemaCount = rebuildModel(); render(); }
      else for (const set of rows.values()) for (const r of set) r.update();
    },
    getState() { return { query: searchInput.value, scroll: list.scrollTop }; },
    setState(state) { if (state?.query != null) { searchInput.value = state.query; render(); } if (state?.scroll) list.scrollTop = state.scroll; },
    dispose() { store.dispose(); ro?.disconnect(); cancelAnimationFrame(spyFrame); }
  };
}
