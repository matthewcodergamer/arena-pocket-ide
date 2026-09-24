// Holds the live Explorer tree so commands and the files API can reach it (opening the Explorer
// first when needed). Everything here is synchronous up to the input focus so the iOS keyboard opens
// from the user's tap.

import { views } from '../../workbench/views.js';
import { layout } from '../../workbench/layout.js';
import { workspace } from '../../core/workspace.js';
import { posix } from '../../core/path.js';

export const EXPLORER_CONTAINER = 'workbench.view.explorer';
export const FILE_VIEW = 'workbench.explorer.fileView';

export const explorer = {
  /** @type {import('./tree.js').FileTree|null} */
  tree: null,

  /** Opens the Explorer and expands the Folders view. Returns the tree (or null). */
  show({ focus = false } = {}) {
    views.open(EXPLORER_CONTAINER);
    views.revealView(FILE_VIEW, { focus: focus && !layout.isPhone });
    return this.tree;
  },

  /** Folder for a command argument: {path} (menus pass ctx objects), a string, or the Explorer selection. */
  folderFor(arg) {
    const fs = workspace.fs;
    const path = typeof arg === 'string' ? arg : arg?.path;
    if (path != null && fs) {
      if (path === '' || fs.isFolder(path)) return path;
      if (fs.isFile(path)) return posix.dirname(path);
    }
    return this.tree?.targetFolder() ?? '';
  },

  reveal(path, { focus = true } = {}) {
    const tree = this.show({ focus });
    return tree ? tree.reveal(path, { focus, scroll: 'center' }) : false;
  },
  newFile(folder) { const tree = this.show(); tree?.startNew('newFile', folder ?? tree.targetFolder()); },
  newFolder(folder) { const tree = this.show(); tree?.startNew('newFolder', folder ?? tree.targetFolder()); },
  rename(path) { const tree = this.show(); tree?.startRename(path); }
};
