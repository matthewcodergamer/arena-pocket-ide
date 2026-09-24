// Workspace = the open project (VS Code's "folder"). Handles project CRUD, activation,
// and per-project session storage. Import `workspace` and use `workspace.fs` for files.

import { idbGetAll, idbGet, idbPut, idbDelete, idbDeleteByIndex, kvGet, kvSet, kvDelete } from './db.js';
import { ProjectFS } from './fs.js';
import { bus } from './events.js';
import { uid } from './dom.js';
import { templateFiles } from './templates.js';

export const workspace = {
  /** @type {{id:string,name:string,createdAt:number,updatedAt:number,git?:object,[k:string]:any}|null} */
  project: null,
  /** @type {ProjectFS|null} */
  fs: null,

  get id() { return this.project?.id || null; },
  get name() { return this.project?.name || 'No Folder'; },

  async init() {
    const projects = await this.listProjects();
    const last = await kvGet('lastProjectId');
    let p = projects.find(x => x.id === last) || projects[0];
    if (!p) p = await this.createProject('My Project', { template: 'web', activate: false });
    await this.openProject(p.id, { initial: true });
    return this.project;
  },

  /** Projects sorted by most recently updated. */
  async listProjects() {
    const all = (await idbGetAll('projects')) || [];
    return all.sort((a, b) => (b.lastOpenedAt || b.updatedAt || 0) - (a.lastOpenedAt || a.updatedAt || 0));
  },

  async getProject(id) { return (await idbGet('projects', id)) || null; },

  async openProject(id, { initial = false } = {}) {
    const p = await this.getProject(id);
    if (!p) throw new Error('Project not found');
    if (this.project && !initial) bus.emit('project:willClose', this.project);
    const fs = new ProjectFS(p.id);
    await fs.load();
    p.lastOpenedAt = Date.now();
    await idbPut('projects', p);
    this.project = p;
    this.fs = fs;
    await kvSet('lastProjectId', p.id);
    bus.emit('project:opened', p);
    return p;
  },

  /**
   * Creates a project. files: {path: content} map (defaults to the chosen template);
   * pass files: {} for an empty project.
   */
  async createProject(name, { template = 'web', files = null, activate = true } = {}) {
    const clean = String(name || 'Untitled Project').trim().slice(0, 80) || 'Untitled Project';
    const p = { id: uid('project'), name: clean, createdAt: Date.now(), updatedAt: Date.now(), git: { repo: '', branch: 'main', snapshot: {} } };
    await idbPut('projects', p);
    const fs = new ProjectFS(p.id);
    await fs.load();
    const contents = files ?? templateFiles(template);
    const items = Object.entries(contents).map(([path, content]) => (content instanceof Blob ? { path, blob: content } : { path, content }));
    if (items.length) await fs.writeMany(items, { source: 'template' });
    bus.emit('projects:changed');
    if (activate) await this.openProject(p.id);
    return p;
  },

  async renameProject(id, name) {
    const p = await this.getProject(id);
    if (!p) throw new Error('Project not found');
    p.name = String(name).trim().slice(0, 80) || p.name;
    p.updatedAt = Date.now();
    await idbPut('projects', p);
    if (this.project?.id === id) { this.project = p; bus.emit('project:renamed', p); }
    bus.emit('projects:changed');
    return p;
  },

  async duplicateProject(id) {
    const src = await this.getProject(id);
    if (!src) throw new Error('Project not found');
    const srcFs = new ProjectFS(src.id); await srcFs.load();
    const copy = await this.createProject(`${src.name} Copy`, { files: {}, activate: false });
    const fs = new ProjectFS(copy.id); await fs.load();
    await fs.writeMany(srcFs.entries().map(r => r.type === 'folder'
      ? { path: r.path, folder: true }
      : (r.binary instanceof Blob ? { path: r.path, blob: r.binary, mime: r.mime } : { path: r.path, content: r.content || '', mime: r.mime })));
    bus.emit('projects:changed');
    return copy;
  },

  /** Deletes a project and all its files, checkpoints, git base and chats. Cannot delete the open project. */
  async deleteProject(id) {
    if (id === this.project?.id) throw new Error('Open another project before deleting this one.');
    await idbDeleteByIndex('files', 'projectId', id);
    await idbDeleteByIndex('checkpoints', 'projectId', id);
    await idbDeleteByIndex('gitbase', 'projectId', id);
    await idbDeleteByIndex('chats', 'projectId', id);
    for (const k of ['session', 'aiSession', 'aiUsage', 'workbench.session']) await kvDelete(`${k}:${id}`).catch(() => {});
    await idbDelete('projects', id);
    bus.emit('projects:changed');
  },

  /** Persists fields on the current project record (e.g. git settings). */
  async updateProject(patch) {
    if (!this.project) return;
    Object.assign(this.project, patch, { updatedAt: Date.now() });
    await idbPut('projects', this.project);
  },

  /** Per-project key/value state (stored as `${key}:${projectId}`). */
  async sessionGet(key, fallback = null) { return this.project ? kvGet(`${key}:${this.project.id}`, fallback) : fallback; },
  async sessionSet(key, value) { if (this.project) return kvSet(`${key}:${this.project.id}`, value); }
};
