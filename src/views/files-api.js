// File transfer + explorer API used by other features. Implemented by the Explorer feature (src/views/explorer.js).
// STUB — replaced by the explorer implementation. Keep every export name and signature.
export const files = {
  /** Pick files/folder/zip from the device and import them into the current project (or a new project). */
  async importFiles(opts = {}) {},
  async importFolder(opts = {}) {},
  /** Import a ZIP File/Blob (or pick one). opts: { newProject: bool, name } → project */
  async importZip(file, opts = {}) {},
  async exportZip() {},
  /** Reveal + select a path in the Explorer. */
  reveal(path) {},
  /** Start inline creation in the Explorer. */
  newFile(folder = '') {},
  newFolder(folder = '') {}
};
