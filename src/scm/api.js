// Git / GitHub API used by other features (AI agent, terminal, explorer decorations).
// STUB — replaced by the Source Control implementation (src/scm/). Keep every export name and signature.
export const git = {
  /** Is a GitHub repository connected to this project? */
  isConnected() { return false; },
  /** { repo: 'owner/name', branch } or null */
  remote() { return null; },
  /** Changed files vs. the last pull/push: [{ path, status: 'M' | 'A' | 'D' }] */
  async getChanges() { return []; },
  /** Status for one path ('M' | 'A' | 'D' | null) — synchronous, from the last computed state. */
  statusOf(path) { return null; },
  /** Base (last pulled/pushed) text of a file, or null. */
  async getBaseText(path) { return null; },
  /** Unified diff for one path or all changes. */
  async getDiff(path) { return ''; },
  async commitAndPush(message, { paths } = {}) { throw new Error('Source Control is not available'); },
  async pull() { throw new Error('Source Control is not available'); }
};
