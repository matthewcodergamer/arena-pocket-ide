// Extension editor ({ type: 'extension', id }): header (icon, name, Built-in, publisher, description,
// Enable/Disable + manage gear) and the DETAILS · FEATURES · CHANGELOG tabs.

import { h, clear, codicon, escapeHtml } from '../../core/dom.js';
import { bus, DisposableStore } from '../../core/events.js';
import { settings } from '../../core/settings.js';
import { commands, fullTitle, keybindingLabel } from '../../core/commands.js';
import { showContextMenu } from '../../platform/contextmenu.js';
import { extensionById } from './catalog.js';
import { extensionState, setExtensionEnabled, manageMenu, extensionSettings, extensionCommands, iconTile, openExtensionSettings } from './shared.js';
import { keycaps } from '../settings/keybindingsEditor.js';
import { settingLabel } from '../settings/model.js';

let markdownPromise = null;
async function renderMarkdown(el, md) {
  markdownPromise ??= import('../../../vendor/markdown.js');
  try {
    const { marked, DOMPurify } = await markdownPromise;
    el.innerHTML = DOMPurify.sanitize(marked.parse(md, { gfm: true }));
    for (const a of el.querySelectorAll('a[href^="http"]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  } catch (err) {
    el.replaceChildren(h('pre', { class: 'xc-markdown-fallback' }, md));
  }
}

export function createExtensionEditor(input, container) {
  const store = new DisposableStore();
  let ext = extensionById(input.id);
  let tab = 'details';
  const root = h('div', { class: 'extension-editor' });
  container.append(root);

  if (!ext) {
    root.append(h('div', { class: 'extension-editor-missing' }, h('h2', {}, 'Extension not found'), h('p', {}, `“${input.id}” is not part of this version of X Coder.`)));
    return { dispose() {} };
  }

  const header = h('div', { class: 'header' });
  const navbar = h('div', { class: 'navbar', role: 'tablist' });
  const content = h('div', { class: 'content', role: 'tabpanel', tabindex: '-1' });
  root.append(header, h('div', { class: 'body' }, navbar, content));

  function renderHeader() {
    clear(header);
    const state = extensionState(ext);
    const actions = h('div', { class: 'actions monaco-toolbar' });
    if (ext.toggle) {
      const btn = h('button', { class: ['monaco-button', 'extension-action', state.enabled ? 'secondary' : 'prominent'], type: 'button' }, state.enabled ? 'Disable' : 'Enable');
      btn.addEventListener('click', () => setExtensionEnabled(ext, !state.enabled));
      actions.append(btn);
    }
    const gear = h('a', { class: 'action-label codicon codicon-gear extension-manage', role: 'button', tabindex: '0', title: 'Manage', 'aria-label': 'Manage' });
    gear.addEventListener('click', () => showContextMenu(manageMenu(ext, { fromEditor: true }), { anchor: gear, align: 'left' }));
    actions.append(gear);
    header.append(
      iconTile(ext, 'large'),
      h('div', { class: 'details' },
        h('div', { class: 'title' },
          h('span', { class: 'name', role: 'heading', 'aria-level': '1' }, ext.name),
          h('span', { class: 'identifier', title: 'Extension Identifier' }, ext.id),
          h('span', { class: 'builtin', title: 'Built into X Coder' }, 'Built-in')),
        h('div', { class: 'subtitle' },
          h('span', { class: 'publisher' }, 'X Coder', codicon('verified-filled', 'verified-publisher')),
          h('span', { class: 'subtitle-sep' }, '|'),
          h('span', { class: 'version' }, `v${document.documentElement.dataset.xcoderVersion || '6.0.0'}`)),
        h('div', { class: 'description' }, ext.description),
        actions,
        h('div', { class: 'status' }, ext.toggle
          ? (state.enabled ? 'This extension is enabled globally.' : 'This extension is disabled globally.')
          : 'This extension is always enabled because it is part of X Coder.')));
  }

  function renderNavbar() {
    clear(navbar);
    for (const [id, label] of [['details', 'Details'], ['features', 'Features'], ['changelog', 'Changelog']]) {
      const item = h('a', { class: ['navbar-item', tab === id && 'active'], role: 'tab', tabindex: '0', 'aria-selected': String(tab === id), 'data-tab': id }, label.toUpperCase());
      item.addEventListener('click', () => { tab = id; renderNavbar(); renderContent(); });
      item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); } });
      navbar.append(item);
    }
  }

  function renderFeatures() {
    const wrap = h('div', { class: 'extension-features' });
    const cmds = extensionCommands(ext);
    const sets = extensionSettings(ext);
    wrap.append(h('h3', {}, `Commands (${cmds.length})`));
    if (cmds.length) {
      const list = h('div', { class: 'feature-list' });
      for (const c of cmds) {
        const kb = c.keybinding ? keybindingLabel(c.keybinding) : '';
        const row = h('div', { class: 'feature-row', role: 'button', tabindex: '0', title: `Run ${fullTitle(c)}` },
          h('div', { class: 'feature-main' }, h('div', { class: 'feature-title' }, fullTitle(c)), h('div', { class: 'feature-id' }, c.id)),
          kb ? h('span', { class: 'monaco-keybinding' }, ...keycaps(kb).map(k => h('span', { class: 'monaco-keybinding-key' }, k))) : null);
        row.addEventListener('click', () => { if (commands.isEnabled(c.id)) commands.execute(c.id).catch(() => {}); });
        row.addEventListener('keydown', e => { if (e.key === 'Enter') row.click(); });
        list.append(row);
      }
      wrap.append(list);
    } else wrap.append(h('p', { class: 'xc-muted' }, 'This extension contributes no commands.'));
    wrap.append(h('h3', {}, `Settings (${sets.length})`));
    if (sets.length) {
      const list = h('div', { class: 'feature-list' });
      for (const s of sets) {
        const { category, title } = settingLabel(s);
        const def = typeof s.default === 'function' ? s.default() : s.default;
        const row = h('div', { class: 'feature-row', role: 'button', tabindex: '0', title: 'Open in Settings' },
          h('div', { class: 'feature-main' },
            h('div', { class: 'feature-title' }, `${category ? category + ': ' : ''}${title}`),
            h('div', { class: 'feature-id' }, s.key),
            s.description ? h('div', { class: 'feature-description' }, s.description) : null),
          h('code', { class: 'feature-default', title: 'Default value' }, JSON.stringify(def)));
        row.addEventListener('click', () => commands.execute('workbench.action.openSettings', `@id:${s.key}`));
        row.addEventListener('keydown', e => { if (e.key === 'Enter') row.click(); });
        list.append(row);
      }
      wrap.append(list);
    } else wrap.append(h('p', { class: 'xc-muted' }, 'This extension contributes no settings.'));
    return wrap;
  }

  function renderContent() {
    clear(content);
    content.scrollTop = 0;
    if (tab === 'features') { content.append(renderFeatures()); return; }
    const md = h('div', { class: 'xc-markdown extension-markdown' });
    content.append(md);
    renderMarkdown(md, tab === 'changelog' ? `# Changelog\n\n${ext.changelog || '## 6.0.0\n- Initial release.'}` : ext.details || `# ${escapeHtml(ext.name)}\n\n${ext.description}`);
  }

  renderHeader(); renderNavbar(); renderContent();
  if (ext.toggle) store.add(settings.onChange(ext.toggle, () => renderHeader()));
  store.add(bus.on('settings:changed', e => { if (tab === 'features' && extensionSettings(ext).some(s => s.key === e.key)) renderContent(); }));

  return {
    setInput(next) { const n = extensionById(next?.id); if (n && n !== ext) { ext = n; tab = 'details'; renderHeader(); renderNavbar(); renderContent(); } },
    focus() { content.focus({ preventScroll: true }); },
    openSettings: () => openExtensionSettings(ext),
    dispose() { store.dispose(); }
  };
}
