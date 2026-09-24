// Language detection for the editor (VS Code language modes on top of @codemirror/language-data).
//
//   detectLanguage(path, text?, overrideId?) → Lang   { id, name, desc (LanguageDescription|null), aliases }
//   loadSupport(lang) → Promise<LanguageSupport|null>   (lazy chunk; cached)
//   allLanguages() → Lang[] sorted by name (for "Change Language Mode")
//   languageById(id) / languageByAlias(nameOrAliasOrPath)
//
// Labels and ids follow VS Code ("JavaScript" / javascript, "Shell Script" / shellscript, …).

import { language as L, languages as DESCS } from './cm.js';
import { posix } from '../core/path.js';
import { languageNameFor } from '../workbench/icons.js';

const { LanguageDescription } = L;

/** CodeMirror description name → [VS Code id, VS Code label, extra aliases]. */
const VS = {
  'JavaScript': ['javascript', 'JavaScript', ['js', 'node', 'mjs', 'cjs']],
  'JSX': ['javascriptreact', 'JavaScript JSX', ['jsx', 'react']],
  'TypeScript': ['typescript', 'TypeScript', ['ts', 'mts', 'cts']],
  'TSX': ['typescriptreact', 'TypeScript JSX', ['tsx']],
  'HTML': ['html', 'HTML', ['htm', 'xhtml', 'handlebars', 'hbs']],
  'CSS': ['css', 'CSS', []],
  'SCSS': ['scss', 'SCSS', []],
  'Sass': ['sass', 'Sass', []],
  'LESS': ['less', 'Less', []],
  'JSON': ['json', 'JSON', ['jsonc', 'json5']],
  'Markdown': ['markdown', 'Markdown', ['md', 'mkd']],
  'Python': ['python', 'Python', ['py', 'python3', 'gyp']],
  'Java': ['java', 'Java', []],
  'C': ['c', 'C', ['h']],
  'C++': ['cpp', 'C++', ['c++', 'cc', 'cxx', 'hpp']],
  'C#': ['csharp', 'C#', ['cs', 'c#']],
  'Go': ['go', 'Go', ['golang']],
  'Rust': ['rust', 'Rust', ['rs']],
  'Ruby': ['ruby', 'Ruby', ['rb']],
  'PHP': ['php', 'PHP', []],
  'Swift': ['swift', 'Swift', []],
  'Kotlin': ['kotlin', 'Kotlin', ['kt', 'kts']],
  'Dart': ['dart', 'Dart', []],
  'Lua': ['lua', 'Lua', []],
  'Shell': ['shellscript', 'Shell Script', ['sh', 'bash', 'zsh', 'shell', 'console', 'terminal']],
  'PowerShell': ['powershell', 'PowerShell', ['ps1', 'pwsh']],
  'SQL': ['sql', 'SQL', []],
  'XML': ['xml', 'XML', ['svg', 'xsl', 'plist']],
  'YAML': ['yaml', 'YAML', ['yml']],
  'TOML': ['toml', 'TOML', []],
  'Properties files': ['properties', 'Properties', ['ini', 'env', 'dotenv', 'conf']],
  'Vue': ['vue', 'Vue', []],
  'Dockerfile': ['dockerfile', 'Dockerfile', ['docker']],
  'diff': ['diff', 'Diff', ['patch']],
  'Objective-C': ['objective-c', 'Objective-C', ['objc']],
  'Objective-C++': ['objective-cpp', 'Objective-C++', []],
  'Perl': ['perl', 'Perl', ['pl']],
  'R': ['r', 'R', []],
  'Scala': ['scala', 'Scala', []],
  'Haskell': ['haskell', 'Haskell', ['hs']],
  'Clojure': ['clojure', 'Clojure', ['clj']],
  'CoffeeScript': ['coffeescript', 'CoffeeScript', ['coffee']],
  'Erlang': ['erlang', 'Erlang', []],
  'F#': ['fsharp', 'F#', ['fs']],
  'Groovy': ['groovy', 'Groovy', ['gradle']],
  'Julia': ['julia', 'Julia', ['jl']],
  'LaTeX': ['latex', 'LaTeX', ['tex']],
  'Pug': ['jade', 'Pug', ['pug']],
  'VB.NET': ['vb', 'Visual Basic', ['vbnet']],
  'WebAssembly': ['wat', 'WebAssembly Text', ['wasm']],
  'Nginx': ['nginx', 'Nginx', []],
  'CMake': ['cmake', 'CMake', []],
  'Elm': ['elm', 'Elm', []],
  'OCaml': ['ocaml', 'OCaml', ['ml']],
  'Liquid': ['liquid', 'Liquid', []],
  'Jinja': ['jinja', 'Jinja', ['j2']],
  'Angular Template': ['ng-template', 'Angular Template', []],
  'Stylus': ['stylus', 'Stylus', ['styl']],
  'Tcl': ['tcl', 'Tcl', []],
  'Fortran': ['fortran', 'Fortran', []],
  'Pascal': ['pascal', 'Pascal', []],
  'Solr': ['solr', 'Solr', []]
};

/** Extension / file-name overrides where language-data guesses differently from VS Code. */
const EXT_OVERRIDE = {
  '.m': 'Objective-C', '.jsonc': 'JSON', '.json5': 'JSON', '.webmanifest': 'JSON', '.har': 'JSON', '.code-workspace': 'JSON',
  '.cfg': 'Properties files', '.conf': 'Properties files', '.env': 'Properties files', '.text': null, '.txt': null,
  '.svelte': 'HTML', '.astro': 'HTML', '.ejs': 'HTML', '.njk': 'HTML', '.xhtml': 'HTML', '.plist': 'XML', '.csproj': 'XML',
  '.zsh': 'Shell', '.fish': 'Shell', '.command': 'Shell', '.h': 'C', '.mdx': 'Markdown', '.glsl': 'C', '.wgsl': 'Rust',
  '.gs': 'JavaScript', '.es6': 'JavaScript', '.pyi': 'Python', '.rbw': 'Ruby', '.gemspec': 'Ruby', '.rake': 'Ruby', '.sig': 'SML'
};
const NAME_OVERRIDE = {
  '.babelrc': 'JSON', '.eslintrc': 'JSON', '.prettierrc': 'JSON', '.jshintrc': 'JSON', '.swcrc': 'JSON',
  '.bashrc': 'Shell', '.zshrc': 'Shell', '.profile': 'Shell', '.bash_profile': 'Shell', '.envrc': 'Shell',
  'gemfile': 'Ruby', 'rakefile': 'Ruby', 'podfile': 'Ruby', 'vagrantfile': 'Ruby', 'cmakelists.txt': 'CMake',
  '.gitignore': null, '.aiignore': null, '.npmignore': null, '.dockerignore': null, '.gitattributes': null, 'makefile': null,
  '.editorconfig': 'Properties files', '.npmrc': 'Properties files', '.gitconfig': 'Properties files'
};
const JSONC_NAMES = /^(tsconfig(\..+)?|jsconfig(\..+)?|settings|keybindings|launch|tasks|extensions|devcontainer|\.eslintrc|\.babelrc|\.swcrc)\.json$|\.jsonc$|\.code-workspace$/i;

function makeLang(desc) {
  const map = VS[desc.name];
  const id = map ? map[0] : desc.name.toLowerCase().replace(/[^a-z0-9#+]+/g, '');
  return { id, name: map ? map[1] : desc.name, desc, aliases: [id, desc.name.toLowerCase(), ...(map?.[2] || []), ...desc.alias, ...desc.extensions.map(e => e.toLowerCase())] };
}

const PLAIN = { id: 'plaintext', name: 'Plain Text', desc: null, aliases: ['plaintext', 'text', 'txt', 'plain'] };
const JSONC = { id: 'jsonc', name: 'JSON with Comments', desc: null, aliases: ['jsonc'] };
let LANGS = null;
function ensure() {
  if (LANGS) return LANGS;
  LANGS = [PLAIN];
  for (const desc of DESCS) LANGS.push(makeLang(desc));
  JSONC.desc = DESCS.find(d => d.name === 'JSON') || null;
  LANGS.push(JSONC);
  return LANGS;
}

export function allLanguages() { return [...ensure()].sort((a, b) => a.name.localeCompare(b.name)); }
export function languageById(id) { return ensure().find(l => l.id === id) || null; }
export function plainText() { return PLAIN; }

function langForDescName(name) { return name == null ? PLAIN : ensure().find(l => l.desc?.name === name && l !== JSONC) || PLAIN; }

/** Resolve a language from a name, alias, VS Code id, extension or path (for fenced code blocks, AI output…). */
export function languageByAlias(value = '') {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return PLAIN;
  const list = ensure();
  const exact = list.find(l => l.id === v) || list.find(l => l.name.toLowerCase() === v) || list.find(l => l.aliases.includes(v));
  if (exact) return exact;
  if (v.includes('.') || v.includes('/')) return detectLanguage(v);
  return detectLanguage(`file.${v}`);
}

/** Detects the language for a path (+ optional text for shebang detection; + optional override id). */
export function detectLanguage(path = '', text = '', overrideId = null) {
  if (overrideId) { const o = languageById(overrideId); if (o) return o; }
  const base = posix.basename(path);
  const lower = base.toLowerCase();
  const ext = posix.ext(path);
  if (JSONC_NAMES.test(base)) return JSONC;
  if (lower in NAME_OVERRIDE) return langForDescName(NAME_OVERRIDE[lower]);
  if (ext && ext in EXT_OVERRIDE) return langForDescName(EXT_OVERRIDE[ext]);
  const desc = LanguageDescription.matchFilename(DESCS, base) || LanguageDescription.matchFilename(DESCS, base.replace(/\.[^.]+$/, m => m.toLowerCase()));
  if (desc) return langForDescName(desc.name);
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text?.slice(0, 200) || '');
  if (shebang) {
    const prog = (shebang[1].endsWith('/env') ? shebang[2] || '' : shebang[1]).split('/').pop();
    const byProg = [[/^(node|nodejs|bun)$/, 'JavaScript'], [/^deno$/, 'TypeScript'], [/^python[\d.]*$/, 'Python'], [/^(ba|z|k|da|fi)?sh$/, 'Shell'],
      [/^ruby$/, 'Ruby'], [/^perl$/, 'Perl'], [/^php$/, 'PHP'], [/^lua$/, 'Lua'], [/^(pwsh|powershell)$/, 'PowerShell'], [/^Rscript$/, 'R']];
    for (const [re, name] of byProg) if (re.test(prog)) return langForDescName(name);
  }
  if (/^\s*<\?xml\b/.test(text?.slice(0, 100) || '')) return langForDescName('XML');
  return PLAIN;
}

/** VS Code label for the status bar: known extensions use VS Code's names; otherwise the detected mode. */
export function languageLabel(path, lang) {
  if (lang && lang !== PLAIN) return lang.name;
  const byExt = languageNameFor(path);
  return byExt || 'Plain Text';
}

const supportCache = new Map();
/** Loads the CodeMirror LanguageSupport for a language (lazy chunk). Resolves null for plain text or on failure. */
export function loadSupport(lang) {
  const desc = lang?.desc;
  if (!desc) return Promise.resolve(null);
  if (desc.support) return Promise.resolve(desc.support);
  if (!supportCache.has(desc.name)) {
    supportCache.set(desc.name, desc.load().catch(err => { supportCache.delete(desc.name); console.warn(`[X Coder] language ${desc.name} failed to load`, err); return null; }));
  }
  return supportCache.get(desc.name);
}

/** Language families used for editor features. */
export const HTML_LIKE = new Set(['html', 'vue', 'php', 'ng-template', 'liquid', 'jinja', 'xml']);
export const CSS_LIKE = new Set(['css', 'scss', 'less', 'sass']);
export const JS_LIKE = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
export function emmetSyntaxFor(lang) {
  switch (lang?.id) {
    case 'html': case 'php': case 'ng-template': case 'liquid': case 'jinja': return 'html';
    case 'vue': return 'vue';
    case 'xml': return 'xml';
    case 'javascriptreact': return 'jsx';
    case 'typescriptreact': return 'tsx';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'sass': return 'sass';
    case 'stylus': return 'stylus';
    case 'jade': return 'pug';
    default: return null;
  }
}
export function isMarkdown(lang) { return lang?.id === 'markdown'; }
