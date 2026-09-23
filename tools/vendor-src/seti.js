// Seti UI file icons (MIT, jesseweed/seti-ui via the seti-icons package) — the default
// file icon theme of VS Code. Colors match VS Code's "vs-seti" theme.
import definitions from 'seti-icons/lib/definitions.json';
import icons from 'seti-icons/lib/icons.json';

export const SETI_COLORS_DARK = {
  blue: '#519aba', grey: '#4d5a5e', 'grey-light': '#6d8086', green: '#8dc149', orange: '#e37933',
  pink: '#f55385', purple: '#a074c4', red: '#cc3e44', white: '#d4d7d6', yellow: '#cbcb41', ignore: '#41535b'
};
export const SETI_COLORS_LIGHT = {
  blue: '#498ba7', grey: '#455155', 'grey-light': '#627379', green: '#7fae42', orange: '#cc6d2e',
  pink: '#dd4b78', purple: '#9068b0', red: '#b8383d', white: '#bfc2c1', yellow: '#b7b73b', ignore: '#3b4b52'
};

function details(fileName) {
  const files = definitions.files;
  if (Object.prototype.hasOwnProperty.call(files, fileName)) return files[fileName];
  const lower = fileName.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(files, lower)) return files[lower];
  let ext = lower.slice(lower.indexOf('.'));
  if (lower.indexOf('.') < 0) ext = '';
  while (ext !== '') {
    if (Object.prototype.hasOwnProperty.call(definitions.extensions, ext)) return definitions.extensions[ext];
    ext = ext.slice(1);
    const next = ext.indexOf('.');
    ext = next < 0 ? '' : ext.slice(next);
  }
  for (const [partial, value] of definitions.partials) if (fileName.indexOf(partial) > -1) return value;
  return definitions.default;
}

/** Returns { name, svg, color } for a file name, e.g. setiIcon('index.html'). */
export function setiIcon(fileName, light = false) {
  const [name, colorName] = details(String(fileName || ''));
  const palette = light ? SETI_COLORS_LIGHT : SETI_COLORS_DARK;
  return { name, svg: icons[name] || icons.default, color: palette[colorName] || palette.white };
}
