// File transfer + explorer API used by other features. Implemented by the Explorer feature
// (src/views/explorer.js + src/views/explorer/*).
//
//   await files.importFiles({ newProject, target })     pick files from the device → project
//   await files.importFolder({ newProject, target })    pick a folder (webkitdirectory)
//   await files.importZip(file?, { newProject, name, target })  → { project, count, skipped, paths } | null
//   await files.exportZip()                              → { name, size, result } | null  (share sheet on iOS)
//   files.reveal(path)                                   open the Explorer and select + scroll to path
//   files.newFile(folder) / files.newFolder(folder)      start inline creation in the Explorer
//   await files.download(path)                           save a file (or a folder as .zip) to the device

import * as transfer from './explorer/transfer.js';
import { explorer } from './explorer/controller.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { saveBlob } from './explorer/fileOps.js';

function afterImport(result) {
  if (result?.count && result.paths?.length && result.project?.id === workspace.id) {
    try { explorer.tree?.reveal(result.paths[0], { focus: false, scroll: 'center' }); } catch {}
  }
  return result;
}

export const files = {
  /** Pick files/folder/zip from the device and import them into the current project (or a new project). */
  async importFiles(opts = {}) { return afterImport(await transfer.importFiles(opts)); },
  async importFolder(opts = {}) { return afterImport(await transfer.importFolder(opts)); },
  /** Import a ZIP File/Blob (or pick one). opts: { newProject: bool, name } → project */
  async importZip(file, opts = {}) {
    const result = afterImport(await transfer.importZip(file, opts));
    return opts.newProject ? (result?.project || null) : result;
  },
  async exportZip() { return transfer.exportZip(); },
  /** Reveal + select a path in the Explorer. */
  reveal(path) { return explorer.reveal(path); },
  /** Start inline creation in the Explorer. */
  newFile(folder = '') { explorer.newFile(folder); },
  newFolder(folder = '') { explorer.newFolder(folder); },
  /** Saves a file — or a folder as a ZIP — to the device. */
  async download(path) {
    const fs = workspace.fs;
    if (!fs?.exists(path)) throw new Error(`Not found: ${path}`);
    if (fs.isFolder(path)) return transfer.exportZip({ folder: path });
    const name = posix.basename(path);
    return { name, result: await saveBlob(await fs.readBlob(path), name) };
  },
  /** Imports OS files dropped on an element (DataTransfer from a drop event). */
  async importDrop(dataTransfer, target = '') { return afterImport(await transfer.importDrop(dataTransfer, target)); }
};
