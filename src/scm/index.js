// Source Control feature entry: the SOURCE CONTROL view container (Changes + Commits), git.* / github.*
// commands (VS Code IDs), branch + sync status bar items, Accounts menu entries for GitHub, git settings,
// auto-push of AI edits and the `git` terminal command.

import { bus } from '../core/events.js';
import { debounce } from '../core/dom.js';
import { settings } from '../core/settings.js';
import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { workspace } from '../core/workspace.js';
import { posix, isTextPath } from '../core/path.js';
import { quickInput } from '../platform/quickinput.js';
import { notify } from '../platform/notifications.js';
import { dialogs } from '../platform/dialogs.js';
import { views } from '../workbench/views.js';
import { editors } from '../workbench/editors.js';
import { statusbar } from '../workbench/statusbar.js';
import { fileIconHtml } from '../workbench/icons.js';
import { GitHubError, gitLog } from './github.js';
import { auth } from './auth.js';
import {
  scm, scmEvents, initService, refresh, requireRepo, requireAuth, commitLocal, pushOutgoing, pull, fetchRemoteState,
  discard, cloneRepository, connectRepository, disconnectRepository, publishRepository, checkoutBranch, createBranch,
  undoLastCommit, baseText, gh, GitError, Cancelled
} from './service.js';
import { ScmView, CommitsView, statusCounts } from './view.js';
import { pickRepository } from './ui.js';
import { branchNameError, repoSlug, isValidRepoName, IgnoreMatcher, parseRepo } from './util.js';
import { registerGitTerminal } from './terminal.js';

const CONTAINER = 'workbench.view.scm';
const CHANGES_VIEW = 'workbench.scm';
const COMMITS_VIEW = 'workbench.scm.commits';
let scmView = null;
let commitsView = null;

const exec = (id, ...args) => commands.execute(id, ...args).catch(() => {});
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- errors & progress

function report(err, what = '') {
  if (!err || err instanceof Cancelled) return;
  const prefix = what ? `${what}: ` : '';
  if (err instanceof GitError) {
    const fn = err.severity === 'info' ? notify.info : err.severity === 'warning' ? notify.warn : notify.error;
    fn(err.message, { source: 'Git', actions: err.actions.map(a => ({ label: a.label, run: () => exec(a.command) })) });
    if (err.severity === 'error') gitLog.error(`${prefix}${err.message}`);
    return;
  }
  if (err instanceof GitHubError) {
    const actions = [];
    if (err.status === 401) {
      if (auth.isSignedIn()) auth.signOut();
      actions.push({ label: 'Sign in with GitHub', run: () => exec('github.signIn') });
    }
    if (err.code === 'updateRef') actions.push({ label: 'Pull', run: () => exec('git.pull') });
    actions.push({ label: 'Show Git Output', run: () => gitLog.show() });
    notify.error(`${prefix}${err.message}`, { source: 'Git', actions });
    return;
  }
  gitLog.error(`${prefix}${err?.stack || err}`);
  notify.error(`${prefix}${err?.message || err}`, { source: 'Git', actions: [{ label: 'Show Git Output', run: () => gitLog.show() }] });
}

/** Runs an operation in the queue with a progress notification (progress text may be updated). */
async function withGitProgress(label, title, fn) {
  const n = notify.progress(title, { source: 'Git' });
  try {
    return await scm.exclusive(label, () => fn(text => n.update(text)));
  } finally { n.close(); }
}

async function repoOrThrow() { await scm.ready(); return requireRepo(scm.repo); }

/** Paths from command arguments: 'a.js' | ['a.js'] | {path} | {paths} | resource objects; default = active editor file. */
function pathsOf(args) {
  const out = [];
  const add = v => {
    if (!v) return;
    if (typeof v === 'string') out.push(posix.clean(v));
    else if (Array.isArray(v)) v.forEach(add);
    else if (Array.isArray(v.paths)) v.paths.forEach(add);
    else if (typeof v.path === 'string') out.push(posix.clean(v.path));
  };
  args.forEach(add);
  if (!out.length && editors.activeInput?.path) out.push(editors.activeInput.path);
  return [...new Set(out)];
}

// ---------------------------------------------------------------- settings

function registerSettings() {
  const category = 'Extensions/Git';
  settings.register(
    { key: 'git.postCommitCommand', type: 'enum', enum: ['none', 'push', 'sync'], enumLabels: ['none', 'push', 'sync'], default: 'push', category, order: 1, title: 'Post Commit Command',
      enumDescriptions: ['Only commit (push later with Push or Sync).', 'Push to GitHub right after a successful commit.', 'Pull and push right after a successful commit.'],
      description: 'Runs a git command after a successful commit. The Source Control button shows "Commit", "Commit & Push" or "Commit & Sync" accordingly.' },
    { key: 'git.autoPushAIEdits', type: 'boolean', default: false, category, order: 2, title: 'Auto Push AI Edits',
      description: 'Automatically commit and push the files X Coder AI changes (Agent edits you keep), with the message "X Coder AI: <summary>". Needs a connected repository and GitHub sign-in.' },
    { key: 'git.rememberToken', type: 'boolean', default: false, category, order: 3, title: 'Remember Token',
      description: "Keep the GitHub sign-in on this device after X Coder closes (stored in this browser's local storage). When off, the token only lasts for the current browser session." },
    { key: 'git.confirmSync', type: 'boolean', default: true, category, order: 4, title: 'Confirm Sync', description: 'Confirm before synchronizing (pulling and pushing) with GitHub.' },
    { key: 'git.defaultBranch', type: 'string', default: 'main', category, order: 5, title: 'Default Branch Name', description: 'The name of the default branch when publishing a new repository.' },
    { key: 'git.autofetch', type: 'boolean', default: true, category, order: 6, title: 'Autofetch',
      description: 'When signed in, check GitHub for new commits when a project opens and every 3 minutes, and show them in the status bar (↓).' },
    { key: 'github.defaultPrivate', type: 'boolean', default: true, category, order: 7, title: 'GitHub: Default Private', description: 'Offer a private repository first when publishing to GitHub.' }
  );
}

// ---------------------------------------------------------------- views

const refreshDiffsSoon = debounce(() => refreshOpenDiffs(), 400);

function registerViews() {
  views.registerContainer({
    id: CONTAINER, title: 'Source Control', icon: 'source-control', order: 3, keybinding: 'Ctrl+Shift+G',
    actions: [
      { icon: 'check', title: 'Commit', command: 'git.commit' },
      { icon: 'refresh', title: 'Refresh', command: 'git.refresh' }
    ],
    moreActions: () => moreMenu()
  });
  views.registerView({
    id: CHANGES_VIEW, containerId: CONTAINER, name: 'Changes', order: 1, size: 'fill',
    render(body) {
      scmView?.dispose();
      const v = new ScmView(body);
      scmView = v;
      return { dispose: () => { v.dispose(); if (scmView === v) scmView = null; }, onShow: () => v.onShow(), focus: () => v.focus() };
    }
  });
  views.registerView({
    id: COMMITS_VIEW, containerId: CONTAINER, name: 'Commits', order: 2, size: 'auto',
    actions: [{ icon: 'refresh', title: 'Refresh Commits', run: () => commitsView?.load(true) }],
    moreActions: () => [
      { label: 'Refresh', run: () => commitsView?.load(true) },
      { label: 'Fetch', run: () => exec('git.fetch') },
      { label: 'Open Repository on GitHub', disabled: !scm.repo?.connected, run: () => window.open(`https://github.com/${scm.repo.git.repo}/commits/${encodeURIComponent(scm.repo.branch)}`, '_blank', 'noopener') }
    ],
    render(body) {
      commitsView?.dispose();
      const v = new CommitsView(body);
      commitsView = v;
      return { dispose: () => { v.dispose(); if (commitsView === v) commitsView = null; }, onShow: () => v.onShow(), onHide: () => v.onHide() };
    }
  });
  let badge = -1;
  scmEvents.on('changed', () => refreshDiffsSoon());
  scmEvents.on('changed', repo => {
    const n = repo?.connected ? repo.changes.length : 0;
    if (n === badge) return;
    badge = n;
    views.setBadge(CONTAINER, n || null, n ? `Source Control — ${plural(n, 'pending change')}` : '');
  });
}

function moreMenu() {
  const repo = scm.repo;
  const c = !!repo?.connected;
  const item = (label, id, disabled = false) => ({ label, disabled, run: () => exec(id) });
  return [
    item('Pull', 'git.pull', !c),
    item('Push', 'git.push', !c),
    item('Clone', 'git.clone'),
    item('Checkout to...', 'git.checkout', !c),
    { separator: true },
    { label: 'Commit', submenu: () => [
      item('Commit', 'git.commitNoPush', !c),
      item('Commit & Push', 'git.commitPush', !c),
      item('Commit & Sync', 'git.commitSync', !c),
      { separator: true },
      item('Undo Last Commit', 'git.undoCommit', !repo?.ahead)
    ] },
    { label: 'Changes', submenu: () => [
      item('Stage All Changes', 'git.stageAll', !c),
      item('Unstage All Changes', 'git.unstageAll', !c),
      item('Discard All Changes', 'git.cleanAll', !c)
    ] },
    { label: 'Pull, Push', submenu: () => [
      item('Sync', 'git.sync', !c),
      item('Pull', 'git.pull', !c),
      item('Push', 'git.push', !c),
      item('Fetch', 'git.fetch', !c)
    ] },
    { label: 'Branch', submenu: () => [
      item('Create Branch...', 'git.branch', !c),
      item('Create Branch From...', 'git.branchFrom', !c)
    ] },
    { label: 'Remote', submenu: () => [
      item('Publish to GitHub', 'git.publish', c),
      item('Connect Repository...', 'git.addRemote'),
      item('Remove Remote', 'git.removeRemote', !c)
    ] },
    { separator: true },
    ...menus.resolve('scm/title', repo || null),
    { separator: true },
    item('Show Git Output', 'git.showOutput'),
    { separator: true },
    auth.isSignedIn() ? item(`Sign Out of GitHub (${auth.user?.login || 'account'})`, 'github.signOut') : item('Sign in with GitHub', 'github.signIn')
  ];
}

// ---------------------------------------------------------------- commit / push / pull / sync

async function doCommit(arg = {}) {
  const repo = await repoOrThrow();
  const opts = typeof arg === 'string' ? { message: arg } : (arg || {});
  const post = opts.post || settings.get('git.postCommitCommand', 'push');
  await refresh();
  if (!repo.changes.length) throw new GitError('There are no changes to commit.', { severity: 'info' });
  let message = opts.message ?? scmView?.message() ?? '';
  if (!String(message).trim()) {
    message = await quickInput.input({ title: 'Commit', placeholder: 'Commit message', prompt: "Please provide a commit message (press 'Enter' to confirm or 'Escape' to cancel)" });
    if (!message?.trim()) return false;
  }
  await scm.exclusive('Commit', () => commitLocal(repo, message));
  scmView?.setMessage('');
  if (post === 'push' || post === 'sync') {
    try {
      if (post === 'sync') await doSync({ confirm: false, quiet: true });
      else await doPush({ quiet: true });
    } catch (err) {
      if (err instanceof Cancelled) return true;
      const reason = err?.message || String(err);
      notify.warn(`Committed locally, but ${post === 'sync' ? 'syncing' : 'pushing'} failed: ${reason}`, {
        source: 'Git', actions: [{ label: post === 'sync' ? 'Sync' : 'Push', run: () => exec(post === 'sync' ? 'git.sync' : 'git.push') }, { label: 'Show Git Output', run: () => gitLog.show() }]
      });
      if (err instanceof GitHubError && err.status === 401 && auth.isSignedIn()) auth.signOut();
    }
  }
  return true;
}

async function doPush({ quiet = false } = {}) {
  const repo = await repoOrThrow();
  if (!repo.ahead) {
    if (!quiet) notify.info(repo.changes.length ? 'There are no commits to push. Commit your changes first.' : 'Everything is up to date.', { source: 'Git' });
    return { pushed: 0 };
  }
  await requireAuth('to push your commits');
  const res = await withGitProgress('Push', `Pushing to ${repo.git.repo}…`, update => pushOutgoing(repo, { onProgress: (d, t) => update(`Pushing to ${repo.git.repo}… uploading ${d}/${t} files`) }));
  notify.info(`Pushed ${plural(res.pushed, 'commit')} to origin/${repo.branch}.`, { source: 'Git' });
  commitsView?.load(true);
  return res;
}

async function doPull({ quiet = false } = {}) {
  const repo = await repoOrThrow();
  const res = await withGitProgress('Pull', `Pulling from ${repo.git.repo}…`, update => pull(repo, { onProgress: (d, t) => update(`Pulling from ${repo.git.repo}… ${d}/${t} files`) }));
  if (res.upToDate) { if (!quiet) notify.info(res.empty ? 'The remote repository is empty.' : 'Already up to date.', { source: 'Git' }); }
  else {
    notify.info(`Pulled origin/${repo.branch}: ${plural(res.updated, 'file')} updated, ${res.deleted} deleted.`, { source: 'Git' });
    reportSkipped(res.skipped);
  }
  return res;
}

async function doSync({ confirm = true, quiet = false } = {}) {
  const repo = await repoOrThrow();
  if (confirm && settings.get('git.confirmSync', true)) {
    const choice = await dialogs.show({ type: 'warning', message: `This action will pull and push commits from and to "origin/${repo.branch}".`, buttons: ['OK', "OK, Don't Show Again", 'Cancel'], defaultId: 0, cancelId: 2 });
    if (choice === 2) return;
    if (choice === 1) settings.set('git.confirmSync', false);
  }
  await doPull({ quiet: true });
  if (repo.ahead) await doPush({ quiet });
  else if (!quiet) notify.info(`Synchronized with origin/${repo.branch}.`, { source: 'Git' });
}

function reportSkipped(skipped = []) {
  if (!skipped.length) return;
  const lines = skipped.slice(0, 8).map(s => `${s.path} (${s.reason})`).join(', ');
  notify.warn(`${plural(skipped.length, 'file')} from GitHub ${skipped.length === 1 ? 'was' : 'were'} not downloaded: ${lines}${skipped.length > 8 ? ', …' : ''}.`, { source: 'Git' });
  for (const s of skipped) gitLog.warn(`Skipped ${s.path}: ${s.reason}`);
}

// ---------------------------------------------------------------- repository setup

async function listMyRepos() {
  if (!auth.isSignedIn()) return [];
  return gh.userRepos();
}

async function doClone(url, branch) {
  let parsed = null;
  if (typeof url === 'string' && url.trim()) {
    parsed = parseRepo(url);
    if (!parsed) throw new GitError(`'${url}' is not a GitHub repository. Use owner/repo or https://github.com/owner/repo.`);
  } else {
    parsed = await pickRepository({ title: 'Clone Repository', listRepos: auth.isSignedIn() ? listMyRepos : null });
    if (!parsed) return null;
  }
  const res = await withGitProgress(`Clone ${parsed.full}`, `Cloning git repository '${parsed.full}'…`, update =>
    cloneRepository(parsed, { branch: typeof branch === 'string' ? branch : undefined, onProgress: (d, t) => update(`Cloning git repository '${parsed.full}'… ${d}/${t} files`) }));
  notify.info(res.empty ? `Cloned ${res.full}. The repository is empty — add files, then Commit & Push.` : `Cloned ${res.full} (${plural(res.files, 'file')}, branch ${res.branch}).`, { source: 'Git' });
  reportSkipped(res.skipped);
  return res.project;
}

async function doPublish() {
  await scm.ready();
  const repo = scm.repo;
  if (!repo) throw new GitError('Open a project first.');
  if (repo.connected) {
    notify.info(`This project is already published to ${repo.git.repo}.`, { source: 'Git', actions: [{ label: 'Open on GitHub', run: () => window.open(`https://github.com/${repo.git.repo}`, '_blank', 'noopener') }] });
    return null;
  }
  const user = await requireAuth('to publish this project');
  const login = user?.login || auth.user?.login || 'you';
  const privateFirst = settings.get('github.defaultPrivate', true);
  const choice = await quickInput.pick(value => {
    const name = value.trim();
    if (!isValidRepoName(name)) return [{ label: 'Repository names can only contain letters, numbers, ".", "-" and "_"', icon: 'warning', disabled: true }];
    const priv = { label: 'Publish to GitHub private repository', description: `${login}/${name}`, icon: 'lock', isPrivate: true, name };
    const pub = { label: 'Publish to GitHub public repository', description: `${login}/${name}`, icon: 'repo', isPrivate: false, name };
    return privateFirst ? [priv, pub] : [pub, priv];
  }, { title: 'Publish to GitHub', placeholder: 'Repository Name', value: repoSlug(workspace.name), filter: false });
  if (!choice) return null;
  const ignore = IgnoreMatcher.fromFS(repo.fs);
  const files = repo.fs.files().map(r => r.path).filter(p => !ignore.ignores(p));
  if (!files.length) throw new GitError('This project has no files to publish yet.', { severity: 'info' });
  const pending = quickInput.pick(files.map(p => ({ label: posix.basename(p), description: posix.dirname(p), path: p, picked: true, iconHtml: fileIconHtml(p) })), {
    title: 'Publish to GitHub', placeholder: 'Select which files should be included in the repository.', canPickMany: true, matchOnDescription: true
  });
  // Every file starts selected (the quick input's first render only ticks the first pre-picked checkbox).
  requestAnimationFrame(() => { for (const cb of document.querySelectorAll('#quick-input-widget .quick-input-checkbox')) cb.checked = true; });
  const picked = await pending;
  if (!picked) return null;
  if (!picked.length) throw new GitError('Select at least one file to publish.', { severity: 'info' });
  const created = await withGitProgress('Publish', `Publishing to GitHub ${choice.isPrivate ? 'private' : 'public'} repository '${login}/${choice.name}'…`, update =>
    publishRepository(repo, { name: choice.name, isPrivate: choice.isPrivate, paths: picked.map(p => p.path) }).then(r => { update('Done'); return r; }));
  notify.info(`Successfully published the '${created.full_name}' repository to GitHub.`, { source: 'Git', actions: [{ label: 'Open on GitHub', run: () => window.open(created.html_url || `https://github.com/${created.full_name}`, '_blank', 'noopener') }] });
  commitsView?.load(true);
  return created.full_name;
}

async function doAddRemote(url) {
  await scm.ready();
  const repo = scm.repo;
  if (!repo) throw new GitError('Open a project first.');
  let parsed;
  if (typeof url === 'string' && url.trim()) {
    parsed = parseRepo(url);
    if (!parsed) throw new GitError(`'${url}' is not a GitHub repository URL.`);
  } else {
    parsed = await pickRepository({ title: 'Connect Existing Repository', placeholder: 'Provide the GitHub repository (owner/repo or URL) to connect to this project', listRepos: auth.isSignedIn() ? listMyRepos : null });
    if (!parsed) return null;
  }
  if (repo.connected) {
    if (repo.git.repo.toLowerCase() === parsed.full.toLowerCase()) { notify.info(`This project is already connected to ${repo.git.repo}.`, { source: 'Git' }); return null; }
    const ok = await dialogs.confirm({ message: `Replace the connection to ${repo.git.repo} with ${parsed.full}?`, detail: repo.ahead ? `${plural(repo.ahead, 'local commit')} that ${repo.ahead === 1 ? 'has' : 'have'} not been pushed will be discarded. Your files are kept.` : 'Your files are kept.', primary: 'Replace', danger: !!repo.ahead });
    if (!ok) return null;
  }
  try {
    const res = await withGitProgress('Connect Repository', `Connecting to ${parsed.full}…`, update => connectRepository(repo, parsed).then(r => { update('Merging files…'); return r; }));
    notify.info(res.merged
      ? `Connected to ${res.full} (${res.branch}). ${res.updated ? `${plural(res.updated, 'file')} came from GitHub.` : 'Your files match GitHub.'}`
      : res.empty ? `Connected to ${res.full}. The repository is empty — Commit & Push to publish your files.` : `Connected to ${res.full}.`, { source: 'Git' });
    if (res.skipped) reportSkipped(res.skipped);
    return res.full;
  } catch (err) {
    if (err instanceof Cancelled && scm.repo?.connected) {
      notify.info(`Connected to ${scm.repo.git.repo}. Your conflicting files were kept — Pull when you are ready to merge the files from GitHub.`, { source: 'Git', actions: [{ label: 'Pull', run: () => exec('git.pull') }] });
      return scm.repo.git.repo;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- branches

async function hasPendingWork(repo, action) {
  await refresh();
  if (!repo.changes.length && !repo.ahead) return false;
  const parts = [];
  if (repo.changes.length) parts.push(plural(repo.changes.length, 'uncommitted change'));
  if (repo.ahead) parts.push(plural(repo.ahead, 'unpushed commit'));
  const choice = await dialogs.show({
    type: 'warning', message: `You have ${parts.join(' and ')} on '${repo.branch}'.`,
    detail: `Commit & push or discard them before you ${action}.\n\nDiscarding permanently removes your uncommitted changes${repo.ahead ? ' and unpushed commits' : ''}.`,
    buttons: ['Discard Changes & Continue', 'Cancel'], defaultId: 1, cancelId: 1, danger: true
  });
  if (choice !== 0) throw new Cancelled();
  return true; // untracked files are deleted by the checkout once the target branch has been downloaded
}

async function doCheckout(target) {
  const repo = await repoOrThrow();
  let branch = typeof target === 'string' ? target : null;
  if (!branch) {
    let loading = null; // fetched once; the item provider runs on every keystroke
    const pick = await quickInput.pick(async () => {
      let list = [];
      try { list = await (loading ||= gh.branches(repo.owner, repo.name)); } catch (err) { if (!(err instanceof GitHubError && err.status === 409)) return [{ label: err.message, icon: 'error', disabled: true }]; }
      const names = new Set(list.map(b => b.name));
      return [
        { label: 'Create new branch...', icon: 'plus', action: 'create', alwaysShow: true },
        { label: 'Create new branch from...', icon: 'plus', action: 'createFrom', alwaysShow: true },
        { kind: 'separator', label: 'branches' },
        ...(!names.has(repo.branch) ? [{ label: repo.branch, description: 'current · not pushed yet', icon: 'git-branch', branch: repo.branch }] : []),
        ...list.map(b => ({ label: b.name, description: `${b.name === repo.branch ? 'current · ' : ''}${b.commit?.sha?.slice(0, 8) || ''}`, icon: 'git-branch', branch: b.name }))
      ];
    }, { title: 'Checkout', placeholder: 'Select a branch to checkout', matchOnDescription: true });
    if (!pick) return;
    if (pick.action === 'create') return doCreateBranch();
    if (pick.action === 'createFrom') return doCreateBranchFrom();
    branch = pick.branch;
  }
  if (branch === repo.branch) return;
  const discardUntracked = await hasPendingWork(repo, `switch to '${branch}'`);
  await withGitProgress(`Checkout ${branch}`, `Checking out '${branch}'…`, update => checkoutBranch(repo, branch, { discardUntracked, onProgress: (d, t) => update(`Checking out '${branch}'… ${d}/${t} files`) }));
  notify.info(`Switched to branch '${branch}'.`, { source: 'Git' });
}

async function askBranchName(title) {
  return quickInput.input({ title, placeholder: 'Branch name', prompt: 'Please provide a new branch name', validate: v => branchNameError(v) });
}

async function doCreateBranch(name) {
  const repo = await repoOrThrow();
  const branch = typeof name === 'string' && name ? name : await askBranchName('Create Branch');
  if (!branch) return;
  const err = branchNameError(branch);
  if (err) throw new GitError(err);
  if (repo.git.lastSyncSha) await requireAuth('to create a branch on GitHub');
  await scm.exclusive('Create Branch', () => createBranch(repo, branch));
  notify.info(`Switched to a new branch '${branch}'.${repo.ahead ? ' Your local commits will be pushed to it.' : ''}`, { source: 'Git' });
}

async function doCreateBranchFrom() {
  const repo = await repoOrThrow();
  let loading = null;
  const pick = await quickInput.pick(async () => {
    const list = await (loading ||= gh.branches(repo.owner, repo.name));
    return list.map(b => ({ label: b.name, description: b.commit?.sha?.slice(0, 8) || '', icon: 'git-branch', branch: b.name }));
  }, { title: 'Create Branch From', placeholder: 'Select a ref to create the branch from' });
  if (!pick) return;
  const branch = await askBranchName(`Create Branch From ${pick.branch}`);
  if (!branch) return;
  await requireAuth('to create a branch on GitHub');
  const discardUntracked = await hasPendingWork(repo, `create '${branch}' from '${pick.branch}'`);
  await withGitProgress('Create Branch', `Creating '${branch}' from '${pick.branch}'…`, () => createBranch(repo, branch, { from: pick.branch, discardUntracked }));
  notify.info(`Switched to a new branch '${branch}'.`, { source: 'Git' });
}

// ---------------------------------------------------------------- changes

/** Diff editor input for a changed text file, or null when the change is best shown by opening the file. */
async function diffInput(repo, path) {
  const status = repo.status.get(path);
  if (!status || status === 'U') return null;
  const rec = repo.fs.get(path);
  if (rec?.binary instanceof Blob || repo.base.get(path)?.binary || !isTextPath(path)) return null;
  const name = posix.basename(path);
  const change = repo.changes.find(c => c.path === path);
  let original = await baseText(repo, path);
  if (original == null) original = change?.legacy ? 'Base content unavailable — pull to refresh.\n' : '';
  let modified = '';
  if (status !== 'D') {
    try { const { codeEditor } = await import('../editor/api.js'); modified = codeEditor.getText(path) ?? repo.fs.peekText(path) ?? ''; }
    catch { modified = repo.fs.peekText(path) ?? ''; }
  }
  return {
    type: 'diff', id: `scm:${path}`, path, readOnly: true, original, modified,
    title: `${name} (${status === 'D' ? 'Deleted' : 'Working Tree'})`,
    actions: [
      { label: 'Discard Changes', icon: 'discard', run: () => exec('git.clean', path) },
      ...(status !== 'D' ? [{ label: 'Open File', icon: 'go-to-file', run: () => exec('git.openFile', path) }] : [])
    ]
  };
}

async function openChange(...args) {
  const repo = await repoOrThrow();
  const [path] = pathsOf(args);
  if (!path) return;
  await scm.ready();
  const status = repo.status.get(path);
  const input = await diffInput(repo, path);
  if (!input) {
    if (repo.fs.isFile(path)) return editors.open({ type: 'file', path }, { pinned: true });
    if (status === 'D') throw new GitError(`${posix.basename(path)} is a binary file and was deleted. Discard the change to restore it.`, { severity: 'info' });
    return;
  }
  const key = editors.keyOf(input);
  const open = editors.get(key);
  if (open && (open.input.original !== input.original || open.input.modified !== input.modified)) await editors.close(key, { force: true });
  const { codeEditor } = await import('../editor/api.js');
  return codeEditor.openDiff(input);
}

/** Keeps open "(Working Tree)" diffs current: stale ones are rebuilt (active) or closed (resolved/inactive). */
let refreshingDiffs = false;
async function refreshOpenDiffs() {
  if (refreshingDiffs) return;
  refreshingDiffs = true;
  try {
    const repo = scm.repo;
    for (const e of editors.list()) {
      const id = e.input?.type === 'diff' && typeof e.input.id === 'string' && e.input.id.startsWith('scm:') ? e.input.id : null;
      if (!id) continue;
      const path = id.slice(4);
      const next = repo?.connected ? await diffInput(repo, path) : null;
      if (next && next.original === e.input.original && next.modified === e.input.modified) continue;
      const wasActive = editors.active?.key === e.key;
      await editors.close(e.key, { force: true });
      if (next && wasActive) await editors.open(next, { pinned: true, focus: false }); // no focus: keeps the Source Control overlay open on phones
    }
  } catch (err) { gitLog.warn(`Refreshing diff editors failed: ${err.message || err}`); }
  finally { refreshingDiffs = false; }
}

function closeDiffs(paths) {
  for (const p of paths) {
    const key = editors.keyOf({ type: 'diff', id: `scm:${p}` });
    if (editors.isOpen(key)) editors.close(key, { force: true }).catch(() => {});
  }
}

async function doClean(...args) {
  const repo = await repoOrThrow();
  await refresh();
  const paths = pathsOf(args).filter(p => repo.status.has(p));
  if (!paths.length) { notify.info('There are no changes to discard.', { source: 'Git' }); return; }
  const untracked = paths.filter(p => repo.status.get(p) === 'U');
  let message, detail = '', button;
  if (paths.length === 1) {
    const name = posix.basename(paths[0]);
    if (untracked.length) { message = `Are you sure you want to DELETE '${name}'?`; detail = 'This is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.'; button = 'Delete File'; }
    else { message = `Are you sure you want to discard changes in '${name}'?`; button = 'Discard File'; }
  } else {
    message = `Are you sure you want to discard changes in ${paths.length} files?`;
    detail = untracked.length ? `This is IRREVERSIBLE!\n${plural(untracked.length, 'untracked file')} will be deleted and FOREVER LOST if you proceed.` : 'This is IRREVERSIBLE!';
    button = `Discard ${paths.length} Files`;
  }
  const ok = await dialogs.confirm({ message, detail, primary: button, danger: true });
  if (!ok) return;
  closeDiffs(paths);
  await scm.exclusive('Discard', () => discard(repo, paths));
}

async function doCleanAll() {
  const repo = await repoOrThrow();
  await refresh();
  const paths = repo.changes.filter(c => !repo.staged.has(c.path)).map(c => c.path);
  if (!paths.length) { notify.info('There are no changes to discard.', { source: 'Git' }); return; }
  const ok = await dialogs.confirm({
    message: `Are you sure you want to discard ALL changes in ${plural(paths.length, 'file')}?`,
    detail: 'This is IRREVERSIBLE!\nYour current working set will be FOREVER LOST if you proceed.',
    primary: `Discard All ${paths.length} Files`, danger: true
  });
  if (!ok) return;
  closeDiffs(paths);
  await scm.exclusive('Discard', () => discard(repo, paths));
}

async function setStaged(args, staged, { all = false } = {}) {
  const repo = await repoOrThrow();
  await refresh();
  const paths = all ? repo.changes.map(c => c.path) : pathsOf(args).filter(p => repo.status.has(p));
  for (const p of paths) staged ? repo.staged.add(p) : repo.staged.delete(p);
  repo.saveStaged();
  await refresh();
}

// ---------------------------------------------------------------- commands

function registerCommands() {
  const wrap = (what, fn) => async (...args) => { try { return await fn(...args); } catch (err) { report(err, what); return undefined; } };
  const cmd = (id, title, run, extra = {}) => ({ id, title, category: 'Git', run: wrap(extra.what ?? title, run), ...extra });
  commands.registerAll([
    cmd('git.commit', 'Commit', arg => doCommit(arg), { icon: 'check', what: 'Commit' }),
    cmd('git.commitNoPush', 'Commit (Don\'t Push)', () => doCommit({ post: 'none' }), { palette: false }),
    cmd('git.commitPush', 'Commit & Push', () => doCommit({ post: 'push' }), { icon: 'repo-push' }),
    cmd('git.commitSync', 'Commit & Sync', () => doCommit({ post: 'sync' }), { icon: 'sync' }),
    cmd('git.push', 'Push', () => doPush(), { icon: 'repo-push' }),
    cmd('git.pull', 'Pull', () => doPull(), { icon: 'repo-pull' }),
    cmd('git.sync', 'Sync', () => doSync(), { icon: 'sync' }),
    cmd('git.fetch', 'Fetch', async () => {
      const repo = await repoOrThrow();
      const info = await scm.exclusive('Fetch', () => fetchRemoteState(repo));
      notify.info(info.behind ? `origin/${repo.branch} has ${plural(info.behind, 'new commit')}. Pull to get them.` : info.behind === null ? `Fetched origin/${repo.branch}. Pull to merge it into this project.` : `origin/${repo.branch} has no new commits.`, { source: 'Git', actions: info.behind || info.behind === null ? [{ label: 'Pull', run: () => exec('git.pull') }] : [] });
      commitsView?.load(true);
    }, { icon: 'repo-fetch' }),
    cmd('git.clone', 'Clone', (url, branch) => doClone(url, branch), { icon: 'repo-clone' }),
    cmd('git.refresh', 'Refresh', async () => {
      await scm.ready();
      await refresh();
      const repo = scm.repo;
      if (repo?.connected && navigator.onLine !== false) {
        try { await fetchRemoteState(repo); } catch (err) { gitLog.warn(`Fetch failed: ${err.message}`); }
        commitsView?.load(true);
      }
    }, { icon: 'refresh' }),
    cmd('git.checkout', 'Checkout to...', target => doCheckout(target), { icon: 'git-branch' }),
    cmd('git.branch', 'Create Branch...', name => doCreateBranch(name)),
    cmd('git.branchFrom', 'Create Branch From...', () => doCreateBranchFrom()),
    cmd('git.publish', 'Publish to GitHub', () => doPublish(), { icon: 'cloud-upload' }),
    cmd('git.addRemote', 'Connect Existing Repository...', url => doAddRemote(url), { icon: 'plug' }),
    cmd('git.removeRemote', 'Remove Remote', async () => {
      const repo = await repoOrThrow();
      const ok = await dialogs.confirm({ message: `Disconnect this project from ${repo.git.repo}?`, detail: `Your files stay as they are.${repo.ahead ? ` ${plural(repo.ahead, 'local commit')} that ${repo.ahead === 1 ? 'has' : 'have'} not been pushed will be discarded.` : ''} The repository on GitHub is not changed.`, primary: 'Remove Remote', danger: !!repo.ahead });
      if (!ok) return;
      await scm.exclusive('Remove Remote', () => disconnectRepository(repo));
      notify.info('Removed the GitHub remote. Your files were not changed.', { source: 'Git' });
    }),
    cmd('git.openChange', 'Open Changes', (...args) => openChange(...args), { icon: 'git-compare' }),
    cmd('git.openFile', 'Open File', async (...args) => {
      const [path] = pathsOf(args);
      if (!path) return;
      if (!workspace.fs?.isFile(path)) throw new GitError(`${path} does not exist in the working tree.`, { severity: 'info' });
      return editors.open({ type: 'file', path }, { pinned: true });
    }, { icon: 'go-to-file' }),
    cmd('git.clean', 'Discard Changes', (...args) => doClean(...args), { icon: 'discard' }),
    cmd('git.cleanAll', 'Discard All Changes', () => doCleanAll(), { icon: 'discard' }),
    cmd('git.stage', 'Stage Changes', (...args) => setStaged(args, true), { icon: 'add' }),
    cmd('git.stageAll', 'Stage All Changes', () => setStaged([], true, { all: true }), { icon: 'add' }),
    cmd('git.unstage', 'Unstage Changes', (...args) => setStaged(args, false), { icon: 'remove' }),
    cmd('git.unstageAll', 'Unstage All Changes', () => setStaged([], false, { all: true }), { icon: 'remove' }),
    cmd('git.undoCommit', 'Undo Last Commit', async () => {
      const repo = await repoOrThrow();
      const c = await scm.exclusive('Undo Last Commit', () => undoLastCommit(repo));
      if (scmView && !scmView.message().trim()) scmView.setMessage(c.message);
      notify.info(`Undid the commit "${c.message.split('\n')[0]}". Its changes are back in Changes.`, { source: 'Git' });
    }),
    cmd('git.showOutput', 'Show Git Output', () => gitLog.show(), { icon: 'output' }),
    { id: 'github.signIn', title: 'Sign In', category: 'GitHub', icon: 'github', run: wrap('GitHub sign-in', () => auth.signIn()) },
    { id: 'github.signOut', title: 'Sign Out', category: 'GitHub', icon: 'sign-out', when: () => auth.isSignedIn(), run: wrap('GitHub sign-out', async () => {
      const login = auth.user?.login;
      const ok = await dialogs.confirm({ message: `Sign out of GitHub${login ? ` (${login})` : ''}?`, detail: 'X Coder will forget the GitHub token on this device. Your projects and repositories are not changed.', primary: 'Sign Out' });
      if (!ok) return false;
      auth.signOut();
      notify.info('Signed out of GitHub.', { source: 'GitHub' });
      return true;
    }) }
  ]);
}

// ---------------------------------------------------------------- status bar

function registerStatusbar() {
  const branch = statusbar.add({ id: 'status.scm.branch', alignment: 'left', priority: 9000, text: '', command: 'git.checkout', visible: false });
  // On phones the status bar is narrow: the sync item only appears while syncing or when there are
  // incoming/outgoing commits (the Source Control view's button offers Sync as well).
  const sync = statusbar.add({ id: 'status.scm.sync', alignment: 'left', priority: 8990, text: '', command: 'git.sync', visible: false, hideOnPhone: true });
  const update = () => {
    const repo = scm.repo;
    if (!repo?.connected) { branch.hide(); sync.hide(); return; }
    const dirty = repo.changes.length ? '*' : '';
    branch.update({ text: `$(git-branch) ${repo.branch}${dirty}`, tooltip: `${repo.git.repo} (GitHub) — ${repo.branch}${dirty ? ', uncommitted changes' : ''}\nCheckout Branch...`, ariaLabel: `Branch ${repo.branch}` }).show();
    const counts = statusCounts(repo);
    sync.update({ hideOnPhone: !scm.busy && !counts });
    if (scm.busy) sync.update({ text: `$(sync~spin)${counts ? ` ${counts}` : ''}`, tooltip: `${scm.busy.label}…`, command: 'git.showOutput' }).show();
    else if (!repo.git.lastSyncSha && repo.ahead) sync.update({ text: '$(cloud-upload)', tooltip: `Publish Changes to origin/${repo.branch}`, command: 'git.push' }).show();
    else sync.update({ text: `$(sync)${counts ? ` ${counts}` : ''}`, tooltip: counts ? `Synchronize Changes — ${repo.behind || 0} incoming, ${repo.ahead} outgoing commit(s)` : 'Synchronize Changes', command: 'git.sync' }).show();
  };
  scmEvents.on('changed', update);
  scmEvents.on('busy', update);
  update();
}

// ---------------------------------------------------------------- editor title

function registerEditorMenus() {
  // VS Code shows "Open Changes" in the title of a modified file's editor
  menus.append('editor/title', {
    command: 'git.openChange', title: 'Open Changes', icon: 'git-compare', group: 'navigation', order: 30,
    when: ctx => ctx?.type === 'file' && !!ctx.path && scm.repo?.connected === true && scm.repo.status.get(ctx.path) === 'M'
  });
}

// ---------------------------------------------------------------- accounts

function registerAccounts() {
  menus.append('accounts/github', { command: 'github.signOut', title: 'Sign Out', group: '2_signout', order: 1 });
  menus.append('accounts/github', { run: () => window.open(auth.user?.htmlUrl || 'https://github.com', '_blank', 'noopener'), title: 'Open GitHub Profile', group: '1_profile', order: 1 });
  let dispose = null;
  const render = () => {
    dispose?.();
    dispose = auth.isSignedIn()
      ? menus.append('accounts', { submenu: 'accounts/github', title: `${auth.user?.login || 'GitHub account'} (GitHub)`, group: '1_github', order: 1 })
      : menus.append('accounts', { command: 'github.signIn', title: 'Sign in with GitHub to use Source Control', group: '1_github', order: 1 });
  };
  auth.onChange(render);
  render();
}

// ---------------------------------------------------------------- integrations

function registerAutoPush() {
  bus.on('ai:editsApplied', async ev => {
    if (!settings.get('git.autoPushAIEdits', false)) return;
    const repo = scm.repo;
    if (!repo?.connected || !auth.isSignedIn()) return;
    if (ev?.projectId && ev.projectId !== repo.id) return;
    await refresh();
    const wanted = new Set((ev?.paths || []).map(p => posix.clean(p)));
    const changed = repo.changes.filter(c => wanted.has(c.path)).map(c => c.path);
    if (!changed.length) return;
    const summary = String(ev?.summary || 'edits').split('\n')[0].trim().slice(0, 120) || 'edits';
    try {
      await scm.exclusive('Push AI Edits', async () => {
        await commitLocal(repo, `X Coder AI: ${summary}`, { paths: changed, skipSavePrompt: true });
        await pushOutgoing(repo);
      });
      notify.info(`Committed and pushed X Coder AI edits (${plural(changed.length, 'file')}) to ${repo.git.repo}.`, { source: 'Git' });
    } catch (err) {
      if (err instanceof Cancelled) return;
      notify.error(`Auto-push of X Coder AI edits failed: ${err.message || err}`, { source: 'Git', actions: [{ label: 'Push', run: () => exec('git.push') }, { label: 'Show Git Output', run: () => gitLog.show() }] });
    }
  });
}

function registerAutofetch() {
  let last = 0;
  const tick = async (force = false) => {
    const repo = scm.repo;
    if (!settings.get('git.autofetch', true) || !repo?.connected || !auth.isSignedIn() || navigator.onLine === false || scm.busy || document.hidden) return;
    if (!force && Date.now() - last < 170000) return;
    last = Date.now();
    try { await fetchRemoteState(repo); } catch (err) { gitLog.warn(`Autofetch failed: ${err.message}`); }
  };
  bus.on('project:opened', () => { last = 0; scm.ready().then(() => setTimeout(() => tick(true), 1500)); });
  setInterval(() => tick(), 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

async function registerTerminal() {
  try {
    const { terminal } = await import('../panel/api.js');
    registerGitTerminal(terminal);
  } catch (err) { gitLog.warn(`The git terminal command is unavailable: ${err.message || err}`); }
}

export async function activate() {
  registerSettings();
  auth.init();
  initService();
  registerViews();
  registerCommands();
  registerStatusbar();
  registerEditorMenus();
  registerAccounts();
  registerAutoPush();
  registerAutofetch();
  await registerTerminal();
}

