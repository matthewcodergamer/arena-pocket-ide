// Projects — X Coder's equivalent of VS Code folders/workspaces: New Project (from a template),
// Open Recent / Open Project (quick pick with rename + delete buttons), Rename, Duplicate, Delete.

import { commands } from '../../core/commands.js';
import { workspace } from '../../core/workspace.js';
import { openDB } from '../../core/db.js';
import { TEMPLATES, DEFAULT_TEMPLATE_ID } from '../../core/templates.js';
import { relativeTime } from '../../core/dom.js';
import { log } from '../../core/output.js';
import { quickInput } from '../../platform/quickinput.js';
import { dialogs } from '../../platform/dialogs.js';
import { notify, withProgress } from '../../platform/notifications.js';

/** Number of files (not folders) stored for a project. Uses a cursor so large projects stay cheap. */
export async function countProjectFiles(projectId) {
  if (projectId === workspace.id && workspace.fs) return workspace.fs.files().length;
  try {
    const db = await openDB();
    return await new Promise(resolve => {
      let n = 0;
      const req = db.transaction('files', 'readonly').objectStore('files').index('projectId').openCursor(IDBKeyRange.only(projectId));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(n); return; }
        if (c.value?.type !== 'folder') n++;
        c.continue();
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

function filesLabel(n) { return n == null ? '' : `${n} file${n === 1 ? '' : 's'}`; }
function ageOf(p) { return relativeTime(p.lastOpenedAt || p.updatedAt || p.createdAt || Date.now()); }

async function uniqueName(base) {
  const names = new Set((await workspace.listProjects()).map(p => p.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) { const n = `${base} ${i}`; if (!names.has(n.toLowerCase())) return n; }
  return base;
}

function validateName(v) {
  const name = String(v || '').trim();
  if (!name) return 'Please provide a project name.';
  if (name.length > 80) return 'A project name can have at most 80 characters.';
  return null;
}

async function resolveProject(arg) {
  const id = typeof arg === 'string' ? arg : arg?.id || arg?.projectId || workspace.id;
  const p = id ? await workspace.getProject(id) : null;
  if (!p) throw new Error('Project not found');
  return p;
}

// ---------------- commands ----------------

async function newProject(arg) {
  let templateId = typeof arg === 'string' ? arg : arg?.template;
  if (!TEMPLATES.some(t => t.id === templateId)) {
    const picked = await quickInput.pick(TEMPLATES.map(t => ({ id: t.id, label: t.label, description: t.description, icon: t.icon })), {
      title: 'New Project', placeholder: 'Select a template for the new project', matchOnDescription: true,
      activeItem: { id: DEFAULT_TEMPLATE_ID }
    });
    if (!picked) return null;
    templateId = picked.id;
  }
  const template = TEMPLATES.find(t => t.id === templateId);
  const suggested = await uniqueName(typeof arg?.name === 'string' ? arg.name : template.id === 'blank' ? 'Untitled Project' : 'My Project');
  const name = typeof arg?.name === 'string' ? arg.name : await quickInput.input({
    title: 'New Project', prompt: `Press Enter to create the project from “${template.label}”.`,
    placeholder: 'Project name', value: suggested, validate: validateName
  });
  if (name == null) return null;
  try {
    const p = await workspace.createProject(String(name).trim(), { template: template.id });
    log.info(`Created project "${p.name}" from template ${template.id}`);
    return p;
  } catch (err) {
    log.error('Could not create project', err);
    notify.error(`Could not create the project: ${err.message}`, { source: 'X Coder' });
    return null;
  }
}

async function openProject(arg) {
  const id = typeof arg === 'string' ? arg : arg?.id;
  if (id) {
    if (id === workspace.id) return workspace.project;
    try { return await workspace.openProject(id); }
    catch (err) { notify.error(`Could not open the project: ${err.message}`, { source: 'X Coder' }); return null; }
  }
  return pickProject();
}

/** The Open Recent / Open Project picker. Returns the opened project (or undefined). */
async function pickProject({ title = 'Open Recent', placeholder = 'Select a project to open (type to filter)' } = {}) {
  let projects = [];
  try { projects = await workspace.listProjects(); } catch (err) { notify.error(`Could not read projects: ${err.message}`); return; }
  const counts = await Promise.all(projects.map(p => countProjectFiles(p.id)));
  const current = projects.find(p => p.id === workspace.id);
  const ordered = current ? [current, ...projects.filter(p => p !== current)] : projects;
  const reopen = () => setTimeout(() => pickProject({ title, placeholder }), 0);
  const items = [];
  for (const p of ordered) {
    const isCurrent = p.id === workspace.id;
    const n = counts[projects.indexOf(p)];
    items.push({
      id: p.id, label: p.name, icon: isCurrent ? 'folder-opened' : 'folder', class: 'xc-project-entry',
      detail: [isCurrent ? 'Current project' : '', filesLabel(n), `opened ${ageOf(p)}`].filter(Boolean).join(' · '),
      project: p,
      buttons: [
        { icon: 'edit', tooltip: 'Rename Project', run: item => { setTimeout(async () => { await renameProject(item.id); reopen(); }, 0); return 'close'; } },
        { icon: 'trash', tooltip: 'Delete Project', run: item => { setTimeout(async () => { await deleteProject(item.id); reopen(); }, 0); return 'close'; } }
      ]
    });
  }
  items.push({ kind: 'separator', label: '' });
  items.push({ id: '__new', label: 'New Project…', icon: 'add', alwaysShow: true, action: () => newProject() });
  if (commands.has('git.clone')) items.push({ id: '__clone', label: 'Clone Repository…', icon: 'repo-clone', alwaysShow: true, action: () => commands.execute('git.clone') });
  items.push({ id: '__zip', label: 'Import ZIP as Project…', icon: 'file-zip', alwaysShow: true, action: () => importZipAsProject() });

  // Like VS Code's Open Recent, preselect the most recent *other* project so Enter switches.
  const firstOther = ordered.find(p => p.id !== workspace.id);
  const activeItem = firstOther ? items.find(i => i.id === firstOther.id) : undefined;
  const picked = await quickInput.pick(items, { title, placeholder, activeItem });
  if (!picked) return;
  if (picked.action) return picked.action();
  if (picked.id === workspace.id) return workspace.project;
  return openProject(picked.id);
}

async function importZipAsProject() {
  let files;
  try { files = await import('../../views/files-api.js').then(m => m.files); } catch { files = null; }
  if (files?.importZip && commands.has('xcoder.files.importZip')) {
    try { return await files.importZip(null, { newProject: true }); }
    catch (err) { notify.error(`Could not import the ZIP file: ${err.message}`, { source: 'X Coder' }); return; }
  }
  notify.warn('Importing ZIP files is not available because the Explorer failed to load. Check Output → X Coder for details.', { source: 'X Coder' });
}

async function renameProject(arg) {
  let p;
  try { p = await resolveProject(arg); } catch (err) { notify.error(err.message); return null; }
  const name = await quickInput.input({ title: 'Rename Project', prompt: 'Press Enter to rename the project.', placeholder: 'Project name', value: p.name, validate: validateName });
  if (name == null || name.trim() === p.name) return null;
  try {
    return await workspace.renameProject(p.id, name.trim());
  } catch (err) { notify.error(`Could not rename the project: ${err.message}`); return null; }
}

async function duplicateProject(arg) {
  let p;
  try { p = await resolveProject(arg); } catch (err) { notify.error(err.message); return null; }
  try {
    const copy = await withProgress({ title: `Duplicating “${p.name}”…` }, () => workspace.duplicateProject(p.id));
    notify.info(`Created “${copy.name}”.`, { source: 'X Coder', actions: [{ label: 'Open Project', run: () => openProject(copy.id) }] });
    return copy;
  } catch (err) { notify.error(`Could not duplicate the project: ${err.message}`); return null; }
}

async function deleteProject(arg) {
  let p;
  try { p = await resolveProject(arg); } catch (err) { notify.error(err.message); return false; }
  if (p.id === workspace.id) {
    const others = (await workspace.listProjects()).filter(x => x.id !== p.id);
    const choice = await dialogs.show({
      type: 'warning',
      message: `“${p.name}” is the open project.`,
      detail: others.length
        ? 'Open another project first, then X Coder deletes this one.'
        : 'This is your only project. Create a new project first, then X Coder deletes this one.',
      buttons: [others.length ? 'Switch Project…' : 'New Project…', 'Cancel'], defaultId: 0, cancelId: 1
    });
    if (choice !== 0) return false;
    let next = null;
    if (others.length) {
      const picked = await quickInput.pick(others.map(o => ({ id: o.id, label: o.name, icon: 'folder', description: ageOf(o) })), { title: `Switch Project to Delete “${p.name}”`, placeholder: 'Select the project to open instead' });
      if (!picked) return false;
      next = await openProject(picked.id);
    } else next = await newProject();
    if (!next || workspace.id === p.id) return false;
  }
  const count = await countProjectFiles(p.id);
  const ok = await dialogs.confirm({
    message: `Are you sure you want to delete “${p.name}”?`,
    detail: `${count != null ? `${filesLabel(count)}, ` : 'All files, '}checkpoints, AI chats and the Source Control base of this project will be deleted from this device. This cannot be undone.`,
    primary: 'Delete', danger: true
  });
  if (!ok) return false;
  try {
    await workspace.deleteProject(p.id);
    notify.info(`Deleted project “${p.name}”.`, { source: 'X Coder' });
    return true;
  } catch (err) { notify.error(`Could not delete the project: ${err.message}`); return false; }
}

export function registerProjectCommands() {
  commands.registerAll([
    { id: 'xcoder.project.new', title: 'New Project…', category: 'File', icon: 'new-folder', run: arg => newProject(arg) },
    { id: 'workbench.action.openRecent', title: 'Open Recent…', category: 'File', keybinding: 'Ctrl+R', icon: 'history', run: () => pickProject() },
    { id: 'xcoder.project.open', title: 'Open Project…', category: 'File', icon: 'folder-opened', run: arg => openProject(arg) },
    { id: 'xcoder.project.rename', title: 'Rename Project…', category: 'File', when: () => !!workspace.project, run: arg => renameProject(arg) },
    { id: 'xcoder.project.duplicate', title: 'Duplicate Project', category: 'File', when: () => !!workspace.project, run: arg => duplicateProject(arg) },
    { id: 'xcoder.project.delete', title: 'Delete Project…', category: 'File', when: () => !!workspace.project, run: arg => deleteProject(arg) }
  ]);
}
