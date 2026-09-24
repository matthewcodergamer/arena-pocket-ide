// `git` for the X Coder terminal (xsh). There is no local .git folder: these subcommands drive the same
// GitHub-backed Source Control as the SCM view (status/diff/log/add/commit/push/pull/fetch/clone/
// branch/checkout/remote/init/restore/reset).

import { posix } from '../core/path.js';
import { settings } from '../core/settings.js';
import { relativeTime } from '../core/dom.js';
import {
  scm, refresh, commitLocal, pushOutgoing, pull, fetchRemoteState, cloneRepository, connectRepository,
  disconnectRepository, checkoutBranch, createBranch, discard, diffText, undoLastCommit, gh, GitError, Cancelled
} from './service.js';
import { auth } from './auth.js';
import { parseRepo, branchNameError } from './util.js';

const HELP = `usage: git <command> [<args>]

X Coder works with GitHub directly (no local .git folder). Supported commands:
  status                 Show changed, staged and untracked files
  diff [<path>]          Show changes as a unified diff
  add <path>… | . | -A   Stage changes
  restore [--staged] <path>…  Discard changes (or unstage with --staged)
  commit -m <message>    Commit staged changes (all changes if none are staged)
  push                   Push local commits to GitHub
  pull                   Pull and merge origin/<branch>
  fetch                  Show incoming commits without applying them
  log [-n <N>]           Show recent commits
  clone <owner/repo|url> [<branch>]   Clone into a new project
  branch [-a] | branch <name>         List or create branches
  checkout [-b] <branch> | switch [-c] <branch>
  remote [-v] | remote add origin <url> | remote remove origin
  reset --soft HEAD~1    Undo the last local (unpushed) commit
  init                   How to publish this project to GitHub`;

/** Resolves user paths (relative to the terminal cwd) to project paths; '.' → cwd prefix. */
function resolvePaths(io, args) {
  return args.map(a => {
    const p = posix.clean(io.resolve(a)).replace(/^\/+/, '');
    return p === '.' ? '' : p;
  });
}
const under = (path, prefix) => !prefix || path === prefix || path.startsWith(prefix + '/');

function statusWord(s) { return s === 'M' ? 'modified:   ' : s === 'D' ? 'deleted:    ' : 'new file:   '; }

async function withRepo(io) {
  await scm.ready();
  const repo = scm.repo;
  if (!repo?.connected) throw new GitError('not a git repository: this project has no GitHub repository connected.\nUse "git clone <owner/repo>", "git remote add origin <url>", or Publish to GitHub in the Source Control view.');
  await refresh();
  return repo;
}

function trackingLine(repo) {
  const upstream = `origin/${repo.branch}`;
  if (!repo.git.lastSyncSha && !repo.ahead) return `Your branch has not been pushed to '${upstream}' yet.`;
  if (repo.ahead && repo.behind) return `Your branch and '${upstream}' have diverged,\nand have ${repo.ahead} and ${repo.behind} different commits each, respectively.`;
  if (repo.ahead) return `Your branch is ahead of '${upstream}' by ${repo.ahead} commit${repo.ahead === 1 ? '' : 's'}.\n  (use "git push" to publish your local commits)`;
  if (repo.behind) return `Your branch is behind '${upstream}' by ${repo.behind} commit${repo.behind === 1 ? '' : 's'}.\n  (use "git pull" to update your local branch)`;
  return `Your branch is up to date with '${upstream}'.`;
}

const commandsMap = {
  async status(io, args) {
    const repo = await withRepo(io);
    const short = args.includes('-s') || args.includes('--short');
    const staged = repo.changes.filter(c => repo.staged.has(c.path));
    const unstaged = repo.changes.filter(c => !repo.staged.has(c.path) && c.status !== 'U');
    const untracked = repo.changes.filter(c => !repo.staged.has(c.path) && c.status === 'U');
    if (short) {
      for (const c of staged) io.println(`${c.status === 'U' ? 'A' : c.status}  ${c.path}`, 'success');
      for (const c of unstaged) io.println(` ${c.status} ${c.path}`, 'error');
      for (const c of untracked) io.println(`?? ${c.path}`, 'error');
      return 0;
    }
    io.println(`On branch ${repo.branch}`);
    io.println(trackingLine(repo));
    if (staged.length) {
      io.println('\nChanges to be committed:\n  (use "git restore --staged <file>..." to unstage)');
      for (const c of staged) io.println(`\t${statusWord(c.status)}${c.path}`, 'success');
    }
    if (unstaged.length) {
      io.println('\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)');
      for (const c of unstaged) io.println(`\t${statusWord(c.status)}${c.path}`, 'error');
    }
    if (untracked.length) {
      io.println('\nUntracked files:\n  (use "git add <file>..." to include in what will be committed)');
      for (const c of untracked) io.println(`\t${c.path}`, 'error');
    }
    if (!repo.changes.length) io.println('\nnothing to commit, working tree clean');
    else if (!staged.length) io.println('\nno changes added to commit (use "git add" and/or "git commit -a")');
    return 0;
  },

  async diff(io, args) {
    const repo = await withRepo(io);
    const paths = resolvePaths(io, args.filter(a => !a.startsWith('-')));
    let text = '';
    if (!paths.length) text = await diffText(repo);
    else for (const p of paths) {
      for (const c of repo.changes.filter(c => under(c.path, p))) text += await diffText(repo, c.path);
    }
    for (const line of text.replace(/\n$/, '').split('\n')) {
      if (!line) { io.println(''); continue; }
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) io.println(line, 'bold');
      else if (line.startsWith('@@')) io.println(line, 'info');
      else if (line.startsWith('+')) io.println(line, 'success');
      else if (line.startsWith('-')) io.println(line, 'error');
      else io.println(line);
    }
    return 0;
  },

  async add(io, args) {
    const repo = await withRepo(io);
    const opts = args.filter(a => a.startsWith('-'));
    let targets = args.filter(a => !a.startsWith('-'));
    if (opts.some(o => o === '-A' || o === '--all')) targets = ['/'];
    if (!targets.length) { io.error('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?'); return 1; }
    const prefixes = targets[0] === '/' ? [''] : resolvePaths(io, targets);
    const paths = repo.changes.filter(c => prefixes.some(p => under(c.path, p))).map(c => c.path);
    if (!paths.length && targets[0] !== '/') {
      const missing = targets.find((t, i) => !repo.fs.exists(prefixes[i]) && !repo.changes.some(c => under(c.path, prefixes[i])));
      if (missing) { io.error(`fatal: pathspec '${missing}' did not match any files`); return 128; }
    }
    for (const p of paths) repo.staged.add(p);
    repo.saveStaged();
    await refresh();
    return 0;
  },

  async restore(io, args) {
    const repo = await withRepo(io);
    const staged = args.includes('--staged') || args.includes('-S');
    const prefixes = resolvePaths(io, args.filter(a => !a.startsWith('-')));
    if (!prefixes.length) { io.error('fatal: you must specify path(s) to restore'); return 128; }
    const paths = repo.changes.filter(c => prefixes.some(p => under(c.path, p)) && (!staged || repo.staged.has(c.path))).map(c => c.path);
    if (staged) { for (const p of paths) repo.staged.delete(p); repo.saveStaged(); await refresh(); return 0; }
    const tracked = paths.filter(p => repo.status.get(p) !== 'U');
    if (!tracked.length) { io.error(`error: pathspec '${args.filter(a => !a.startsWith('-'))[0]}' did not match any file(s) known to git`); return 1; }
    await scm.exclusive('Discard', () => discard(repo, tracked));
    return 0;
  },

  async reset(io, args) {
    const repo = await withRepo(io);
    if (args.includes('--soft') && args.some(a => /^HEAD(~1|\^)$/.test(a))) {
      const c = await scm.exclusive('Undo Last Commit', () => undoLastCommit(repo));
      io.println(`Undid commit "${c.message.split('\n')[0]}" — its changes are back in the working tree.`);
      return 0;
    }
    if (args.includes('--hard')) { io.error('git reset --hard is not supported. Use "git restore <path>" or Discard All Changes in Source Control.'); return 1; }
    const prefixes = resolvePaths(io, args.filter(a => !a.startsWith('-') && a !== 'HEAD'));
    for (const c of repo.changes) if (!prefixes.length || prefixes.some(p => under(c.path, p))) repo.staged.delete(c.path);
    repo.saveStaged();
    await refresh();
    const left = repo.changes.filter(c => c.status !== 'U');
    if (left.length) { io.println('Unstaged changes after reset:'); for (const c of left) io.println(`${c.status}\t${c.path}`); }
    return 0;
  },

  async commit(io, args) {
    const repo = await withRepo(io);
    let message = '';
    let all = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-m' || a === '--message') message += (message ? '\n\n' : '') + (args[++i] ?? '');
      else if (a.startsWith('-m') && a.length > 2) message += (message ? '\n\n' : '') + a.slice(2);
      else if (a.startsWith('--message=')) message += (message ? '\n\n' : '') + a.slice(10);
      else if (a === '-a' || a === '--all') all = true;
      else if (a === '-am') { all = true; message += (message ? '\n\n' : '') + (args[++i] ?? ''); }
    }
    if (!message.trim()) { io.error('Aborting commit due to empty commit message. Use: git commit -m "message"'); return 1; }
    if (!repo.changes.length) { io.println(`On branch ${repo.branch}\nnothing to commit, working tree clean`); return 1; }
    const commit = await scm.exclusive('Commit', () => commitLocal(repo, message, { all, skipSavePrompt: true }));
    const counts = { A: 0, M: 0, D: 0 };
    for (const ch of commit.changes) counts[ch.status]++;
    io.println(`[${repo.branch} ${commit.id.slice(-7)}] ${message.split('\n')[0]}`);
    io.println(` ${commit.changes.length} file${commit.changes.length === 1 ? '' : 's'} changed${counts.A ? `, ${counts.A} added` : ''}${counts.D ? `, ${counts.D} deleted` : ''}`);
    const post = settings.get('git.postCommitCommand', 'push');
    if (post === 'none') { io.println('Committed locally. Run "git push" to publish it to GitHub.', 'muted'); return 0; }
    io.println(`X Coder ${post === 'sync' ? 'syncs' : 'pushes'} right after committing (setting git.postCommitCommand = "${post}").`, 'muted');
    if (post === 'sync') await commandsMap.pull(io, []);
    return commandsMap.push(io, []);
  },

  async push(io) {
    const repo = await withRepo(io);
    if (!repo.ahead) { io.println('Everything up-to-date'); return 0; }
    const before = repo.git.lastSyncSha;
    const res = await scm.exclusive('Push', () => pushOutgoing(repo));
    io.println(`To https://github.com/${repo.git.repo}.git`);
    io.println(`   ${before ? before.slice(0, 7) : '[new branch]'}..${res.sha.slice(0, 7)}  ${repo.branch} -> ${repo.branch}`, 'success');
    return 0;
  },

  async pull(io) {
    const repo = await withRepo(io);
    const before = repo.git.lastSyncSha;
    const res = await scm.exclusive('Pull', () => pull(repo));
    if (res.upToDate) { io.println(res.empty ? 'The remote repository is empty.' : 'Already up to date.'); return 0; }
    io.println(`From https://github.com/${repo.git.repo}`);
    io.println(`Updating ${before ? before.slice(0, 7) : '(none)'}..${(repo.git.lastSyncSha || '').slice(0, 7)}`);
    io.println(` ${res.updated} file${res.updated === 1 ? '' : 's'} updated, ${res.deleted} deleted${res.overwritten ? `, ${res.overwritten} local change(s) overwritten` : ''}`, 'success');
    for (const s of res.skipped || []) io.println(`warning: skipped ${s.path} (${s.reason})`, 'warning');
    return 0;
  },

  async fetch(io) {
    const repo = await withRepo(io);
    const info = await scm.exclusive('Fetch', () => fetchRemoteState(repo));
    if (info.empty) { io.println('The remote repository is empty.'); return 0; }
    if (info.missingBranch) { io.println(`origin/${repo.branch} does not exist yet (push to create it).`); return 0; }
    if (!info.behind) { io.println(info.behind === null ? `origin/${repo.branch} is at ${info.head.slice(0, 7)} (this project has not been synced yet — run git pull).` : 'Already up to date with origin.'); return 0; }
    io.println(`From https://github.com/${repo.git.repo}`);
    io.println(`   ${(repo.git.lastSyncSha || '').slice(0, 7)}..${info.head.slice(0, 7)}  ${repo.branch} -> origin/${repo.branch}`);
    io.println(`${info.behind} incoming commit${info.behind === 1 ? '' : 's'}:`, 'bold');
    for (const c of info.commits.slice(-20).reverse()) io.println(`  ${c.sha.slice(0, 7)} ${String(c.commit?.message || '').split('\n')[0]}`, 'info');
    if (info.files.length) { io.println('Files changed on GitHub:'); for (const f of info.files.slice(0, 50)) io.println(`  ${f.status.padEnd(9)} ${f.path}`); }
    io.println('Run "git pull" to apply them.', 'muted');
    return 0;
  },

  async log(io, args) {
    const repo = await withRepo(io);
    let n = 10;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') n = Number(args[++i]) || n;
      else if (/^-\d+$/.test(args[i])) n = Number(args[i].slice(1));
      else if (args[i].startsWith('--max-count=')) n = Number(args[i].slice(12)) || n;
    }
    const oneline = args.includes('--oneline');
    let shown = 0;
    for (const c of [...repo.git.outgoing].reverse()) {
      if (shown++ >= n) return 0;
      if (oneline) { io.println(`${'local'.padEnd(7)} ${c.message.split('\n')[0]} (not pushed)`, 'warning'); continue; }
      io.println(`commit (local, not pushed) ${c.id}`, 'warning');
      io.println(`Author: ${c.author || auth.user?.login || 'you'}\nDate:   ${new Date(c.time).toString()}\n\n    ${c.message.split('\n').join('\n    ')}\n`);
    }
    let list = [];
    try { list = await gh.commits(repo.owner, repo.name, repo.branch, Math.min(100, n)); }
    catch (err) { if (err.status === 409) { if (!shown) io.println('The remote repository has no commits yet.'); return 0; } throw err; }
    for (const c of list) {
      if (shown++ >= n) break;
      const msg = c.commit?.message || '';
      if (oneline) { io.println(`${c.sha.slice(0, 7)} ${msg.split('\n')[0]}`, c.sha === repo.git.lastSyncSha ? 'success' : undefined); continue; }
      io.println(`commit ${c.sha}${c.sha === repo.git.lastSyncSha ? ` (origin/${repo.branch}, HEAD)` : ''}`, 'warning');
      const date = c.commit?.author?.date ? new Date(c.commit.author.date) : null;
      io.println(`Author: ${c.commit?.author?.name || c.author?.login || ''} <${c.commit?.author?.email || ''}>\nDate:   ${date ? `${date.toString()} (${relativeTime(date.getTime())})` : ''}\n\n    ${msg.split('\n').join('\n    ')}\n`);
    }
    return 0;
  },

  async clone(io, args) {
    const rest = [];
    let branch;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-b' || args[i] === '--branch') branch = args[++i];
      else if (!args[i].startsWith('-')) rest.push(args[i]);
    }
    const parsed = parseRepo(rest[0]);
    if (!parsed) { io.error(`fatal: '${rest[0] || ''}' is not a GitHub repository. Use owner/repo or https://github.com/owner/repo`); return 128; }
    branch = branch || rest[1] || parsed.branch;
    io.println(`Cloning into '${parsed.repo}'...`);
    let last = 0;
    const res = await scm.exclusive(`Clone ${parsed.full}`, () => cloneRepository(parsed, {
      branch, onProgress: (d, t) => { if (d === t || Date.now() - last > 700) { last = Date.now(); io.println(`Receiving objects: ${Math.round((d / t) * 100)}% (${d}/${t})`, 'muted'); } }
    }));
    io.println(`${res.empty ? 'warning: You appear to have cloned an empty repository.\n' : ''}Opened project '${res.project.name}' (${res.full}@${res.branch}, ${res.files} files).`, 'success');
    for (const s of res.skipped) io.println(`warning: skipped ${s.path} (${s.reason})`, 'warning');
    return 0;
  },

  async branch(io, args) {
    const repo = await withRepo(io);
    const names = args.filter(a => !a.startsWith('-'));
    if (args.includes('-d') || args.includes('-D') || args.includes('--delete')) { io.error('Deleting branches is not supported here — delete them on github.com.'); return 1; }
    if (names.length) {
      const err = branchNameError(names[0]);
      if (err) { io.error(`fatal: '${names[0]}' is not a valid branch name. ${err}`); return 128; }
      if (!auth.isSignedIn() && repo.git.lastSyncSha) { io.error('fatal: sign in to GitHub to create branches (Accounts → Sign in with GitHub).'); return 128; }
      await scm.exclusive('Create Branch', () => createBranch(repo, names[0]));
      io.println(`Switched to a new branch '${names[0]}'`);
      return 0;
    }
    let list = [];
    try { list = await gh.branches(repo.owner, repo.name); } catch (err) { if (err.status !== 409) throw err; }
    const all = new Set(list.map(b => b.name));
    all.add(repo.branch);
    for (const b of [...all].sort()) io.println(b === repo.branch ? `* ${b}` : `  ${b}`, b === repo.branch ? 'success' : undefined);
    if (args.includes('-a') || args.includes('-r')) for (const b of list) io.println(`  remotes/origin/${b.name}`, 'error');
    return 0;
  },

  async checkout(io, args) {
    const repo = await withRepo(io);
    const create = args.includes('-b') || args.includes('-c') || args.includes('-B');
    const name = args.filter(a => !a.startsWith('-'))[0];
    if (!name) { io.error('fatal: you must specify a branch'); return 128; }
    if (create) return commandsMap.branch(io, [name]);
    if (name === repo.branch) { io.println(`Already on '${name}'`); return 0; }
    if (repo.changes.length || repo.ahead) {
      io.error(`error: Your local changes${repo.ahead ? ` and ${repo.ahead} unpushed commit(s)` : ''} would be overwritten by checkout:`);
      for (const c of repo.changes.slice(0, 20)) io.error(`\t${c.path}`);
      io.error('Please commit your changes (git commit && git push) or discard them (git restore) before you switch branches.\nAborting');
      return 1;
    }
    await scm.exclusive(`Checkout ${name}`, () => checkoutBranch(repo, name));
    io.println(`Switched to branch '${name}'\nYour branch is up to date with 'origin/${name}'.`);
    return 0;
  },

  async remote(io, args) {
    await scm.ready();
    const repo = scm.repo;
    const sub = args[0];
    if (sub === 'add') {
      const url = args[2] || args[1];
      const parsed = parseRepo(url);
      if (!parsed) { io.error(`fatal: '${url || ''}' is not a GitHub repository URL`); return 128; }
      if (repo.connected) { io.error(`error: remote origin already exists (${repo.git.repo}). Use "git remote remove origin" first.`); return 3; }
      try {
        const res = await scm.exclusive('Connect Repository', () => connectRepository(repo, parsed));
        io.println(`Connected to ${res.full} (branch ${res.branch}).${res.merged ? ` Merged ${res.updated} file(s) from GitHub.` : res.empty ? ' The repository is empty — commit and push to publish your files.' : ''}`, 'success');
      } catch (err) {
        if (err instanceof Cancelled) { io.println('Connected. Pull when you are ready to merge the files from GitHub (git pull).', 'warning'); return 0; }
        throw err;
      }
      return 0;
    }
    if (sub === 'remove' || sub === 'rm') {
      if (!repo?.connected) { io.error("error: No such remote: 'origin'"); return 2; }
      await scm.exclusive('Disconnect Repository', () => disconnectRepository(repo));
      io.println('Removed remote origin. Your files were not changed.');
      return 0;
    }
    if (!repo?.connected) return 0;
    if (args.includes('-v')) {
      io.println(`origin\thttps://github.com/${repo.git.repo}.git (fetch)`);
      io.println(`origin\thttps://github.com/${repo.git.repo}.git (push)`);
    } else io.println('origin');
    return 0;
  },

  async init(io) {
    await scm.ready();
    const repo = scm.repo;
    if (repo?.connected) { io.println(`This project is already connected to https://github.com/${repo.git.repo} (branch ${repo.branch}).`); return 0; }
    io.println('X Coder has no local .git folder — Source Control works directly with GitHub.');
    io.println('To start tracking this project:');
    io.println('  • Source Control view → Publish to GitHub (creates a new repository), or');
    io.println('  • git remote add origin https://github.com/<owner>/<repo>   (connect an existing one)');
    return 0;
  }
};
commandsMap.switch = (io, args) => commandsMap.checkout(io, args.map(a => (a === '-c' ? '-b' : a)));

export async function gitCommand(args, io) {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { io.println(HELP); return 0; }
  if (sub === '--version' || sub === 'version') { io.println('git version 2 (X Coder GitHub bridge — no local git binary)'); return 0; }
  const fn = commandsMap[sub];
  if (!fn) {
    io.error(`git: '${sub}' is not supported in X Coder. See 'git help'.`);
    return 1;
  }
  try {
    const code = await fn(io, rest);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    if (err instanceof Cancelled) { io.error(err.message && err.message !== 'Cancelled' ? err.message : 'Aborted.'); return 1; }
    io.error(`fatal: ${err?.message || err}`);
    return 1;
  }
}

export function registerGitTerminal(terminal) {
  return terminal.registerCommand('git', {
    description: 'Git for GitHub repositories (Source Control)',
    usage: 'git <command> [<args>]',
    category: 'Source Control',
    run: (args, io) => gitCommand(args, io)
  });
}

