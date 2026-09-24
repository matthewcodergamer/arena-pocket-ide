// VS Code Quick Input: quick pick lists, input boxes, and prefix-based quick access
// (Command Palette ">", Go to File "", Go to Line ":", Go to Symbol "@", Help "?").
//
//   const item = await quickInput.pick(items, { placeholder: 'Select a theme', title: 'Color Theme', activeItem })
//     items: [{ label, description?, detail?, icon? (codicon), iconHtml?, keybinding?, buttons?: [{icon, tooltip, run(item)}],
//               kind: 'separator' (label = group name), alwaysShow?, picked?, id?, ...yourData }]
//     items may be a function (value) => items | Promise<items>  (then set filter:false to do your own filtering)
//     options: { title, placeholder, value, matchOnDescription, matchOnDetail, filter (default true),
//                onDidChangeActive(item), canPickMany, keepOpen, busy }
//   const text = await quickInput.input({ title, prompt, placeholder, value, password, validate: v => 'error'|null })
//   quickInput.registerProvider('@', { placeholder, provide(filter) → items|Promise, accept(item, filter) })
//   quickInput.open('>')   // open quick access with the given prefix

import { h, codicon, escapeHtml, fuzzyMatch, highlightMatches, clamp, isPhone } from '../core/dom.js';
import { commands, fullTitle, keybindingLabel } from '../core/commands.js';

const providers = new Map(); // prefix → provider
let active = null;

function widget() {
  let el = document.getElementById('quick-input-widget');
  if (el) return el;
  el = h('div', { id: 'quick-input-widget', class: 'quick-input-widget hidden', role: 'dialog', 'aria-label': 'Quick Input' },
    h('div', { class: 'quick-input-titlebar hidden' }, h('div', { class: 'quick-input-title' })),
    h('div', { class: 'quick-input-header' },
      h('div', { class: 'quick-input-box monaco-inputbox' },
        h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-autocomplete': 'list', role: 'combobox', enterkeyhint: 'go' })),
      h('div', { class: 'quick-input-count hidden' })),
    h('div', { class: 'quick-input-message hidden' }),
    h('div', { class: 'quick-input-progress monaco-progress-container' }, h('div', { class: 'progress-bit' })),
    h('div', { class: 'quick-input-list', role: 'listbox' }));
  document.body.append(el);
  return el;
}
function backdrop() {
  let el = document.getElementById('quick-input-backdrop');
  if (!el) { el = h('div', { id: 'quick-input-backdrop', class: 'quick-input-backdrop hidden' }); document.body.append(el); }
  return el;
}

function hideWidget() {
  widget().classList.add('hidden');
  backdrop().classList.add('hidden');
}

/** Core session: renders items, handles keys, resolves with the accepted item or undefined. */
function session(source, opts = {}) {
  active?.cancel();
  const root = widget();
  const input = root.querySelector('input');
  const list = root.querySelector('.quick-input-list');
  const titlebar = root.querySelector('.quick-input-titlebar');
  const message = root.querySelector('.quick-input-message');
  const progress = root.querySelector('.quick-input-progress');
  const count = root.querySelector('.quick-input-count');

  root.classList.remove('hidden');
  backdrop().classList.toggle('hidden', !isPhone());
  root.classList.toggle('input-only', !!opts.inputOnly);
  titlebar.classList.toggle('hidden', !opts.title);
  titlebar.querySelector('.quick-input-title').textContent = opts.title || '';
  input.type = opts.password ? 'password' : 'text';
  input.placeholder = opts.placeholder || '';
  input.value = opts.value ?? '';
  if (opts.valueSelection) input.setSelectionRange(...opts.valueSelection);
  message.classList.add('hidden');
  count.classList.add('hidden');

  let items = [], visible = [], activeIndex = 0, token = 0, done = false;
  const picked = new Set();

  return new Promise(resolve => {
    const finish = value => {
      if (done) return; done = true;
      cleanup(); hideWidget(); active = null;
      resolve(value);
    };
    const state = { cancel: () => finish(undefined), input, root, setBusy: b => progress.classList.toggle('active', !!b), setMessage };
    active = state;

    function setMessage(text, severity = 'info') {
      message.textContent = text || '';
      message.className = `quick-input-message ${severity}${text ? '' : ' hidden'}`;
    }

    async function refresh() {
      const my = ++token;
      const value = input.value;
      if (opts.inputOnly) {
        list.replaceChildren();
        if (opts.validate) {
          const err = await opts.validate(value);
          if (my !== token) return;
          setMessage(err || opts.prompt || '', err ? 'error' : 'info');
        } else setMessage(opts.prompt || '', 'info');
        return;
      }
      let src = source;
      if (typeof source === 'function') {
        state.setBusy(true);
        try { src = await source(value, state); } catch (err) { src = [{ label: String(err?.message || err), icon: 'error', disabled: true }]; }
        if (my !== token || done) return;
        state.setBusy(opts.busy || false);
      }
      items = src || [];
      const filter = opts.filter !== false && typeof source !== 'function' ? value.trim() : (opts.filterValue?.(value) ?? (opts.filter === false ? '' : value.trim()));
      visible = [];
      let pendingSep = null;
      for (const item of items) {
        if (item.kind === 'separator') { pendingSep = item; continue; }
        let match = null, descMatch = null;
        if (filter && opts.filter !== false) {
          match = fuzzyMatch(filter, item.label);
          if (!match && opts.matchOnDescription && item.description) descMatch = fuzzyMatch(filter, item.description);
          if (!match && !descMatch && opts.matchOnDetail && item.detail) descMatch = fuzzyMatch(filter, item.detail);
          if (!match && !descMatch && !item.alwaysShow) continue;
        }
        visible.push({ item, match, descMatch, sep: filter && opts.sortByScore !== false ? null : pendingSep });
        pendingSep = null;
      }
      if (filter && opts.filter !== false && opts.sortByScore !== false) {
        visible.sort((a, b) => ((b.match?.score ?? b.descMatch?.score ?? -1e9) - (a.match?.score ?? a.descMatch?.score ?? -1e9)));
      }
      const activeItem = opts.activeItem && visible.findIndex(v => v.item === opts.activeItem || (v.item.id && v.item.id === opts.activeItem?.id));
      activeIndex = activeItem >= 0 && !filter ? activeItem : 0;
      render();
      if (!visible.length) setMessage(opts.emptyMessage || (value ? 'No matching results' : ''), 'info');
      else setMessage(opts.message || '', 'info');
    }

    function render() {
      list.replaceChildren();
      const rows = visible.map((v, i) => {
        const { item, match, descMatch } = v;
        const row = h('div', { class: ['quick-input-list-entry', i === activeIndex && 'focused', item.disabled && 'disabled', opts.canPickMany && 'multi', item.class], role: 'option', 'aria-selected': String(i === activeIndex), 'data-index': i });
        if (v.sep) row.classList.add('has-separator');
        if (opts.canPickMany) {
          const cb = h('input', { type: 'checkbox', class: 'quick-input-checkbox', tabindex: '-1' });
          cb.checked = picked.has(item) || (!!item.picked && !picked.size && !cb.dataset.touched);
          if (item.picked && !cb.dataset.init) { picked.add(item); cb.dataset.init = '1'; }
          cb.addEventListener('click', e => { e.stopPropagation(); cb.dataset.touched = '1'; cb.checked ? picked.add(item) : picked.delete(item); });
          row.append(cb);
        }
        const icon = item.iconHtml ? h('span', { class: 'quick-input-icon', html: item.iconHtml }) : item.icon ? h('span', { class: 'quick-input-icon' }, codicon(item.icon)) : null;
        const hl = match?.matches || item.highlights;
        const label = h('span', { class: 'label-name', html: hl ? highlightMatches(item.label, hl) : escapeHtml(item.label) });
        const dHl = descMatch && !match ? descMatch.matches : item.descriptionHighlights;
        const desc = item.description ? h('span', { class: 'label-description', html: dHl?.length ? highlightMatches(item.description, dHl) : escapeHtml(item.description) }) : null;
        const main = h('div', { class: 'quick-input-list-rows' },
          h('div', { class: 'quick-input-list-row' }, icon, h('span', { class: 'monaco-icon-label' }, label, desc)),
          item.detail ? h('div', { class: 'quick-input-list-row detail' }, h('span', { class: 'label-detail' }, item.detail)) : null);
        row.append(main);
        if (v.sep?.label) row.append(h('span', { class: 'quick-input-list-separator' }, v.sep.label));
        if (item.keybinding) row.append(h('span', { class: 'monaco-keybinding' }, ...item.keybinding.split(/(?<=.)(?=[A-Z⌘⇧⌥⌃↑↓←→])|\+/).filter(Boolean).map(k => h('span', { class: 'monaco-keybinding-key' }, k))));
        if (item.buttons?.length) {
          const bar = h('div', { class: 'quick-input-list-entry-action-bar' });
          for (const b of item.buttons) {
            const btn = h('a', { class: 'action-label codicon codicon-' + b.icon, role: 'button', title: b.tooltip || '', 'aria-label': b.tooltip || '' });
            btn.addEventListener('click', async e => {
              e.stopPropagation();
              const r = await b.run?.(item, state);
              if (r === 'close') finish(undefined); else if (r === 'refresh') refresh();
            });
            bar.append(btn);
          }
          row.append(bar);
        }
        row.addEventListener('click', () => { if (item.disabled) return; activeIndex = i; accept(); });
        row.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && activeIndex !== i) { activeIndex = i; updateActive(); } });
        return row;
      });
      list.append(...rows);
      if (opts.canPickMany) { count.textContent = `${picked.size} Selected`; count.classList.remove('hidden'); }
      updateActive(false);
    }

    function updateActive(scroll = true) {
      [...list.children].forEach((row, i) => { row.classList.toggle('focused', i === activeIndex); row.setAttribute('aria-selected', String(i === activeIndex)); });
      const row = list.children[activeIndex];
      if (scroll && row) row.scrollIntoView({ block: 'nearest' });
      opts.onDidChangeActive?.(visible[activeIndex]?.item);
    }

    async function accept() {
      if (opts.inputOnly) {
        const value = input.value;
        if (opts.validate) { const err = await opts.validate(value); if (err) { setMessage(err, 'error'); return; } }
        finish(value); return;
      }
      if (opts.canPickMany) { finish([...picked]); return; }
      const v = visible[activeIndex];
      if (!v) { if (opts.acceptValue) finish({ label: input.value, value: input.value, custom: true }); return; }
      if (v.item.disabled) return;
      if (opts.keepOpen) { await opts.onAccept?.(v.item, state); refresh(); return; }
      finish(v.item);
    }

    const onInput = () => { opts.onDidChangeValue?.(input.value, state); if (!done) refresh(); };
    const onKey = e => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); if (visible.length) { activeIndex = (activeIndex + 1) % visible.length; updateActive(); } }
      else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); if (visible.length) { activeIndex = (activeIndex - 1 + visible.length) % visible.length; updateActive(); } }
      else if (e.key === 'PageDown') { e.preventDefault(); activeIndex = clamp(activeIndex + 10, 0, visible.length - 1); updateActive(); }
      else if (e.key === 'PageUp') { e.preventDefault(); activeIndex = clamp(activeIndex - 10, 0, visible.length - 1); updateActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); accept(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(undefined); }
      else if (e.key === ' ' && opts.canPickMany && e.altKey) { e.preventDefault(); const it = visible[activeIndex]?.item; if (it) { picked.has(it) ? picked.delete(it) : picked.add(it); render(); } }
    };
    const onOutside = e => { if (!root.contains(e.target)) finish(undefined); };
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKey);
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);

    function cleanup() {
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside, true);
      progress.classList.remove('active');
    }

    refresh();
    requestAnimationFrame(() => { input.focus({ preventScroll: true }); if (!opts.valueSelection && opts.selectValue !== false) input.select(); });
  });
}

export const quickInput = {
  pick(items, opts = {}) { return session(items, opts); },
  input(opts = {}) { return session(null, { ...opts, inputOnly: true }); },
  close() { active?.cancel(); },
  isOpen() { return !!active; },
  registerProvider(prefix, provider) { providers.set(prefix, provider); return () => providers.delete(prefix); },
  providers() { return [...providers.entries()]; },

  /** Opens quick access; the typed prefix selects the provider (like VS Code's Ctrl+P box). */
  async open(value = '') {
    const pickProvider = v => {
      const sorted = [...providers.keys()].sort((a, b) => b.length - a.length);
      for (const p of sorted) if (p && v.startsWith(p)) return [p, providers.get(p)];
      return ['', providers.get('')];
    };
    let [prefix, provider] = pickProvider(value);
    let typed = value;
    const result = await session(async (v, state) => {
      typed = v;
      const [p, prov] = pickProvider(v);
      prefix = p; provider = prov;
      if (!prov) return [{ label: 'No provider for this prefix', disabled: true }];
      state.input.placeholder = prov.placeholder || '';
      const filter = v.slice(p.length);
      const items = await prov.provide(filter.trimStart(), state);
      if (prov.filter === false) return items;
      return filterItems(items, filter.trim(), prov);
    }, {
      value, filter: false, selectValue: false, placeholder: provider?.placeholder,
      onDidChangeActive: item => provider?.onDidChangeActive?.(item)
    });
    if (result && provider?.accept) await provider.accept(result, typed);
    else if (!result) provider?.onCancel?.();
    return result;
  }
};

/** Applies fuzzy filtering to provider items (keeps separators only when unfiltered). */
function filterItems(items, filter, prov = {}) {
  if (!filter) return items;
  const scored = [];
  for (const item of items) {
    if (item.kind === 'separator') continue;
    const m = fuzzyMatch(filter, item.label) || (prov.matchOnDescription && item.description ? fuzzyMatch(filter, item.description) : null);
    if (m || item.alwaysShow) scored.push({ item, score: m?.score ?? -1e6, m });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => ({ ...s.item, highlights: s.m?.matches }));
}

// ---- Built-in providers: Command Palette (">") and Help ("?") ----
quickInput.registerProvider('>', {
  placeholder: 'Type the name of a command to run.',
  filter: false,
  provide(filter) {
    const list = commands.paletteCommands();
    const recent = new Set(commands.recentIds().slice(0, 8));
    const items = list.map(c => ({
      id: c.id, label: fullTitle(c), keybinding: c.keybinding ? keybindingLabel(c.keybinding) : '',
      description: '', command: c.id, recent: recent.has(c.id)
    }));
    const f = filter.trim();
    if (!f) {
      const rec = items.filter(i => i.recent), rest = items.filter(i => !i.recent);
      return [...(rec.length ? [{ kind: 'separator', label: 'recently used' }, ...rec, { kind: 'separator', label: 'other commands' }] : []), ...rest];
    }
    return filterItems(items, f).map(i => ({ ...i, label: i.label }));
  },
  accept(item) { if (item?.command) setTimeout(() => commands.execute(item.command).catch(() => {}), 0); }
});

quickInput.registerProvider('?', {
  placeholder: 'Type a prefix to see its help',
  filter: false,
  provide() {
    return [...providers.entries()].filter(([p]) => p !== '?').map(([p, prov]) => ({
      label: p || '…', description: prov.helpText || prov.placeholder || '', prefix: p
    }));
  },
  accept(item) { setTimeout(() => quickInput.open(item.prefix), 0); }
});
