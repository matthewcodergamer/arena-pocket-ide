// Accounts & X Coder Cloud (feature entry). X Coder Cloud keeps copies of your projects in your Puter
// account (sign-in and storage are provided by Puter, https://puter.com): Sync Current Project,
// Open Cloud Project…, Delete Cloud Project…, Sign In / Sign Out, a "Synced 2 mins ago" status bar item,
// optional auto sync 30 s after the last change (xcoder.cloud.autoSync), and xcoder.showInstallHelp.

import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { workspace } from '../core/workspace.js';
import { ProjectFS } from '../core/fs.js';
import { idbPut } from '../core/db.js';
import { output } from '../core/output.js';
import { getPuter, puterSignedIn } from '../core/puter.js';
import { h, debounce, relativeTime, uid } from '../core/dom.js';
import { quickInput } from '../platform/quickinput.js';
import { notify } from '../platform/notifications.js';
import { dialogs } from '../platform/dialogs.js';
import { statusbar } from '../workbench/statusbar.js';
import { modal } from '../scm/ui.js';
import { syncProject, listProjects, downloadProject, deleteProject, readManifest, errorText } from './store.js';
import { captureInstallPrompt, showInstallHelp } from './install.js';

const log = output.channel('X Coder Cloud');
const USER_KEY = 'xcoder.cloud.user';
const DEVICE_KEY = 'xcoder.cloud.device';
const NEEDS_PUTER = 'X Coder Cloud needs a connection to js.puter.com.';

let user = null;           // { username }
let syncing = false;
let statusItem = null;
let accountsDispose = null;

const safeLS = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
};
function deviceId() {
  let id = safeLS.get(DEVICE_KEY);
  if (!id) { id = uid('device'); safeLS.set(DEVICE_KEY, id); }
  return id;
}
class CloudError extends Error {}
class Cancelled extends Error {}

function setUser(u) {
  user = u ? { username: u.username || u.email || 'Puter account' } : null;
  safeLS.set(USER_KEY, user ? JSON.stringify(user) : null);
  renderAccounts();
  updateStatus();
}

async function puterOrThrow({ progress = true } = {}) {
  if (window.puter) return window.puter;
  const n = progress ? notify.progress('Connecting to Puter…', { source: 'X Coder Cloud' }) : null;
  try {
    const puter = await getPuter();
    if (!puter) throw new CloudError(NEEDS_PUTER);
    return puter;
  } finally { n?.close(); }
}

async function ensureSignedIn(reason) {
  const puter = await puterOrThrow();
  if (puterSignedIn()) {
    if (!user) { try { setUser(await puter.auth.getUser()); } catch { setUser({ username: 'Puter account' }); } }
    return puter;
  }
  if (user) setUser(null);
  const ok = await signIn({ reason });
  if (!ok) throw new Cancelled();
  return puter;
}

function report(err, what) {
  if (!err || err instanceof Cancelled) return;
  const text = err instanceof CloudError ? err.message : errorText(err);
  log.error(`${what}: ${text}`);
  notify.error(`${what}: ${text}`, { source: 'X Coder Cloud', actions: [{ label: 'Show Output', run: () => log.show() }] });
}

// ---------------------------------------------------------------- account

async function signIn({ reason = '' } = {}) {
  const puter = await puterOrThrow();
  if (puterSignedIn()) {
    try { setUser(await puter.auth.getUser()); } catch { setUser({ username: 'Puter account' }); }
    notify.info(`Signed in to X Coder Cloud as ${user.username}.`, { source: 'X Coder Cloud' });
    return true;
  }
  let pending = null;
  const choice = await modal({
    type: 'cloud', message: 'Sign in to X Coder Cloud', className: 'scm-auth-dialog', cancelValue: 'cancel',
    body: [
      reason ? h('p', {}, reason) : null,
      h('p', {}, 'X Coder Cloud saves copies of your projects so you can open them on another device. Sign-in and storage are provided by ', h('a', { href: 'https://puter.com', target: '_blank', rel: 'noopener' }, 'Puter'), ' — create a free Puter account or use an existing one.'),
      h('p', { class: 'scm-auth-note' }, 'A Puter window opens to sign in. X Coder never sees your Puter password; your GitHub token is never uploaded.')
    ],
    buttons: [
      { label: 'Sign in with Puter', primary: true, value: 'signin', run: () => { try { pending = Promise.resolve(puter.auth.signIn()); } catch (err) { pending = Promise.reject(err); } } },
      { label: 'Cancel', value: 'cancel' }
    ]
  });
  if (choice !== 'signin' || !pending) return false;
  try { await pending; }
  catch (err) { throw new CloudError(`Puter sign-in did not complete (${errorText(err)}).`); }
  if (!puterSignedIn()) return false;
  try { setUser(await puter.auth.getUser()); } catch { setUser({ username: 'Puter account' }); }
  log.info(`Signed in as ${user.username}`);
  notify.info(`Signed in to X Coder Cloud as ${user.username}.`, { source: 'X Coder Cloud' });
  return true;
}

async function signOut() {
  const ok = await dialogs.confirm({ message: `Sign out of X Coder Cloud${user ? ` (${user.username})` : ''}?`, detail: 'Your projects stay on this device and in your Puter account.', primary: 'Sign Out' });
  if (!ok) return false;
  try { (window.puter || await getPuter(4000))?.auth?.signOut?.(); } catch (err) { log.warn(`Puter sign-out: ${errorText(err)}`); }
  setUser(null);
  notify.info('Signed out of X Coder Cloud.', { source: 'X Coder Cloud' });
  return true;
}

// ---------------------------------------------------------------- sync / open / delete

async function saveCloudMeta(meta) {
  const cloud = { ...(workspace.project?.cloud || {}), ...meta };
  await workspace.updateProject({ cloud });
}

async function syncCurrent({ quiet = false } = {}) {
  if (!workspace.project || !workspace.fs) throw new CloudError('Open a project first.');
  if (syncing) { if (!quiet) notify.info('X Coder Cloud is already syncing this project.', { source: 'X Coder Cloud' }); return null; }
  const puter = await ensureSignedIn('Sign in to sync this project to X Coder Cloud.');
  const project = workspace.project, fs = workspace.fs;
  const cloudId = project.cloud?.id || project.id;
  syncing = true; updateStatus();
  const n = quiet ? null : notify.progress(`Syncing '${project.name}' to X Coder Cloud…`, { source: 'X Coder Cloud' });
  try {
    const remote = await readManifest(puter, cloudId).catch(() => null);
    const known = project.cloud?.remoteUpdatedAt || 0;
    if (remote && remote.updatedAt > known && remote.device && remote.device !== deviceId()) {
      if (quiet) { log.warn(`Auto sync skipped: '${project.name}' changed in the cloud from another device.`); notify.warn(`'${project.name}' was changed in X Coder Cloud from another device. Auto sync paused for this project.`, { source: 'X Coder Cloud', actions: [{ label: 'Sync Now…', run: () => commands.execute('xcoder.cloud.syncProject') }] }); return null; }
      n?.close();
      const choice = await dialogs.show({ type: 'warning', message: `'${remote.name || project.name}' was changed in X Coder Cloud from another device ${relativeTime(remote.updatedAt)}.`, detail: 'Replace the cloud copy with the files on this device, or open the cloud version instead?', buttons: ['Replace Cloud Copy', 'Open Cloud Version…', 'Cancel'], defaultId: 2, cancelId: 2 });
      if (choice === 2) return null;
      if (choice === 1) { syncing = false; updateStatus(); await openCloudProject({ id: cloudId, name: remote.name, legacy: false, updatedAt: remote.updatedAt }); return null; }
    }
    const res = await syncProject(puter, { cloudId, name: project.name, fs, device: deviceId(), onProgress: (d, t) => n?.update(`Syncing '${project.name}' to X Coder Cloud… ${d}/${t} files`) });
    if (workspace.project?.id === project.id) await saveCloudMeta({ id: cloudId, lastSyncAt: Date.now(), remoteUpdatedAt: res.manifest.updatedAt });
    log.info(`Synced '${project.name}': ${res.uploaded} uploaded, ${res.removed} removed, ${res.total} files${res.skipped.length ? `, skipped (over 50 MB): ${res.skipped.join(', ')}` : ''}`);
    if (!quiet) notify.info(`Synced '${project.name}' to X Coder Cloud (${res.uploaded} uploaded, ${res.total} files).`, { source: 'X Coder Cloud' });
    if (res.skipped.length) notify.warn(`${res.skipped.length} file(s) over 50 MB were not uploaded: ${res.skipped.slice(0, 5).join(', ')}`, { source: 'X Coder Cloud' });
    return res;
  } finally {
    n?.close();
    syncing = false; updateStatus();
  }
}

async function pickCloudProject(placeholder) {
  const puter = await ensureSignedIn('Sign in to see your X Coder Cloud projects.');
  let error = null, loading = null; // listed once; the item provider runs on every keystroke
  const item = await quickInput.pick(async () => {
    let list = [];
    try { list = await (loading ||= listProjects(puter)); } catch (err) { error = errorText(err); }
    if (error) return [{ label: `Could not list cloud projects: ${error}`, icon: 'error', disabled: true }];
    if (!list.length) return [{ label: 'No cloud projects yet — use "Sync Current Project" to add one.', icon: 'info', disabled: true }];
    return list.map(p => ({
      label: p.name, icon: 'cloud', entry: p,
      description: `${p.fileCount} file${p.fileCount === 1 ? '' : 's'}${p.legacy ? ' · X Coder 5' : ''}`,
      detail: p.updatedAt ? `Synced ${relativeTime(p.updatedAt)}${p.id === (workspace.project?.cloud?.id || workspace.project?.id) ? ' · current project' : ''}` : undefined
    }));
  }, { title: 'X Coder Cloud', placeholder, matchOnDescription: true });
  return { puter, entry: item?.entry || null };
}

async function openCloudProject(preset) {
  let puter, entry = preset || null;
  if (entry) puter = await ensureSignedIn();
  else ({ puter, entry } = await pickCloudProject('Select a cloud project to open'));
  if (!entry) return null;
  const projects = await workspace.listProjects();
  const local = projects.find(p => (p.cloud?.id || p.id) === entry.id);
  if (local) {
    const choice = await dialogs.show({ type: 'question', message: `'${local.name}' is already on this device.`, detail: 'Replace its files with the cloud version, or just open the local project?', buttons: ['Replace with Cloud Version', 'Open Local Project', 'Cancel'], defaultId: 1, cancelId: 2 });
    if (choice === 2) return null;
    if (choice === 1) { if (workspace.project?.id !== local.id) await workspace.openProject(local.id); return local; }
  }
  const n = notify.progress(`Downloading '${entry.name}' from X Coder Cloud…`, { source: 'X Coder Cloud' });
  try {
    const data = await downloadProject(puter, entry, (d, t) => n.update(`Downloading '${entry.name}' from X Coder Cloud… ${d}/${t} files`));
    let target = local;
    if (!target) target = await workspace.createProject(data.name, { files: {}, activate: false });
    const fs = workspace.project?.id === target.id ? workspace.fs : await new ProjectFS(target.id).load();
    if (local) await fs.clear({ source: 'cloud' });
    if (data.items.length) await fs.writeMany(data.items, { source: 'cloud' });
    const record = workspace.project?.id === target.id ? workspace.project : (await workspace.getProject(target.id)) || target;
    record.cloud = { id: entry.id, lastSyncAt: Date.now(), remoteUpdatedAt: entry.legacy ? 0 : data.updatedAt };
    record.updatedAt = Date.now();
    await idbPut('projects', record);
    if (workspace.project?.id !== target.id) await workspace.openProject(target.id);
    else bus.emit('projects:changed');
    log.info(`Opened '${data.name}' from X Coder Cloud (${data.items.length} files)`);
    notify.info(`Opened '${data.name}' from X Coder Cloud (${data.items.length} files).`, { source: 'X Coder Cloud' });
    return target;
  } finally { n.close(); updateStatus(); }
}

async function deleteCloudProject() {
  const { puter, entry } = await pickCloudProject('Select a cloud project to delete');
  if (!entry) return;
  const ok = await dialogs.confirm({ message: `Delete '${entry.name}' from X Coder Cloud?`, detail: 'The copy in your Puter account is permanently deleted. Projects on this device are not affected.', primary: 'Delete from Cloud', danger: true });
  if (!ok) return;
  await deleteProject(puter, entry);
  if ((workspace.project?.cloud?.id || workspace.project?.id) === entry.id && workspace.project?.cloud) await saveCloudMeta({ lastSyncAt: null, remoteUpdatedAt: 0 });
  log.info(`Deleted '${entry.name}' from X Coder Cloud`);
  notify.info(`Deleted '${entry.name}' from X Coder Cloud.`, { source: 'X Coder Cloud' });
  updateStatus();
}

// ---------------------------------------------------------------- UI

function renderAccounts() {
  accountsDispose?.();
  accountsDispose = user
    ? menus.append('accounts', { submenu: 'accounts/cloud', title: `${user.username} (X Coder Cloud)`, group: '2_cloud', order: 1 })
    : menus.append('accounts', { command: 'xcoder.cloud.signIn', title: 'Sign in to X Coder Cloud (Puter)...', group: '2_cloud', order: 1 });
}

function updateStatus() {
  if (!statusItem) return;
  if (!user) { statusItem.hide(); return; }
  const last = workspace.project?.cloud?.lastSyncAt;
  if (syncing) statusItem.update({ text: '$(sync~spin) Syncing…', tooltip: 'X Coder Cloud: syncing this project' }).show();
  else statusItem.update({
    text: last ? `$(cloud) Synced ${relativeTime(last)}` : '$(cloud) Not synced',
    tooltip: `X Coder Cloud (${user.username})${last ? ` — last synced ${new Date(last).toLocaleString()}` : ''}\nClick to sync this project now${settings.get('xcoder.cloud.autoSync', false) ? ' · auto sync is on' : ''}`
  }).show();
}

function registerCommands() {
  const wrap = (what, fn) => async (...args) => { try { return await fn(...args); } catch (err) { report(err, what); return undefined; } };
  commands.registerAll([
    { id: 'xcoder.cloud.signIn', title: 'Sign In', category: 'X Coder Cloud', icon: 'cloud', run: wrap('Sign-in failed', () => signIn()) },
    { id: 'xcoder.cloud.signOut', title: 'Sign Out', category: 'X Coder Cloud', icon: 'sign-out', when: () => !!user, run: wrap('Sign-out failed', () => signOut()) },
    { id: 'xcoder.cloud.syncProject', title: 'Sync Current Project', category: 'X Coder Cloud', icon: 'cloud-upload', run: wrap('Cloud sync failed', () => syncCurrent()) },
    { id: 'xcoder.cloud.openProject', title: 'Open Cloud Project...', category: 'X Coder Cloud', icon: 'cloud-download', run: wrap('Opening the cloud project failed', () => openCloudProject()) },
    { id: 'xcoder.cloud.deleteProject', title: 'Delete Cloud Project...', category: 'X Coder Cloud', icon: 'trash', run: wrap('Deleting the cloud project failed', () => deleteCloudProject()) },
    { id: 'xcoder.showInstallHelp', title: 'Install X Coder App…', category: 'Help', icon: 'desktop-download', run: () => showInstallHelp() }
  ]);
  menus.appendMany('accounts/cloud', [
    { command: 'xcoder.cloud.syncProject', title: 'Sync Current Project', group: '1_cloud', order: 1 },
    { command: 'xcoder.cloud.openProject', title: 'Open Cloud Project...', group: '1_cloud', order: 2 },
    { command: 'xcoder.cloud.deleteProject', title: 'Delete Cloud Project...', group: '1_cloud', order: 3 },
    { command: 'xcoder.cloud.signOut', title: 'Sign Out', group: '2_signout', order: 1 }
  ]);
}

function registerAutoSync() {
  const run = debounce(() => {
    if (!settings.get('xcoder.cloud.autoSync', false) || !user || !puterSignedIn() || navigator.onLine === false) return;
    syncCurrent({ quiet: true }).catch(err => report(err, 'Auto sync failed'));
  }, 30000);
  bus.on('fs:changed', ev => { if (ev?.source !== 'cloud' && user) run(); });
  bus.on('project:willClose', () => run.cancel());
  settings.onChange('xcoder.cloud.autoSync', v => { updateStatus(); if (!v) run.cancel(); });
}

async function restoreSession() {
  try { user = JSON.parse(safeLS.get(USER_KEY) || 'null'); } catch { user = null; }
  renderAccounts();
  updateStatus();
  if (!user) return;
  // Signed in earlier: load Puter in the background to confirm the session (never blocks the IDE).
  const puter = await getPuter().catch(() => null);
  if (!puter) { log.warn(`${NEEDS_PUTER} Cloud actions are unavailable until it can be reached.`); return; }
  if (!puterSignedIn()) { log.info('The Puter session ended — signed out of X Coder Cloud.'); setUser(null); return; }
  try { setUser(await puter.auth.getUser()); } catch {}
}

export async function activate() {
  captureInstallPrompt();
  settings.register({ key: 'xcoder.cloud.autoSync', type: 'boolean', default: false, category: 'Extensions/Cloud', order: 1, title: 'Auto Sync',
    description: 'When signed in to X Coder Cloud, sync the open project to your Puter account 30 seconds after the last change.' });
  statusItem = statusbar.add({ id: 'status.cloud', alignment: 'left', priority: 6000, text: '', command: 'xcoder.cloud.syncProject', hideOnPhone: true, visible: false });
  registerCommands();
  registerAutoSync();
  bus.on('project:opened', () => updateStatus());
  setInterval(updateStatus, 60000);
  restoreSession();
}
