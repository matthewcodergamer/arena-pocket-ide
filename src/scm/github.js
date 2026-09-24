// GitHub REST client (api.github.com) for Source Control: users, repositories, branches, refs,
// recursive trees, blobs, trees, commits, the Contents API (first commit in an empty repository),
// commit lists and compares. Every request is logged to the "Git" output channel — never the token.
// Errors are GitHubError with a friendly, actionable message (401/403/404/409/422/5xx/offline).

import { output } from '../core/output.js';
import { base64ToBytes, bytesToBase64 } from './util.js';

export const gitLog = output.channel('Git');
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status = 0, code = '', githubMessage = '', resetAt = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.githubMessage = githubMessage;
    this.resetAt = resetAt;
  }
}

const seg = s => String(s).split('/').map(encodeURIComponent).join('/');

function friendly(status, ghMessage, headers, { hasToken, context }) {
  const msg = ghMessage ? `: ${ghMessage}` : '';
  switch (status) {
    case 401:
      return hasToken
        ? 'GitHub rejected your sign-in (401 Bad credentials). The token may be expired or revoked — sign in to GitHub again.'
        : 'GitHub requires you to sign in for this request (401). Use Accounts → Sign in with GitHub.';
    case 403: {
      const remaining = headers.get('x-ratelimit-remaining');
      if (remaining === '0' || /rate limit/i.test(ghMessage)) {
        const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
        const when = reset ? new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon';
        return `GitHub API rate limit exceeded. It resets at ${when}.${hasToken ? '' : ' Sign in to GitHub for a much higher limit.'}`;
      }
      return `GitHub denied access (403)${msg}. Make sure the token has Repository permissions "Contents: Read and write" and "Metadata: Read" for this repository${context === 'createRepo' ? ' (creating repositories also needs "Administration: Read and write")' : ''}.`;
    }
    case 404:
      if (context === 'ref') return 'Branch not found on GitHub (404).';
      return `Not found (404): the repository doesn't exist, or ${hasToken ? 'your GitHub token has no access to it' : 'it is private — sign in to GitHub to access private repositories'}.`;
    case 409: return 'The repository is empty (409).';
    case 422:
      if (context === 'updateRef') return 'The remote has new commits. Pull first.';
      if (context === 'createRef' && /already exists/i.test(ghMessage)) return 'A branch with that name already exists on GitHub.';
      if (context === 'createRepo' && /already exists/i.test(ghMessage)) return 'A repository with that name already exists on your GitHub account.';
      return `GitHub could not process the request (422)${msg}.`;
    default:
      if (status >= 500) return `GitHub is having problems right now (${status}). Try again in a moment.`;
      return `GitHub request failed (${status})${msg}.`;
  }
}

export class GitHubClient {
  /** getToken: () => string | null */
  constructor(getToken = () => null) { this.getToken = getToken; }

  async request(method, path, { body, token, context = '', signal, raw = false } = {}) {
    const auth = token ?? this.getToken();
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const started = performance.now();
    const shown = path.split('?')[0];
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store', signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      gitLog.error(`${method} ${shown} failed: ${err?.message || err}`);
      throw new GitHubError(navigator.onLine === false ? 'You are offline. Connect to the internet to reach GitHub.' : 'Could not reach GitHub (api.github.com). Check your internet connection.', { status: 0, code: 'network' });
    }
    const ms = Math.round(performance.now() - started);
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const ghMessage = (data && typeof data === 'object' ? data.message : '') || '';
      const detail = data?.errors?.map?.(e => e.message || e.code).filter(Boolean).join('; ');
      const message = friendly(res.status, [ghMessage, detail].filter(Boolean).join(' — '), res.headers, { hasToken: !!auth, context });
      gitLog.warn(`${method} ${shown} → ${res.status} ${ghMessage} (${ms} ms)`);
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || null;
      throw new GitHubError(message, { status: res.status, code: context, githubMessage: ghMessage, resetAt: reset });
    }
    gitLog.info(`${method} ${shown} → ${res.status} (${ms} ms)`);
    return raw ? { data, headers: res.headers } : data;
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, body, opts) { return this.request('POST', path, { ...opts, body }); }
  patch(path, body, opts) { return this.request('PATCH', path, { ...opts, body }); }
  put(path, body, opts) { return this.request('PUT', path, { ...opts, body }); }

  // ---- users & repositories
  user(token) { return this.get('/user', { token }); }
  repo(owner, repo) { return this.get(`/repos/${seg(owner)}/${seg(repo)}`); }
  userRepos() { return this.get('/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator,organization_member'); }
  createRepo({ name, private: isPrivate = true, description = '' }) {
    return this.post('/user/repos', { name, private: !!isPrivate, description, auto_init: false }, { context: 'createRepo' });
  }

  // ---- branches & refs
  async branches(owner, repo) {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const list = await this.get(`/repos/${seg(owner)}/${seg(repo)}/branches?per_page=100&page=${page}`);
      if (!Array.isArray(list)) break;
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }
  /** Head commit SHA of a branch. Throws GitHubError 404 (no such branch) / 409 (empty repository). */
  async headOf(owner, repo, branch) {
    const ref = await this.get(`/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${seg(branch)}`, { context: 'ref' });
    if (Array.isArray(ref)) throw new GitHubError('Branch not found on GitHub (404).', { status: 404, code: 'ref' }); // prefix matches only
    return ref?.object?.sha;
  }
  createRef(owner, repo, branch, sha) { return this.post(`/repos/${seg(owner)}/${seg(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha }, { context: 'createRef' }); }
  updateRef(owner, repo, branch, sha, force = false) { return this.patch(`/repos/${seg(owner)}/${seg(repo)}/git/refs/heads/${seg(branch)}`, { sha, force }, { context: 'updateRef' }); }

  // ---- git data
  commit(owner, repo, sha) { return this.get(`/repos/${seg(owner)}/${seg(repo)}/git/commits/${sha}`); }
  tree(owner, repo, sha) { return this.get(`/repos/${seg(owner)}/${seg(repo)}/git/trees/${sha}?recursive=1`); }
  async blobBytes(owner, repo, sha) {
    const b = await this.get(`/repos/${seg(owner)}/${seg(repo)}/git/blobs/${sha}`);
    if (b?.encoding === 'base64') return base64ToBytes(b.content || '');
    return new TextEncoder().encode(b?.content || '');
  }
  async createBlob(owner, repo, bytes) {
    const b = await this.post(`/repos/${seg(owner)}/${seg(repo)}/git/blobs`, { content: bytesToBase64(bytes), encoding: 'base64' });
    return b.sha;
  }
  createTree(owner, repo, { base_tree, tree }) { return this.post(`/repos/${seg(owner)}/${seg(repo)}/git/trees`, base_tree ? { base_tree, tree } : { tree }); }
  createCommit(owner, repo, { message, tree, parents }) { return this.post(`/repos/${seg(owner)}/${seg(repo)}/git/commits`, { message, tree, parents }); }
  /** Contents API: the only way to create the first commit in an empty repository. */
  putContents(owner, repo, path, { message, bytes, branch }) {
    return this.put(`/repos/${seg(owner)}/${seg(repo)}/contents/${seg(path)}`, { message, content: bytesToBase64(bytes), branch });
  }

  // ---- history
  commits(owner, repo, branch, perPage = 30) { return this.get(`/repos/${seg(owner)}/${seg(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`); }
  compare(owner, repo, base, head) { return this.get(`/repos/${seg(owner)}/${seg(repo)}/compare/${base}...${head}`); }
}
