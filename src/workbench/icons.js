// File icons (VS Code's default "Seti" file icon theme) and language labels.
//   await initFileIcons();                 // once at startup
//   fileIconHtml('src/app.js')             → '<span class="file-icon seti" style="color:#cbcb41"><svg…></span>'
//   fileIconElement(path)                  → element
// Folders use VS Code's twistie-only look (no folder icon) in the explorer; `folderIconHtml(open)` exists for other lists.

import { posix } from '../core/path.js';
import { codiconHtml, h } from '../core/dom.js';

let seti = null;
const cache = new Map();

export async function initFileIcons() {
  if (seti) return;
  try { seti = await import('../../vendor/seti.js'); }
  catch (err) { console.warn('[X Coder] Seti icons unavailable', err); }
}

function isLight() { return document.documentElement.dataset.themeType === 'light'; }

export function fileIconHtml(path, extraClass = '') {
  const name = posix.basename(path || '');
  const light = isLight();
  const key = `${name}|${light}|${extraClass}`;
  if (cache.has(key)) return cache.get(key);
  let html;
  if (seti) {
    const { svg, color } = seti.setiIcon(name, light);
    html = `<span class="file-icon seti ${extraClass}" style="color:${color}" aria-hidden="true">${svg}</span>`;
  } else {
    html = `<span class="file-icon ${extraClass}" aria-hidden="true">${codiconHtml('file')}</span>`;
  }
  if (cache.size > 800) cache.clear();
  cache.set(key, html);
  return html;
}
export function fileIconElement(path, extraClass = '') { return h('span', { class: 'file-icon-host', html: fileIconHtml(path, extraClass) }); }
export function folderIconHtml(open = false) { return codiconHtml(open ? 'folder-opened' : 'folder', 'folder-icon'); }
export function clearFileIconCache() { cache.clear(); }

/** Language display names (status bar "language mode"), keyed by extension. */
const LANGUAGE_NAMES = {
  '.html': 'HTML', '.htm': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.sass': 'Sass', '.less': 'Less',
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript JSX', '.ts': 'TypeScript', '.tsx': 'TypeScript JSX',
  '.json': 'JSON', '.jsonc': 'JSON with Comments', '.md': 'Markdown', '.markdown': 'Markdown', '.py': 'Python', '.java': 'Java',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++', '.cs': 'C#', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby',
  '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin', '.kts': 'Kotlin', '.dart': 'Dart', '.lua': 'Lua', '.sh': 'Shell Script',
  '.bash': 'Shell Script', '.zsh': 'Shell Script', '.ps1': 'PowerShell', '.sql': 'SQL', '.xml': 'XML', '.svg': 'XML',
  '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.ini': 'Ini', '.vue': 'Vue', '.svelte': 'Svelte', '.txt': 'Plain Text',
  '.csv': 'CSV', '.r': 'R', '.pl': 'Perl', '.scala': 'Scala', '.hs': 'Haskell', '.ex': 'Elixir', '.exs': 'Elixir',
  '.clj': 'Clojure', '.dockerfile': 'Dockerfile', '.gitignore': 'Ignore', '.env': 'Properties', '.glsl': 'GLSL', '.wgsl': 'WGSL'
};
export function languageNameFor(path) {
  const base = posix.basename(path || '').toLowerCase();
  if (base === 'dockerfile') return 'Dockerfile';
  if (base === 'makefile') return 'Makefile';
  if (base === '.gitignore' || base === '.aiignore') return 'Ignore';
  return LANGUAGE_NAMES[posix.ext(path || '')] || 'Plain Text';
}
