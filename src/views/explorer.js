// Explorer feature: the EXPLORER view container (Open Editors + Folders), file commands with VS Code
// IDs, Quick Open "Go to File", and importing/exporting files, folders and ZIP archives.

import { bus } from '../core/events.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { settings } from '../core/settings.js';
import { commands } from '../core/commands.js';
import { pickFiles } from '../core/dom.js';
import { quickInput } from '../platform/quickinput.js';
import { notify } from '../platform/notifications.js';
import { views } from '../workbench/views.js';
import { editors } from '../workbench/editors.js';
import { FileTree, addToChat } from './explorer/tree.js';
import { OpenEditorsView, openEditorsActions, OPEN_EDITORS_VIEW } from './explorer/openEditors.js';
import { registerQuickOpen } from './explorer/quickOpen.js';
import { explorer, EXPLORER_CONTAINER, FILE_VIEW } from './explorer/controller.js';
import { validateFileName, createFile, createFolder, deletePaths, duplicatePath, copyPathToClipboard, explorerLog } from './explorer/fileOps.js';
import { importEntries, pickFolder, pickZip } from './explorer/transfer.js';
import { files } from './files-api.js';

function registerSettings() {
  settings.register(
    { key: 'explorer.sortOrder', type: 'enum', default: 'default', category: 'Features/Explorer', title: 'Sort Order', order: 1,
      enum: ['default', 'mixed', 'filesFirst', 'type', 'modified'],
      enumLabels: ['default', 'mixed', 'filesFirst', 'type', 'modified'],
      enumDescriptions: [
        'Files and folders are sorted by their names. Folders are displayed before files.',
        'Files and folders are sorted by their names. Files are interwoven with folders.',
        'Files and folders are sorted by their names. Files are displayed before folders.',
        'Files and folders are grouped by extension type then sorted by their names. Folders are displayed before files.',
        'Files and folders are sorted by last modified date in descending order. Folders are displayed before files.'
      ],
      description: 'Controls the property-based sorting of files and folders in the Explorer.' },
    { key: 'explorer.confirmDelete', type: 'boolean', default: true, category: 'Features/Explorer', title: 'Confirm Delete', order: 2,
      description: 'Controls whether the Explorer should ask for confirmation when deleting a file.' },
    { key: 'explorer.confirmDragAndDrop', type: 'boolean', default: true, category: 'Features/Explorer', title: 'Confirm Drag And Drop', order: 3,
      description: 'Controls whether the Explorer should ask for confirmation to move files and folders via drag and drop.' },
    { key: 'explorer.compactFolders', type: 'boolean', default: true, category: 'Features/Explorer', title: 'Compact Folders', order: 4,
      description: 'Controls whether the Explorer should render folders in a compact form. In such a form, single child folders will be compressed in a combined tree element.' },
    { key: 'explorer.autoReveal', type: 'boolean', default: true, category: 'Features/Explorer', title: 'Auto Reveal', order: 5,
      description: 'Controls whether the Explorer should automatically reveal and select files when opening them.' },
    { key: 'explorer.decorations.colors', type: 'boolean', default: true, category: 'Features/Explorer', title: 'Decorations: Colors', order: 6,
      description: 'Controls whether file decorations should use colors.' },
    { key: 'explorer.decorations.badges', type: 'boolean', default: true, category: 'Features/Explorer', title: 'Decorations: Badges', order: 7,
      description: 'Controls whether file decorations should use badges.' },
    { key: 'workbench.tree.indent', type: 'number', default: 8, min: 4, max: 40, integer: true, category: 'Workbench', title: 'Tree: Indent', order: 60,
      description: 'Controls tree indentation in pixels.' },
    { key: 'workbench.tree.renderIndentGuides', type: 'enum', default: 'onHover', category: 'Workbench', title: 'Tree: Render Indent Guides', order: 61,
      enum: ['none', 'onHover', 'always'], enumLabels: ['none', 'onHover', 'always'],
      description: 'Controls whether the tree should render indent guides. On touch screens indent guides are always shown when set to onHover.' }
  );
}

// ---------------- command implementations ----------------
function pathArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && typeof arg.path === 'string') return arg.path;
  return null;
}
/** Explorer selection when the Explorer has focus, else the active editor's file. */
function contextPaths(arg) {
  const p = pathArg(arg);
  if (p != null && p !== '') return [p];
  const tree = explorer.tree;
  const explorerFocused = tree && document.activeElement && tree.el.contains(document.activeElement);
  if (explorerFocused && tree.selectedPaths().length) return tree.selectedPaths();
  if (editors.activePath) return [editors.activePath];
  if (tree?.selectedPaths().length) return tree.selectedPaths();
  return [];
}

async function newFileQuick(arg) {
  if (!workspace.fs) return;
  const folder = pathArg(arg) != null ? explorer.folderFor(arg) : '';
  const name = await quickInput.input({
    title: 'New File…', placeholder: 'Enter file name', prompt: folder ? `Creates the file in '${folder}'. Use '/' to create folders.` : "Press Enter to create the file. Use '/' to create folders.",
    validate: v => { const r = validateFileName(folder, v); return r?.severity === 'error' ? r.message.replace(/\*\*/g, '') : null; }
  });
  if (!name?.trim()) return;
  const full = posix.join(folder, name.replace(/\/+$/, ''));
  try {
    if (/\/$/.test(name)) { await createFolder(full); explorer.tree?.reveal(full, { focus: false }); return full; }
    await createFile(full, '');
    await editors.open({ type: 'file', path: full }, { pinned: true });
    return full;
  } catch (err) { notify.error(err.message, { source: 'Explorer' }); }
}

async function newUntitledFile() {
  if (!workspace.fs) return;
  let n = 1;
  while (workspace.fs.exists(`Untitled-${n}.txt`)) n++;
  const path = `Untitled-${n}.txt`;
  try {
    await createFile(path, '');
    await editors.open({ type: 'file', path }, { pinned: true });
    return path;
  } catch (err) { notify.error(err.message, { source: 'Explorer' }); }
}

async function refreshExplorer() {
  if (!workspace.fs) return;
  try {
    await workspace.fs.load();
    bus.emit('fs:changed', { type: 'reset', path: '', source: 'refresh' });
    explorer.tree?.rebuild();
  } catch (err) { notify.error(`Could not refresh the Explorer: ${err.message}`, { source: 'Explorer' }); }
}

async function renameFile(arg) {
  const path = contextPaths(arg)[0];
  if (!path || !workspace.fs?.exists(path)) { notify.info('Select a file or folder in the Explorer to rename it.', { source: 'Explorer' }); return; }
  explorer.rename(path);
}

async function deleteFile(arg) {
  const p = pathArg(arg);
  const paths = arg?.paths?.length ? arg.paths : contextPaths(arg);
  if (!paths.length || (p && !workspace.fs?.exists(p))) { notify.info('Select a file or folder in the Explorer to delete it.', { source: 'Explorer' }); return false; }
  return deletePaths(paths);
}

async function copyPath(arg, relative) {
  const path = contextPaths(arg)[0];
  if (!path) { notify.info('There is no active file to copy the path of.', { source: 'Explorer' }); return null; }
  return copyPathToClipboard(path, relative);
}

function showActiveFileInExplorer(arg) {
  const path = pathArg(arg) || editors.activePath;
  if (!path) { explorer.show({ focus: true }); return false; }
  if (!workspace.fs?.exists(path)) { notify.info(`'${posix.basename(path)}' is not in this project.`, { source: 'Explorer' }); return false; }
  return explorer.reveal(path, { focus: true });
}

function findInFolder(arg) {
  const folder = explorer.folderFor(arg);
  return commands.execute('workbench.action.findInFiles', { filesToInclude: folder ? `./${folder}` : '', showIncludesExcludes: true, triggerSearch: true });
}

async function download(arg) {
  const path = contextPaths(arg)[0];
  if (!path) { notify.info('Select a file or folder in the Explorer to download it.', { source: 'Explorer' }); return null; }
  try { return await files.download(path); } catch (err) { notify.error(`Could not download '${posix.basename(path)}': ${err.message}`, { source: 'Explorer' }); return null; }
}

async function duplicate(arg) {
  const path = contextPaths(arg)[0];
  if (!path || !workspace.fs?.exists(path)) return null;
  const created = await duplicatePath(path);
  if (created) explorer.tree?.reveal(created, { focus: false });
  return created;
}

async function openFile() {
  if (!workspace.fs) return null;
  const picked = await pickFiles({ multiple: true });
  if (!picked.length) return null;
  const res = await importEntries(picked.map(f => ({ path: f.name, blob: f })), { target: '', label: picked.length === 1 ? picked[0].name : `${picked.length} files` });
  const first = res?.paths?.find(p => workspace.fs.isFile(p));
  if (first) await editors.open({ type: 'file', path: first }, { pinned: true });
  return res;
}

/** Explicit target from a menu ctx ({path}); undefined when invoked from the palette/menubar. */
function importTarget(arg) {
  if (arg && typeof arg === 'object' && !(arg instanceof Blob) && typeof arg.path === 'string') return explorer.folderFor(arg);
  return undefined;
}

async function askDestination(what) {
  const choice = await quickInput.pick([
    { id: 'current', label: `Import into “${workspace.name}”`, description: 'Add to the open project', icon: 'root-folder' },
    { id: 'new', label: 'Import as New Project', description: `Create a project from the ${what}`, icon: 'new-folder' }
  ], { title: `Import ${what[0].toUpperCase()}${what.slice(1)}`, placeholder: 'Where should the files go?' });
  return choice?.id || null;
}

async function importFilesCommand(arg) {
  const target = importTarget(arg);
  return files.importFiles({ target: target ?? explorer.tree?.targetFolder() ?? '' });
}

// The device picker opens first (inside the user's tap, which iOS requires); the destination
// (open project vs. new project) is asked afterwards when the command came from a menu or the palette.
async function importFolderCommand(arg) {
  let target = importTarget(arg), newProject = !!arg?.newProject;
  const picked = await pickFolder();
  if (!picked.length) return null;
  if (target === undefined && !newProject && workspace.project) {
    const where = await askDestination('folder');
    if (!where) return null;
    newProject = where === 'new';
    target = '';
  }
  return files.importFolder({ target: target || '', newProject, picked });
}

async function importZipCommand(arg, opts) {
  let blob = arg instanceof Blob ? arg : null;
  let target = importTarget(arg), newProject = !!(arg?.newProject || opts?.newProject);
  if (!blob) blob = await pickZip();
  if (!blob) return null;
  if (target === undefined && !newProject && workspace.project) {
    const where = await askDestination('ZIP archive');
    if (!where) return null;
    newProject = where === 'new';
    target = '';
  }
  return files.importZip(blob, { target: target || '', newProject, name: opts?.name || '' });
}

function registerCommands() {
  commands.registerAll([
    { id: 'explorer.newFile', title: 'New File…', category: 'File', icon: 'new-file', run: arg => explorer.newFile(pathArg(arg) != null ? explorer.folderFor(arg) : undefined) },
    { id: 'explorer.newFolder', title: 'New Folder…', category: 'File', icon: 'new-folder', run: arg => explorer.newFolder(pathArg(arg) != null ? explorer.folderFor(arg) : undefined) },
    { id: 'workbench.action.files.newFile', title: 'New File…', category: 'File', keybinding: 'Mod+Alt+N', run: newFileQuick },
    { id: 'workbench.action.files.newUntitledFile', title: 'New Text File', category: 'File', keybinding: 'Mod+N', run: newUntitledFile },
    { id: 'workbench.files.action.refreshFilesExplorer', title: 'Refresh Explorer', category: 'File', icon: 'refresh', run: refreshExplorer },
    { id: 'workbench.files.action.collapseExplorerFolders', title: 'Collapse Folders in Explorer', category: 'View', icon: 'collapse-all', run: () => { const t = explorer.tree || explorer.show(); t?.collapseAll(); } },
    { id: 'renameFile', title: 'Rename…', category: 'File', run: renameFile },
    { id: 'deleteFile', title: 'Delete', category: 'File', run: deleteFile },
    { id: 'copyFilePath', title: 'Copy Path of Active File', category: 'File', keybinding: 'Mod+Alt+C', run: arg => copyPath(arg, false) },
    { id: 'copyRelativeFilePath', title: 'Copy Relative Path of Active File', category: 'File', keybinding: 'Mod+Alt+Shift+C', run: arg => copyPath(arg, true) },
    { id: 'workbench.files.action.showActiveFileInExplorer', title: 'Reveal Active File in Explorer View', category: 'File', run: showActiveFileInExplorer },
    { id: 'filesExplorer.findInFolder', title: 'Find in Folder…', category: 'Search', run: findInFolder },
    { id: 'explorer.download', title: 'Download…', category: 'File', icon: 'cloud-download', run: download },
    { id: 'explorer.duplicate', title: 'Duplicate', category: 'File', run: duplicate },
    { id: 'workbench.action.files.openFile', title: 'Open File…', category: 'File', keybinding: 'Mod+O', run: openFile },
    { id: 'xcoder.files.importFiles', title: 'Import Files…', category: 'File', icon: 'cloud-upload', run: importFilesCommand },
    { id: 'xcoder.files.importFolder', title: 'Import Folder…', category: 'File', icon: 'cloud-upload', run: importFolderCommand },
    { id: 'xcoder.files.importZip', title: 'Import ZIP…', category: 'File', icon: 'file-zip', run: importZipCommand },
    { id: 'xcoder.files.exportZip', title: 'Export Project as ZIP', category: 'File', icon: 'file-zip', run: () => files.exportZip() }
  ]);
}

function sortItem(label, value) {
  return { label, checked: settings.get('explorer.sortOrder', 'default') === value, run: () => settings.set('explorer.sortOrder', value) };
}

function fileViewMoreActions() {
  const target = () => ({ path: explorer.tree?.targetFolder() ?? '', type: 'folder' });
  const items = [
    { label: 'Import Files…', run: () => commands.execute('xcoder.files.importFiles', target()) },
    { label: 'Import Folder…', run: () => commands.execute('xcoder.files.importFolder', target()) },
    { label: 'Import ZIP…', run: () => commands.execute('xcoder.files.importZip', target()) },
    { label: 'Export Project as ZIP', run: () => commands.execute('xcoder.files.exportZip') },
    { separator: true },
    { label: 'Sort By', submenu: () => [
      sortItem('Name', 'default'), sortItem('Type', 'type'), sortItem('Modified', 'modified'),
      { separator: true }, sortItem('Mixed', 'mixed'), sortItem('Files First', 'filesFirst')
    ] },
    { label: 'Compact Folders', checked: settings.get('explorer.compactFolders', true), run: () => settings.set('explorer.compactFolders', !settings.get('explorer.compactFolders', true)) }
  ];
  if (commands.has('xcoder.project.open')) items.push({ separator: true }, { label: 'Open Project…', run: () => commands.execute('xcoder.project.open') });
  return items;
}

function setProjectTitle() {
  const name = workspace.project?.name;
  views.setTitle(FILE_VIEW, name ? name.toUpperCase() : 'NO FOLDER OPENED');
}

export async function activate() {
  registerSettings();
  views.registerContainer({ id: EXPLORER_CONTAINER, title: 'Explorer', icon: 'files', order: 1, keybinding: 'Mod+Shift+E' });
  views.registerView({
    id: OPEN_EDITORS_VIEW, containerId: EXPLORER_CONTAINER, name: 'Open Editors', order: 1, size: 'auto', collapsed: true,
    actions: openEditorsActions,
    render(body) {
      const view = new OpenEditorsView(body);
      return { dispose: () => view.dispose(), focus: () => view.focus(), onShow: () => view.render() };
    }
  });
  views.registerView({
    id: FILE_VIEW, containerId: EXPLORER_CONTAINER, name: 'Folders', title: (workspace.project?.name || 'Folders').toUpperCase(), order: 2, size: 'fill',
    actions: [
      { icon: 'new-file', title: 'New File…', command: 'explorer.newFile', run: () => explorer.newFile() },
      { icon: 'new-folder', title: 'New Folder…', command: 'explorer.newFolder', run: () => explorer.newFolder() },
      { icon: 'refresh', title: 'Refresh Explorer', command: 'workbench.files.action.refreshFilesExplorer', run: () => refreshExplorer() },
      { icon: 'collapse-all', title: 'Collapse Folders in Explorer', command: 'workbench.files.action.collapseExplorerFolders', run: () => explorer.tree?.collapseAll() }
    ],
    moreActions: fileViewMoreActions,
    render(body) {
      explorer.tree?.dispose();
      const tree = new FileTree(body);
      explorer.tree = tree;
      return {
        dispose: () => { tree.dispose(); if (explorer.tree === tree) explorer.tree = null; },
        onShow: () => tree.onShow(), onHide: () => tree.onHide(), focus: () => tree.focus()
      };
    }
  });
  registerCommands();
  registerQuickOpen();
  bus.on('project:opened', setProjectTitle);
  bus.on('project:renamed', setProjectTitle);
  if (workspace.project) setProjectTitle();
  explorerLog.info('Explorer ready');
}

export { explorer, addToChat };
