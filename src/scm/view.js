// SOURCE CONTROL views (VS Code workbench.view.scm):
//   ScmView      — commit message box, "Commit & Push" action button with dropdown, Staged Changes /
//                  Changes groups with M/U/A/D decorations and row actions, welcome content when no
//                  GitHub repository is connected.
//   CommitsView  — recent commits of origin/<branch> plus unpushed local commits.

import { h, codicon, clear, onContextMenu, isApple, relativeTime, copyText } from '../core/dom.js';
import { commands } from '../core/commands.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { DisposableStore, bus } from '../core/events.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { fileIconHtml } from '../workbench/icons.js';
import { scm, scmEvents, gh } from './service.js';
import { auth } from './auth.js';

const STATUS_TEXT = { M: 'Modified', U: 'Untracked', A: 'Index Added', D: 'Deleted' };
const STATUS_CLASS = { M: 'modified', U: 'untracked', A: 'added', D: 'deleted' };
const MAX_ROWS = 1000;

function actionIcon(icon, title, run) {
  const b = h('a', { class: `action-label codicon codicon-${icon}`, role: 'button', tabindex: '-1', title, 'aria-label': title });
  b.addEventListener('click', e => { e.stopPropagation(); run(e); });
  return b;
}
const exec = (id, ...args) => commands.execute(id, ...args).catch(() => {});

export function postCommitLabel(mode = settings.get('git.postCommitCommand', 'push')) {
  return mode === 'sync' ? 'Commit & Sync' : mode === 'none' ? 'Commit' : 'Commit & Push';
}

/** "2↓ 1↑" with only the non-zero parts (action button). */
export function syncCounts(repo) {
  const parts = [];
  if (repo?.behind) parts.push(`${repo.behind}↓`);
  if (repo?.ahead) parts.push(`${repo.ahead}↑`);
  return parts.join(' ');
}
/** "0↓ 1↑" like VS Code's status bar sync item ('' when both are zero). */
export function statusCounts(repo) {
  const behind = repo?.behind || 0, ahead = repo?.ahead || 0;
  return behind || ahead ? `${behind}↓ ${ahead}↑` : '';
}

export class ScmView {
  constructor(body) {
    this.store = new DisposableStore();
    this.collapsed = new Set();
    this.focusIndex = -1;
    this.rows = [];
    this.el = h('div', { class: 'scm-view' });
    this.progress = h('div', { class: 'monaco-progress-container' }, h('div', { class: 'progress-bit' }));
    this.banner = h('div', { class: 'scm-banner hidden' });
    this.welcome = h('div', { class: 'scm-welcome view-message hidden' });
    this.input = h('textarea', {
      class: 'scm-input', rows: '1', 'aria-label': 'Source Control Input', autocapitalize: 'sentences', spellcheck: 'true', enterkeyhint: 'enter'
    });
    this.inputBox = h('div', { class: 'scm-editor monaco-inputbox' }, this.input);
    this.primary = h('button', { class: 'monaco-button scm-primary', type: 'button' });
    this.dropdown = h('button', { class: 'monaco-button dropdown scm-dropdown', type: 'button', title: 'More Actions…', 'aria-label': 'More Actions…' }, codicon('chevron-down'));
    this.buttonRow = h('div', { class: 'scm-action-button monaco-button-dropdown' }, this.primary, this.dropdown);
    this.header = h('div', { class: 'scm-editor-container' }, this.inputBox, this.buttonRow);
    this.list = h('div', { class: 'scm-list monaco-list', role: 'tree', tabindex: '0', 'aria-label': 'Source Control' });
    this.el.append(this.progress, this.banner, this.welcome, this.header, this.list);
    body.append(this.el);

    this.input.addEventListener('input', () => { this.autoGrow(); this.saveDraftSoon(); });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (isApple ? e.metaKey : e.ctrlKey) && !e.isComposing) { e.preventDefault(); this.commit(); }
    });
    this.primary.addEventListener('click', () => this.onPrimary());
    this.dropdown.addEventListener('click', e => { e.stopPropagation(); this.showDropdown(); });
    this.list.addEventListener('keydown', e => this.onKey(e));

    this.store.add(scmEvents.on('changed', () => this.renderSoon()));
    this.store.add(scmEvents.on('busy', b => this.setBusy(b)));
    this.store.add(auth.onChange(() => this.renderSoon()));
    this.store.add(settings.onChange('git.postCommitCommand', () => this.renderSoon()));
    this.store.add(bus.on('theme:changed', () => this.renderSoon()));
    this.store.add(bus.on('project:opened', () => this.loadDraft()));
    this.loadDraft();
    this.setBusy(scm.busy);
    this.render();
  }

  dispose() { this.store.dispose(); clearTimeout(this.draftTimer); this.el.remove(); }
  focus() { if (scm.repo?.connected) this.input.focus({ preventScroll: true }); else this.welcome.querySelector('button')?.focus(); }
  onShow() { this.render(); }

  // ---------------- commit message
  async loadDraft() {
    const pid = workspace.id;
    const text = await workspace.sessionGet('scm.message', '').catch(() => '');
    if (pid !== workspace.id) return;
    this.input.value = text || '';
    this.autoGrow();
  }
  saveDraftSoon() { clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => this.saveDraft(), 400); }
  saveDraft() { workspace.sessionSet('scm.message', this.input.value).catch(() => {}); }
  autoGrow() {
    this.input.style.height = 'auto';
    const max = 134;
    this.input.style.height = `${Math.min(max, Math.max(this.input.scrollHeight, 0))}px`;
    this.input.style.overflowY = this.input.scrollHeight > max ? 'auto' : 'hidden';
  }
  message() { return this.input.value; }

  setMessage(text) { this.input.value = text || ''; this.autoGrow(); this.saveDraft(); }
  commit(post) { return exec('git.commit', { post }); }

  onPrimary() {
    const repo = scm.repo;
    if (!repo?.connected || scm.busy) return;
    if (!repo.changes.length && (repo.ahead || repo.behind)) { exec('git.sync'); return; }
    this.commit();
  }

  showDropdown() {
    const repo = scm.repo;
    const has = !!repo?.changes.length;
    showContextMenu([
      { label: 'Commit', icon: 'check', disabled: !has, run: () => this.commit('none') },
      { label: 'Commit & Push', icon: 'repo-push', disabled: !has, run: () => this.commit('push') },
      { label: 'Commit & Sync', icon: 'sync', disabled: !has, run: () => this.commit('sync') },
      { separator: true },
      { label: 'Push', disabled: !repo?.ahead, run: () => exec('git.push') },
      { label: 'Pull', run: () => exec('git.pull') },
      { label: 'Sync', run: () => exec('git.sync') },
      ...(repo?.ahead ? [{ separator: true }, { label: 'Undo Last Commit', run: () => exec('git.undoCommit') }] : [])
    ], { anchor: this.dropdown, align: 'right' });
  }

  setBusy(b) {
    this.progress.classList.toggle('active', !!b);
    this.progress.classList.toggle('infinite', !!b);
    this.progress.title = b ? b.label : '';
    this.renderButton();
  }

  // ---------------- rendering
  renderSoon() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }

  render() {
    const repo = scm.repo;
    const connected = !!repo?.connected;
    this.welcome.classList.toggle('hidden', connected);
    this.header.classList.toggle('hidden', !connected);
    this.list.classList.toggle('hidden', !connected);
    if (!connected) { this.renderWelcome(); this.renderBanner(null); return; }
    const kb = isApple ? '⌘Enter' : 'Ctrl+Enter';
    this.input.placeholder = `Message (${kb} to commit on '${repo.branch}')`;
    this.renderBanner(repo);
    this.renderButton();
    this.renderList(repo);
  }

  renderBanner(repo) {
    clear(this.banner);
    const legacy = repo?.connected && repo.isLegacy;
    this.banner.classList.toggle('hidden', !legacy);
    if (!legacy) return;
    const link = h('a', { class: 'scm-banner-link', role: 'button', tabindex: '0' }, 'Pull');
    link.addEventListener('click', () => exec('git.pull'));
    this.banner.append(codicon('info'), h('span', {}, 'Opened from X Coder 5: base content unavailable — pull to refresh diffs. '), link);
  }

  renderButton() {
    const repo = scm.repo;
    if (!repo?.connected) return;
    const has = repo.changes.length > 0;
    const syncable = !has && (repo.ahead || repo.behind);
    clear(this.primary);
    if (syncable) {
      this.primary.append(codicon('sync'), h('span', {}, `Sync Changes ${syncCounts(repo)}`));
      this.primary.title = 'Synchronize Changes';
    } else {
      const label = postCommitLabel();
      this.primary.append(codicon('check'), h('span', {}, label));
      this.primary.title = `${label} (${isApple ? '⌘Enter' : 'Ctrl+Enter'})`;
    }
    const disabled = !!scm.busy || (!has && !syncable);
    this.primary.disabled = disabled;
    this.primary.classList.toggle('disabled', disabled);
    this.dropdown.disabled = !!scm.busy;
    this.dropdown.classList.toggle('disabled', !!scm.busy);
  }

  renderWelcome() {
    clear(this.welcome);
    const btn = (label, id) => { const b = h('button', { class: 'monaco-button', type: 'button' }, label); b.addEventListener('click', () => exec(id)); return b; };
    const signIn = h('a', { class: 'scm-link', role: 'button', tabindex: '0' }, 'Sign in with GitHub');
    signIn.addEventListener('click', () => exec('github.signIn'));
    this.welcome.append(
      h('p', {}, "The folder currently open doesn't have a GitHub repository connected. You can publish it to a new GitHub repository, clone a repository, or connect an existing one."),
      btn('Publish to GitHub', 'git.publish'),
      btn('Clone Repository', 'git.clone'),
      btn('Connect Existing Repository...', 'git.addRemote'),
      auth.isSignedIn()
        ? h('p', { class: 'scm-welcome-note' }, codicon('github'), ` Signed in to GitHub as ${auth.user?.login || 'your account'}.`)
        : h('p', { class: 'scm-welcome-note' }, 'Publishing, pushing and private repositories require signing in to GitHub: ', signIn, ' (or use the Accounts menu). Public repositories can be cloned without signing in.'),
      h('p', { class: 'scm-welcome-note' }, 'X Coder talks to GitHub directly through the GitHub API — no git installation is needed. ', (() => { const a = h('a', { class: 'scm-link', role: 'button', tabindex: '0' }, 'Show Git Output'); a.addEventListener('click', () => exec('git.showOutput')); return a; })())
    );
  }

  renderList(repo) {
    const staged = [], changes = [];
    for (const c of repo.changes) (repo.staged.has(c.path) ? staged : changes).push(c);
    const focusedPath = this.rows[this.focusIndex]?.path;
    const focusedGroup = this.rows[this.focusIndex]?.group;
    clear(this.list);
    this.rows = [];
    // like VS Code, empty groups are hidden (a clean working tree shows only the message box and button)
    if (staged.length) this.renderGroup('staged', 'Staged Changes', staged, repo);
    if (changes.length) this.renderGroup('changes', 'Changes', changes, repo);
    const idx = this.rows.findIndex(r => (focusedPath ? r.path === focusedPath : r.group === focusedGroup && !r.path));
    this.focusIndex = idx;
    this.updateFocus(false);
  }

  renderGroup(id, label, list, repo) {
    const collapsed = this.collapsed.has(id);
    const acts = h('div', { class: 'scm-actions monaco-toolbar' });
    if (id === 'staged') acts.append(actionIcon('remove', 'Unstage All Changes', () => exec('git.unstageAll')));
    else if (list.length) {
      acts.append(actionIcon('discard', 'Discard All Changes', () => exec('git.cleanAll')));
      acts.append(actionIcon('add', 'Stage All Changes', () => exec('git.stageAll')));
    }
    const row = h('div', { class: 'monaco-list-row scm-group', role: 'treeitem', 'aria-expanded': String(!collapsed), 'data-group': id, 'aria-label': `${label}, ${list.length}` },
      codicon(collapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
      h('span', { class: 'scm-group-label' }, label),
      acts,
      h('span', { class: 'monaco-count-badge' }, String(list.length)));
    row.addEventListener('click', () => { if (collapsed) this.collapsed.delete(id); else this.collapsed.add(id); this.focusIndex = this.rows.findIndex(r => r.el === row); this.render(); });
    onContextMenu(row, (x, y) => showContextMenu(id === 'staged'
      ? [{ label: 'Unstage All Changes', run: () => exec('git.unstageAll') }]
      : [{ label: 'Stage All Changes', run: () => exec('git.stageAll') }, { label: 'Discard All Changes', run: () => exec('git.cleanAll') }], { x, y }));
    this.list.append(row);
    this.rows.push({ el: row, group: id });
    if (collapsed) return;
    const shown = list.slice(0, MAX_ROWS);
    for (const c of shown) this.renderResource(c, id === 'staged', repo);
    if (list.length > shown.length) this.list.append(h('div', { class: 'scm-more' }, `${list.length - shown.length} more changes are not shown. Add a .gitignore to hide generated files.`));
  }

  renderResource(c, staged, repo) {
    const letter = staged && c.status === 'U' ? 'A' : c.status;
    const name = posix.basename(c.path), folder = posix.dirname(c.path);
    const acts = h('div', { class: 'scm-actions monaco-toolbar' },
      c.status !== 'D' ? actionIcon('go-to-file', 'Open File', () => exec('git.openFile', c.path)) : null,
      !staged ? actionIcon('discard', 'Discard Changes', () => exec('git.clean', c.path)) : null,
      staged ? actionIcon('remove', 'Unstage Changes', () => exec('git.unstage', c.path)) : actionIcon('add', 'Stage Changes', () => exec('git.stage', c.path)));
    const row = h('div', {
      class: ['monaco-list-row', 'scm-resource', `status-${STATUS_CLASS[letter]}`], role: 'treeitem', 'data-path': c.path,
      title: `${c.path} • ${STATUS_TEXT[letter]}${c.legacy ? ' (base content unavailable — pull to refresh)' : ''}`, 'aria-label': `${c.path}, ${STATUS_TEXT[letter]}`
    },
      h('span', { class: 'scm-file-icon', html: fileIconHtml(c.path) }),
      h('span', { class: 'scm-label' }, h('span', { class: 'scm-name' }, name), folder ? h('span', { class: 'scm-folder label-description' }, folder) : null),
      acts,
      h('span', { class: 'scm-letter', title: STATUS_TEXT[letter] }, letter));
    row.addEventListener('click', () => { this.focusIndex = this.rows.findIndex(r => r.el === row); this.updateFocus(false); exec('git.openChange', c.path); });
    onContextMenu(row, (x, y) => showContextMenu(this.resourceMenu(c, staged), { x, y }));
    this.list.append(row);
    this.rows.push({ el: row, path: c.path, staged, change: c });
  }

  resourceMenu(c, staged) {
    return [
      { label: 'Open Changes', icon: 'git-compare', run: () => exec('git.openChange', c.path) },
      ...(c.status !== 'D' ? [{ label: 'Open File', icon: 'go-to-file', run: () => exec('git.openFile', c.path) }] : []),
      { separator: true },
      staged ? { label: 'Unstage Changes', icon: 'remove', run: () => exec('git.unstage', c.path) } : { label: 'Stage Changes', icon: 'add', run: () => exec('git.stage', c.path) },
      ...(!staged ? [{ label: 'Discard Changes', icon: 'discard', run: () => exec('git.clean', c.path) }] : []),
      { separator: true },
      { label: 'Copy Relative Path', run: () => copyText(c.path) },
      ...(c.status !== 'D' && commands.has('workbench.files.action.showActiveFileInExplorer')
        ? [{ label: 'Reveal in Explorer View', run: async () => { try { const { files } = await import('../views/files-api.js'); files.reveal(c.path); } catch {} } }] : [])
    ];
  }

  // ---------------- keyboard
  updateFocus(scroll = true) {
    this.rows.forEach((r, i) => r.el.classList.toggle('focused', i === this.focusIndex));
    if (scroll) this.rows[this.focusIndex]?.el.scrollIntoView({ block: 'nearest' });
  }
  onKey(e) {
    if (!this.rows.length) return;
    const r = this.rows[this.focusIndex];
    if (e.key === 'ArrowDown') { e.preventDefault(); this.focusIndex = Math.min(this.rows.length - 1, this.focusIndex + 1); this.updateFocus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.focusIndex = Math.max(0, this.focusIndex - 1); this.updateFocus(); }
    else if (e.key === 'Enter' && r) { e.preventDefault(); r.el.click(); }
    else if (e.key === ' ' && r?.path) { e.preventDefault(); exec(r.staged ? 'git.unstage' : 'git.stage', r.path); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && r?.path && !r.staged) { e.preventDefault(); exec('git.clean', r.path); }
  }
}

// ---------------------------------------------------------------- Commits view

export class CommitsView {
  constructor(body) {
    this.store = new DisposableStore();
    this.el = h('div', { class: 'scm-commits monaco-list', role: 'list', 'aria-label': 'Commits' });
    this.progress = h('div', { class: 'monaco-progress-container' }, h('div', { class: 'progress-bit' }));
    this.content = h('div', { class: 'scm-commits-content' });
    this.el.append(this.progress, this.content);
    body.append(this.el);
    this.remote = null; this.error = null; this.loadedKey = null; this.loadedAt = 0; this.visible = true;
    this.store.add(scmEvents.on('history', () => this.load(true)));
    this.store.add(scmEvents.on('changed', () => this.renderSoon()));
    this.store.add(bus.on('project:opened', () => { this.remote = null; this.error = null; this.loadedKey = null; this.load(true); }));
    this.store.add(auth.onChange(() => this.load(true)));
    this.load();
  }
  dispose() { this.store.dispose(); this.el.remove(); }
  onShow() { this.visible = true; if (Date.now() - this.loadedAt > 60000) this.load(); else this.render(); }
  onHide() { this.visible = false; }
  renderSoon() { if (this.pending) return; this.pending = true; requestAnimationFrame(() => { this.pending = false; this.render(); }); }

  async load(force = false) {
    const repo = scm.repo;
    if (!repo?.connected) { this.remote = null; this.error = null; this.loadedKey = null; this.render(); return; }
    const key = `${repo.id}|${repo.git.repo}|${repo.branch}`;
    if (!force && key === this.loadedKey && Date.now() - this.loadedAt < 60000) { this.render(); return; }
    if (!this.visible && !force) return;
    const token = (this.token = (this.token || 0) + 1);
    this.progress.classList.add('active', 'infinite');
    try {
      const list = navigator.onLine === false ? null : await gh.commits(repo.owner, repo.name, repo.branch, 30);
      if (token !== this.token) return;
      this.remote = Array.isArray(list) ? list : null;
      this.error = list === null ? 'You are offline — connect to see the commits on GitHub.' : null;
    } catch (err) {
      if (token !== this.token) return;
      this.remote = null;
      this.error = err.status === 409 ? '' : (err.message || String(err));
    } finally {
      if (token === this.token) { this.progress.classList.remove('active', 'infinite'); this.loadedKey = key; this.loadedAt = Date.now(); }
    }
    this.render();
  }

  render() {
    clear(this.content);
    const repo = scm.repo;
    if (!repo?.connected) { this.content.append(h('div', { class: 'scm-commits-message' }, 'No GitHub repository is connected.')); return; }
    const rows = [];
    for (const c of [...repo.git.outgoing].reverse()) {
      rows.push(this.row({
        icon: 'cloud-upload', cls: 'outgoing', message: c.message, detail: `${c.author || 'You'} · ${relativeTime(c.time)} · not pushed`, sha: 'local',
        menu: [
          { label: 'Push', run: () => exec('git.push') },
          ...(c === repo.git.outgoing.at(-1) ? [{ label: 'Undo Last Commit', run: () => exec('git.undoCommit') }] : []),
          { separator: true },
          { label: 'Copy Commit Message', run: () => copyText(c.message) }
        ],
        title: `${c.message}\n\n${c.changes.length} file(s) · not pushed yet`,
        run: () => showContextMenu([{ label: `${c.changes.length} changed file(s)`, disabled: true }, ...c.changes.slice(0, 30).map(ch => ({ label: `${ch.status}  ${ch.path}`, run: () => ch.status !== 'D' && exec('git.openFile', ch.path) }))], { anchor: this.content.querySelector(`[data-id="${CSS.escape(c.id)}"]`) || this.content, align: 'left' }),
        id: c.id
      }));
    }
    let incoming = repo.git.lastSyncSha ? true : false;
    for (const c of this.remote || []) {
      if (c.sha === repo.git.lastSyncSha) incoming = false;
      const msg = c.commit?.message || '';
      const author = c.author?.login || c.commit?.author?.name || 'unknown';
      const date = Date.parse(c.commit?.author?.date || c.commit?.committer?.date || '') || Date.now();
      rows.push(this.row({
        icon: incoming ? 'arrow-down' : 'git-commit', cls: incoming ? 'incoming' : '', message: msg, detail: `${author} · ${relativeTime(date)}${incoming ? ' · incoming' : ''}`,
        sha: c.sha.slice(0, 7), title: `${msg}\n\n${author}, ${new Date(date).toLocaleString()}\n${c.sha}`,
        run: () => window.open(c.html_url || `https://github.com/${repo.git.repo}/commit/${c.sha}`, '_blank', 'noopener'),
        menu: [
          { label: 'Open on GitHub', icon: 'link-external', run: () => window.open(c.html_url || `https://github.com/${repo.git.repo}/commit/${c.sha}`, '_blank', 'noopener') },
          { separator: true },
          { label: 'Copy Commit ID', run: () => copyText(c.sha) },
          { label: 'Copy Commit Message', run: () => copyText(msg) },
          ...(incoming ? [{ separator: true }, { label: 'Pull', run: () => exec('git.pull') }] : [])
        ]
      }));
    }
    if (!rows.length) {
      const text = this.error ?? (this.remote ? 'No commits yet. Commit & push to create the first one.' : this.error === '' ? 'The repository is empty. Commit & push to create the first commit.' : 'Loading commits…');
      const msg = h('div', { class: 'scm-commits-message' }, text || 'The repository is empty. Commit & push to create the first commit.');
      if (this.error) { const retry = h('a', { class: 'scm-link', role: 'button', tabindex: '0' }, 'Retry'); retry.addEventListener('click', () => this.load(true)); msg.append(' ', retry); }
      this.content.append(msg);
      return;
    }
    if (this.error) this.content.append(h('div', { class: 'scm-commits-message warning' }, this.error));
    this.content.append(...rows);
  }

  row({ icon, cls, message, detail, sha, title, run, menu, id }) {
    const first = String(message || '').split('\n')[0] || '(no message)';
    const el = h('div', { class: ['monaco-list-row', 'scm-commit', cls], role: 'listitem', title, 'data-id': id || null },
      codicon(icon, 'scm-commit-icon'),
      h('span', { class: 'scm-commit-label' }, h('span', { class: 'scm-commit-message' }, first), h('span', { class: 'label-description scm-commit-detail' }, detail)),
      h('span', { class: 'scm-commit-sha' }, sha));
    el.addEventListener('click', () => run?.());
    if (menu) onContextMenu(el, (x, y) => showContextMenu(menu, { x, y }));
    return el;
  }
}
