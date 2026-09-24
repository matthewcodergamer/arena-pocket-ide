// Git / GitHub API used by other features (AI agent, terminal, explorer decorations).
// Implemented by Source Control (src/scm/). Statuses: 'M' modified, 'U' untracked (new file),
// 'A' new file that is staged, 'D' deleted — like VS Code's Source Control view.
import { scm, refresh, commitLocal, pushOutgoing, pull as pullRemote, diffText, baseText, requireRepo } from './service.js';

export const git = {
  /** Is a GitHub repository connected to this project? */
  isConnected() { return !!scm.repo?.connected; },
  /** { repo: 'owner/name', branch, ahead, behind, lastSyncAt } or null */
  remote() {
    const r = scm.repo;
    if (!r?.connected) return null;
    return { repo: r.git.repo, branch: r.branch, ahead: r.ahead, behind: r.behind, lastSyncAt: r.git.lastSyncAt };
  },
  /** Changed files vs. the last commit: [{ path, status: 'M' | 'U' | 'A' | 'D', staged }] */
  async getChanges() {
    await scm.ready();
    const r = scm.repo;
    if (!r?.connected) return [];
    await refresh();
    return r.changes.map(c => ({ path: c.path, status: c.status === 'U' && r.staged.has(c.path) ? 'A' : c.status, staged: r.staged.has(c.path) }));
  },
  /** Status for one path ('M' | 'U' | 'A' | 'D' | null) — synchronous, from the last computed state. */
  statusOf(path) {
    const r = scm.repo;
    if (!r?.connected) return null;
    const s = r.status.get(path) || null;
    return s === 'U' && r.staged.has(path) ? 'A' : s;
  },
  /** Base (last commit / last pull) text of a file, or null (new, binary, or unavailable). */
  async getBaseText(path) {
    await scm.ready();
    const r = scm.repo;
    if (!r?.connected) return null;
    return baseText(r, path);
  },
  /** Unified diff ("git diff" format) for one path or all changes. */
  async getDiff(path) {
    await scm.ready();
    const r = scm.repo;
    if (!r?.connected) return '';
    return diffText(r, path || undefined);
  },
  /** Commits (all changes, or `paths`) and pushes to GitHub. Returns { commit, pushed, sha }. */
  async commitAndPush(message, { paths } = {}) {
    await scm.ready();
    return scm.exclusive('Commit & Push', async () => {
      const r = requireRepo(scm.repo);
      const commit = await commitLocal(r, message, { paths: paths?.length ? paths : null, all: !paths?.length, skipSavePrompt: true });
      const res = await pushOutgoing(r);
      return { commit: { id: commit.id, message: commit.message, files: commit.changes.map(c => c.path) }, pushed: res.pushed, sha: res.sha };
    });
  },
  /** Pulls origin/<branch> into the project. Returns { updated, deleted, skipped } or { upToDate: true }. */
  async pull() {
    await scm.ready();
    return scm.exclusive('Pull', () => pullRemote(requireRepo(scm.repo)));
  }
};
