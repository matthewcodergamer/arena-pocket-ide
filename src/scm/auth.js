// GitHub authentication for Source Control:
//   • Personal access token (fine-grained) entered in a password input box, validated with GET /user;
//   • GitHub Device Flow through the X Coder Worker when its /health reports capabilities.githubDeviceFlow.
// Token storage follows `git.rememberToken`: off → sessionStorage "githubToken" (the X Coder ≤5 key),
// on → localStorage "xcoder.github.token". The token is only ever sent to api.github.com (and, during
// the device flow, received from the X Coder Worker). It never goes into settings, logs, project files or AI prompts.

import { h, copyText } from '../core/dom.js';
import { Emitter } from '../core/events.js';
import { settings } from '../core/settings.js';
import { quickInput } from '../platform/quickinput.js';
import { notify } from '../platform/notifications.js';
import { GitHubClient, GitHubError, gitLog } from './github.js';
import { modal } from './ui.js';

const SESSION_KEY = 'githubToken';
const LOCAL_KEY = 'xcoder.github.token';
const USER_KEY = 'xcoder.github.user';
export const DEFAULT_ROUTER = 'https://arena-pocket-ide-proxy.hrhw55tdmw.workers.dev';
export const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

const events = new Emitter(); // 'changed' (user | null)
let token = null;
let user = null;

function store(remember) { return remember ? localStorage : sessionStorage; }
function safe(fn, fallback = null) { try { return fn(); } catch { return fallback; } }

function load() {
  const remember = !!settings.get('git.rememberToken', false);
  const local = safe(() => localStorage.getItem(LOCAL_KEY));
  const session = safe(() => sessionStorage.getItem(SESSION_KEY));
  token = (remember ? local || session : session || local) || null;
  // keep the token where the setting says it belongs
  if (token) persist(token, remember);
  const rawUser = safe(() => store(remember).getItem(USER_KEY)) || safe(() => (remember ? sessionStorage : localStorage).getItem(USER_KEY));
  user = token ? safe(() => JSON.parse(rawUser || 'null')) : null;
}

function persist(value, remember = !!settings.get('git.rememberToken', false)) {
  safe(() => { localStorage.removeItem(LOCAL_KEY); sessionStorage.removeItem(SESSION_KEY); });
  const u = safe(() => localStorage.getItem(USER_KEY)) || safe(() => sessionStorage.getItem(USER_KEY));
  safe(() => { localStorage.removeItem(USER_KEY); sessionStorage.removeItem(USER_KEY); });
  if (!value) return;
  safe(() => store(remember).setItem(remember ? LOCAL_KEY : SESSION_KEY, value));
  if (u) safe(() => store(remember).setItem(USER_KEY, u));
}

function setSession(newToken, newUser) {
  token = newToken || null;
  user = newToken ? newUser : null;
  persist(token);
  if (user) safe(() => store(!!settings.get('git.rememberToken', false)).setItem(USER_KEY, JSON.stringify(user)));
  events.emit('changed', user);
}

const userInfo = u => ({ login: u.login, name: u.name || '', avatarUrl: u.avatar_url || '', htmlUrl: u.html_url || `https://github.com/${u.login}` });

export function routerUrl() {
  return String(settings.get('xcoder.ai.routerUrl', DEFAULT_ROUTER) || DEFAULT_ROUTER).trim().replace(/\/+$/, '');
}

async function fetchJSON(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data?.error) throw new Error(data?.message || `HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

export const auth = {
  events,
  init() {
    load();
    settings.onChange('git.rememberToken', v => { if (token) { persist(token, !!v); if (user) safe(() => store(!!v).setItem(USER_KEY, JSON.stringify(user))); } });
    // refresh the cached profile (and notice revoked tokens) in the background
    if (token && navigator.onLine !== false) {
      new GitHubClient(() => token).user().then(u => { user = userInfo(u); setSession(token, user); }).catch(err => {
        if (err instanceof GitHubError && err.status === 401) {
          setSession(null, null);
          notify.warn('Your GitHub sign-in has expired or was revoked. Sign in again to use Source Control.', { source: 'GitHub', actions: [{ label: 'Sign in with GitHub', run: () => this.signIn() }] });
        }
      });
    }
  },
  token: () => token,
  get user() { return user; },
  isSignedIn: () => !!token,
  onChange(fn) { return events.on('changed', fn); },

  /** Validates a token with GET /user and signs in. Returns the user. */
  async signInWithToken(value) {
    const t = String(value || '').trim();
    if (!t) throw new Error('No token was provided.');
    const u = await new GitHubClient(() => t).user(t);
    setSession(t, userInfo(u));
    gitLog.info(`Signed in to GitHub as ${u.login}`);
    return user;
  },

  signOut() {
    const was = user?.login;
    setSession(null, null);
    gitLog.info(`Signed out of GitHub${was ? ` (${was})` : ''}`);
  },

  /** Does the configured X Coder Worker offer the GitHub Device Flow? */
  async deviceFlowAvailable() {
    const base = routerUrl();
    if (!base) return false;
    try { const health = await fetchJSON(`${base}/health`, {}, 5000); return health?.capabilities?.githubDeviceFlow === true; }
    catch { return false; }
  },

  /** Interactive sign-in (quick pick → token or device flow). Resolves with the user or null. */
  async signIn() {
    let checking = null; // one /health request per sign-in (the provider runs on every keystroke)
    const items = async () => {
      const device = await (checking ||= this.deviceFlowAvailable());
      const tokenItem = { id: 'token', label: 'Sign in with a Personal Access Token', description: 'Fine-grained token', detail: 'Create a token on github.com with Contents: Read and write access, then paste it here.', icon: 'key' };
      return device
        ? [{ id: 'device', label: 'Sign in with GitHub in the Browser', description: 'Device code', detail: 'Enter a one-time code on github.com — no token to copy.', icon: 'github' }, tokenItem]
        : [tokenItem, { id: 'device-off', label: 'Sign in with GitHub in the Browser', description: 'Unavailable', detail: 'The X Coder Worker (xcoder.ai.routerUrl) does not offer GitHub sign-in yet.', icon: 'github', disabled: true }];
    };
    const choice = await quickInput.pick(items, { title: 'Sign in with GitHub', placeholder: 'Select how to sign in to GitHub', filter: false });
    if (!choice) return null;
    try {
      return choice.id === 'device' ? await this.deviceFlow() : await this.tokenFlow();
    } catch (err) {
      notify.error(`GitHub sign-in failed: ${err.message || err}`, { source: 'GitHub' });
      return null;
    }
  },

  async tokenFlow() {
    const steps = h('ol', { class: 'scm-auth-steps' },
      h('li', {}, 'Open ', h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener' }, 'github.com → Settings → Fine-grained tokens'), '.'),
      h('li', {}, 'Choose the repositories X Coder may use (or "All repositories").'),
      h('li', {}, 'Repository permissions: ', h('b', {}, 'Contents: Read and write'), ' and ', h('b', {}, 'Metadata: Read'), '. Add ', h('b', {}, 'Administration: Read and write'), ' to publish new repositories.'),
      h('li', {}, 'Generate the token, copy it, and paste it in the next step.'));
    const note = h('p', { class: 'scm-auth-note' }, 'The token is stored only in this browser and is sent only to api.github.com. ',
      settings.get('git.rememberToken', false) ? 'It stays after X Coder closes (git.rememberToken is on).' : 'It is forgotten when this browser session ends — turn on "Git: Remember Token" in Settings to keep it.');
    const go = await modal({
      type: 'info', message: 'Sign in with a GitHub personal access token', body: [steps, note], cancelValue: 'cancel', className: 'scm-auth-dialog',
      buttons: [
        { label: 'Create Token on GitHub', value: 'create', run: () => { window.open(TOKEN_URL, '_blank', 'noopener'); } },
        { label: 'Enter Token', primary: true, value: 'enter' },
        { label: 'Cancel', value: 'cancel' }
      ]
    });
    if (go === 'cancel' || go === undefined) return null;
    let validated = null;
    const value = await quickInput.input({
      title: 'Sign in with GitHub', password: true,
      placeholder: 'Paste your GitHub personal access token (github_pat_… or ghp_…)',
      prompt: 'Press Enter to verify the token with GitHub.',
      validate: v => (!v.trim() ? 'A token is required' : /\s/.test(v.trim()) ? 'Tokens do not contain spaces' : null)
    });
    if (!value) return null;
    const progress = notify.progress('Verifying your GitHub token…', { source: 'GitHub' });
    try { validated = await this.signInWithToken(value); }
    finally { progress.close(); }
    notify.info(`Signed in to GitHub as ${validated.login}.`, { source: 'GitHub' });
    return validated;
  },

  async deviceFlow() {
    const base = routerUrl();
    const start = await fetchJSON(`${base}/github/device/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 15000);
    if (!start?.device_code || !start?.user_code) throw new Error(start?.error_description || start?.error || 'The X Coder Worker did not return a device code.');
    const verifyUrl = start.verification_uri || 'https://github.com/login/device';
    const expiresAt = Date.now() + (Number(start.expires_in) || 900) * 1000;
    let interval = Math.max(1, Number(start.interval) || 5) * 1000; // GitHub sends 5 s
    const code = h('div', { class: 'scm-device-code', 'aria-label': 'One-time code' }, start.user_code);
    const status = h('p', { class: 'scm-auth-note' }, 'Waiting for you to authorize X Coder on GitHub…');
    const dlg = modal({
      type: 'info', message: 'Sign in with GitHub', className: 'scm-auth-dialog', handle: true, cancelValue: 'cancel',
      body: [h('p', {}, 'Copy this one-time code, open GitHub, paste the code and authorize X Coder.'), code, status],
      buttons: [
        { label: 'Copy Code & Open GitHub', primary: true, keepOpen: true, run: () => { copyText(start.user_code); window.open(verifyUrl, '_blank', 'noopener'); status.textContent = 'Code copied. Authorize X Coder on GitHub, then come back here…'; } },
        { label: 'Cancel', value: 'cancel' }
      ]
    });
    let cancelled = false;
    dlg.promise.then(v => { if (v === 'cancel') cancelled = true; });
    try {
      while (!cancelled) {
        if (Date.now() > expiresAt) throw new Error('The code expired. Start the sign-in again.');
        await new Promise(r => setTimeout(r, interval));
        if (cancelled) break;
        let res;
        try { res = await fetchJSON(`${base}/github/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: start.device_code }) }, 15000); }
        catch (err) { gitLog.warn(`Device flow poll failed: ${err.message}`); continue; }
        if (res?.access_token) {
          const u = await this.signInWithToken(res.access_token);
          dlg.close('done');
          notify.info(`Signed in to GitHub as ${u.login}.`, { source: 'GitHub' });
          return u;
        }
        if (res?.error === 'slow_down') interval += 5000;
        else if (res?.error === 'expired_token') throw new Error('The code expired. Start the sign-in again.');
        else if (res?.error === 'access_denied') throw new Error('Authorization was denied on GitHub.');
        else if (res?.error && res.error !== 'authorization_pending') throw new Error(res.error_description || res.error);
      }
      return null;
    } finally { dlg.close('cancel'); }
  }
};
