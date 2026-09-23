// POSIX-style project paths. Project paths are always relative ("src/app.js"), never "/src/app.js".

export const posix = {
  clean(path = '') {
    const absolute = String(path).startsWith('/');
    const parts = [];
    for (const p of String(path).replace(/\\/g, '/').split('/')) {
      if (!p || p === '.') continue;
      if (p === '..') parts.pop(); else parts.push(p);
    }
    return (absolute ? '/' : '') + parts.join('/');
  },
  dirname(path) { const p = this.clean(path); const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); },
  basename(path) { const p = this.clean(path); const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); },
  join(...parts) { return this.clean(parts.filter(Boolean).join('/')); },
  /** Lower-case extension including the dot: ".js" ("" when none). */
  ext(path) { const b = this.basename(path); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; },
  stem(path) { const b = this.basename(path); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; },
  /** Resolve a spec relative to the file at `base` (like a browser resolves a relative URL). */
  resolve(base, spec) {
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(spec) || /^(data|blob|mailto|javascript):/i.test(spec) || spec.startsWith('#')) return spec;
    const clean = String(spec).split(/[?#]/)[0];
    if (clean.startsWith('/')) return this.clean(clean.slice(1));
    return this.clean(this.join(this.dirname(base), clean));
  },
  relative(from, to) {
    const a = this.clean(from).split('/').filter(Boolean), b = this.clean(to).split('/').filter(Boolean);
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/') || '.';
  },
  isInside(path, folder) { return !folder || path === folder || path.startsWith(folder + '/'); }
};

/** Throws for absolute, empty, traversal, or NUL-containing project paths. */
export function validatePath(path) {
  if (!path || typeof path !== 'string') throw new Error('A file path is required');
  if (path.startsWith('/') || path.includes('\0')) throw new Error('Use a relative project path');
  if (path.length > 512) throw new Error('Path is too long');
  const bad = path.split('/').some(p => !p || p === '.' || p === '..');
  if (bad) throw new Error('Invalid path');
  if (/[\u0000-\u001f]/.test(path)) throw new Error('Path contains control characters');
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.avif', '.heic', '.heif',
  '.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.mp4', '.m4v', '.mov', '.webm', '.avi', '.mkv',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.war', '.class', '.dex', '.apk', '.ipa',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.key', '.pages', '.numbers',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.glb', '.fbx', '.blend', '.3ds', '.usdz', '.bin', '.dat',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.wasm', '.pyc', '.sqlite', '.db', '.psd', '.ai', '.sketch', '.fig'
]);
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.avif']);

/** True when the path should be stored and edited as text (by extension / mime). */
export function isTextPath(path, mime = '') {
  const ext = posix.ext(path);
  if (ext === '.svg') return true;
  if (BINARY_EXT.has(ext)) return false;
  if (mime && /^(image|audio|video|font)\//.test(mime) && !mime.includes('svg')) return false;
  return true;
}
export function isImagePath(path) { return IMAGE_EXT.has(posix.ext(path)); }

/** Sniffs bytes: NUL bytes or invalid UTF-8 in the first 8 KB means binary. */
export async function looksBinary(blob) {
  const head = new Uint8Array(await blob.slice(0, 8192).arrayBuffer());
  if (head.includes(0)) return true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head.length === 8192 ? head.slice(0, 8180) : head); return false; }
  catch { return true; }
}

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.jsx': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.json': 'application/json', '.map': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'text/plain',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.py': 'text/x-python', '.java': 'text/x-java', '.csv': 'text/csv', '.yml': 'text/yaml', '.yaml': 'text/yaml'
};
export function mimeFromPath(path) { return MIME[posix.ext(path)] || (isTextPath(path) ? 'text/plain' : 'application/octet-stream'); }
