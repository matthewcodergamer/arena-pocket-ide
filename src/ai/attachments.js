// Chat attachments: turns device files, pasted/dropped content and editor context into the attachment
// objects the AI engine understands, plus chip metadata for the chat input.
//
//   await readImageFile(file)            → { type:'image', name, mime, dataUrl, thumb, width, height, size }
//   await classifyFiles(files)           → { attachments, archives: File[], folders: File[], unsupported: [{file, reason}] }
//   describe(attachment)                 → { label, detail, icon, iconHtml? } for chips
//   keyOf(attachment)                    → dedupe key
//   await saveImageToProject(att)        → project path (assets/<name>)
//   await addFilesToProject(files)       → paths
//
// Images are decoded (createImageBitmap, falling back to <img>, so iOS HEIC photos work in Safari), scaled
// to at most 1600 px on the long side and re-encoded as JPEG 0.85 (PNGs stay PNG when small or transparent).

import { workspace } from '../core/workspace.js';
import { posix, isImagePath, isTextPath, looksBinary } from '../core/path.js';
import { fileIconHtml } from '../workbench/icons.js';
import { formatBytes } from '../core/dom.js';

export const MAX_IMAGES = 5;
export const MAX_TEXT_BYTES = 200 * 1024;
const MAX_SIDE = 1600;
const THUMB_SIDE = 160;
const KEEP_PNG_BYTES = 350 * 1024;

const ARCHIVE_RE = /\.(zip)$/i;
const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp|bmp|heic|heif|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;
const HEIC_RE = /\.(heic|heif)$/i;

export function isImageFile(file) {
  return IMAGE_MIME_RE.test(file?.type || '') || isImagePath(file?.name || '') || HEIC_RE.test(file?.name || '');
}
export function isArchiveFile(file) { return ARCHIVE_RE.test(file?.name || '') || /zip/.test(file?.type || ''); }

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('Could not read the file'));
    r.readAsDataURL(blob);
  });
}

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try { const bmp = await createImageBitmap(blob); return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() }; } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('This image format cannot be decoded on this device.')); img.src = url; });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (err) { URL.revokeObjectURL(url); throw err; }
}

function canvasFor(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

function hasTransparency(source, w, h) {
  try {
    const s = Math.min(1, 64 / Math.max(w, h));
    const c = canvasFor(w * s, h * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  } catch {}
  return false;
}

function toDataURL(canvas, type, quality) {
  try { return canvas.toDataURL(type, quality); } catch { return ''; }
}

/** Small preview used for chips and stored history. */
export async function makeThumb(dataUrlOrBlob, side = THUMB_SIDE) {
  try {
    const blob = typeof dataUrlOrBlob === 'string' ? await (await fetch(dataUrlOrBlob)).blob() : dataUrlOrBlob;
    const img = await decode(blob);
    try {
      const s = Math.min(1, side / Math.max(img.width, img.height));
      const c = canvasFor(img.width * s, img.height * s);
      const ctx = c.getContext('2d');
      ctx.drawImage(img.source, 0, 0, c.width, c.height);
      return toDataURL(c, 'image/jpeg', 0.7) || '';
    } finally { img.close(); }
  } catch { return ''; }
}

function renameExt(name, ext) {
  const base = String(name || 'image').replace(/\.[^.\/]+$/, '');
  return `${base}.${ext}`;
}

/** Decodes, downsizes and encodes an image File/Blob for the model. */
export async function readImageFile(file, name = file?.name || 'image.png') {
  const mime = file.type || (HEIC_RE.test(name) ? 'image/heic' : 'image/png');
  // SVG: keep the source (the engine sends vector images as text) + a rasterized thumbnail
  if (/svg/.test(mime) || /\.svg$/i.test(name)) {
    const dataUrl = await readAsDataURL(file.type ? file : new Blob([file], { type: 'image/svg+xml' }));
    return { type: 'image', name, mime: 'image/svg+xml', dataUrl, thumb: await makeThumb(file), size: file.size };
  }
  if (/gif/.test(mime) && file.size < 1.5 * 1024 * 1024) {
    const dataUrl = await readAsDataURL(file);
    return { type: 'image', name, mime, dataUrl, thumb: await makeThumb(file), size: file.size };
  }
  const img = await decode(file);
  try {
    const { width, height } = img;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const isPng = /png/.test(mime);
    let dataUrl = '', outMime = 'image/jpeg', outName = renameExt(name, 'jpg');
    if (isPng && scale === 1 && file.size <= KEEP_PNG_BYTES) {
      dataUrl = await readAsDataURL(file); outMime = 'image/png'; outName = name;
    } else {
      const c = canvasFor(width * scale, height * scale);
      const ctx = c.getContext('2d');
      const transparent = isPng && hasTransparency(img.source, width, height);
      if (!transparent) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img.source, 0, 0, c.width, c.height);
      if (transparent) { dataUrl = toDataURL(c, 'image/png'); outMime = 'image/png'; outName = renameExt(name, 'png'); }
      else dataUrl = toDataURL(c, 'image/jpeg', 0.85);
    }
    if (!dataUrl || dataUrl === 'data:,') throw new Error('The image could not be encoded.');
    const t = Math.min(1, THUMB_SIDE / Math.max(width, height));
    const tc = canvasFor(width * t, height * t);
    tc.getContext('2d').drawImage(img.source, 0, 0, tc.width, tc.height);
    const thumb = toDataURL(tc, 'image/jpeg', 0.7);
    return { type: 'image', name: outName, mime: outMime, dataUrl, thumb, width: Math.round(width * scale), height: Math.round(height * scale), size: Math.round(dataUrl.length * 0.75) };
  } finally { img.close(); }
}

async function readTextFile(file) {
  let text = await file.text();
  let truncated = false;
  if (text.length > MAX_TEXT_BYTES) {
    text = `${text.slice(0, MAX_TEXT_BYTES)}\n\n[… truncated: only the first ${formatBytes(MAX_TEXT_BYTES)} of ${formatBytes(file.size)} were attached]`;
    truncated = true;
  }
  return { type: 'text', name: file.webkitRelativePath || file.name, text, size: file.size, truncated };
}

/**
 * Sorts picked/dropped/pasted files into attachments (images, text), archives (ZIP projects) and
 * unsupported files (PDFs and other binaries) with the reason.
 */
export async function classifyFiles(files, { imageBudget = MAX_IMAGES } = {}) {
  const attachments = [], archives = [], unsupported = [];
  let images = 0;
  for (const file of files || []) {
    try {
      if (isArchiveFile(file)) { archives.push(file); continue; }
      if (isImageFile(file)) {
        if (images >= imageBudget) { unsupported.push({ file, reason: `At most ${MAX_IMAGES} images can be attached to one message.` }); continue; }
        attachments.push(await readImageFile(file));
        images++;
        continue;
      }
      if (/pdf/.test(file.type) || /\.pdf$/i.test(file.name)) { unsupported.push({ file, reason: 'PDF documents cannot be read by the AI yet. Take a screenshot of the pages, or add the PDF to the project.' }); continue; }
      const textLike = isTextPath(file.name, file.type) || /^text\//.test(file.type) || /json|xml|javascript|yaml|toml|csv|svg/.test(file.type);
      if (textLike || !(await looksBinary(file.slice(0, 8192)))) { attachments.push(await readTextFile(file)); continue; }
      unsupported.push({ file, reason: `${file.name} is a binary file (${file.type || 'unknown type'}) that the AI cannot read.` });
    } catch (err) {
      unsupported.push({ file, reason: `${file.name}: ${err.message}` });
    }
  }
  return { attachments, archives, unsupported };
}

/** Converts a data URL to a Blob. */
export async function dataUrlToBlob(dataUrl) { return (await fetch(dataUrl)).blob(); }

function uniquePath(fs, path) {
  if (!fs.exists(path)) return path;
  const dir = posix.dirname(path), ext = posix.ext(path), base = posix.stem(path);
  for (let i = 1; i < 1000; i++) {
    const p = posix.join(dir, `${base}-${i}${ext}`);
    if (!fs.exists(p)) return p;
  }
  return path;
}

function safeName(name, fallback = 'image.png') {
  const n = String(name || '').split('/').pop().replace(/[^\w.\- ]+/g, '_').trim();
  return n || fallback;
}

/** Saves an image attachment as assets/<name> in the current project → path. */
export async function saveImageToProject(att) {
  const fs = workspace.fs;
  if (!fs) throw new Error('Open a project first.');
  if (!att?.dataUrl) throw new Error('The image data is no longer available.');
  const path = uniquePath(fs, `assets/${safeName(att.name)}`);
  await fs.writeBinary(path, await dataUrlToBlob(att.dataUrl), { source: 'user', mime: att.mime });
  return path;
}

/** Adds device files (any type) to the project root (or `folder`) → paths. */
export async function addFilesToProject(files, folder = '') {
  const fs = workspace.fs;
  if (!fs) throw new Error('Open a project first.');
  const paths = [];
  for (const file of files) {
    const path = uniquePath(fs, posix.join(folder, safeName(file.name, 'file')));
    await fs.writeFileAuto(path, file, { source: 'user' });
    paths.push(path);
  }
  return paths;
}

export function keyOf(a = {}) {
  switch (a.type) {
    case 'file': return `file:${a.path}`;
    case 'selection': return `sel:${a.path}:${a.startLine}-${a.endLine}`;
    case 'image': return `img:${a.name}:${(a.dataUrl || a.thumb || '').length}`;
    case 'text': return `text:${a.name}:${(a.text || '').length}`;
    default: return a.type;
  }
}

const CONTEXT_LABELS = {
  problems: { label: 'Problems', icon: 'warning', detail: 'Errors and warnings in the project' },
  terminal: { label: 'Terminal Output', icon: 'terminal', detail: 'Recent output of the active terminal' },
  git: { label: 'Git Changes', icon: 'source-control', detail: 'Changes since the last pull or push' },
  codebase: { label: 'Codebase', icon: 'folder-library', detail: 'The whole project is searched for relevant files' }
};

/** Chip presentation for an attachment. */
export function describe(a = {}) {
  switch (a.type) {
    case 'file': return { label: posix.basename(a.path), detail: a.path, iconHtml: safeIcon(a.path), icon: 'file' };
    case 'selection': return { label: `${posix.basename(a.path || 'selection')}:${a.startLine}${a.endLine && a.endLine !== a.startLine ? `-${a.endLine}` : ''}`, detail: `Selection in ${a.path || 'the editor'}, lines ${a.startLine}–${a.endLine}`, iconHtml: a.path ? safeIcon(a.path) : '', icon: 'selection' };
    case 'image': return { label: a.name || 'image', detail: `${a.name || 'Image'}${a.width ? ` · ${a.width}×${a.height}` : ''}${a.size ? ` · ${formatBytes(a.size)}` : ''}`, icon: 'file-media' };
    case 'text': return { label: a.name || 'text', detail: `${a.name}${a.size ? ` · ${formatBytes(a.size)}` : ''}${a.truncated ? ' · truncated' : ''}`, iconHtml: safeIcon(a.name || 'file.txt'), icon: 'file' };
    default: return CONTEXT_LABELS[a.type] || { label: a.type, icon: 'symbol-file', detail: '' };
  }
}

function safeIcon(path) { try { return fileIconHtml(path); } catch { return ''; } }
