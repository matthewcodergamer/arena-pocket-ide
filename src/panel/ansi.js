// ANSI escape sequence support for the integrated terminal.
//
//   const parser = new AnsiParser();
//   parser.feed('\x1b[1;32mok\x1b[0m', onText, onControl) → onText(text, style) for each styled run,
//                                                           onControl(kind, arg) for clear/eraseLine/cr
//   styleToAttrs(style) → { class, style } for a <span>
//   stripAnsi(text)                                         → plain text
//   sgr.green('text') / sgr.bold(…) / sgr.dim(…)             → text wrapped in SGR codes (used by xsh builtins)
//
// Supports SGR (16 colors, bright colors, bold, dim, italic, underline, inverse, strikethrough,
// 256-color and 24-bit truecolor), and a few cursor/erase sequences terminals commonly emit
// (ESC[2J / ESC c clear, ESC[K erase line, \r carriage return). Other sequences are consumed silently.

const ESC = '\x1b';

export function stripAnsi(text = '') {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')       // OSC … BEL / ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')               // CSI
    .replace(/\x1b[@-Z\\-_]/g, '');                           // 2-char escapes
}

export function defaultStyle() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
}

// xterm 256-color palette entries 16–255 (0–15 use the theme's ANSI colors).
function color256(n) {
  if (n < 16) return { ansi: n };
  if (n < 232) {
    const i = n - 16, steps = [0, 95, 135, 175, 215, 255];
    return { rgb: `rgb(${steps[Math.floor(i / 36)]}, ${steps[Math.floor(i / 6) % 6]}, ${steps[i % 6]})` };
  }
  const v = 8 + (n - 232) * 10;
  return { rgb: `rgb(${v}, ${v}, ${v})` };
}

function applySgr(style, params) {
  const p = params.length ? params : [0];
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0 || Number.isNaN(n)) Object.assign(style, defaultStyle());
    else if (n === 1) style.bold = true;
    else if (n === 2) style.dim = true;
    else if (n === 3) style.italic = true;
    else if (n === 4) style.underline = true;
    else if (n === 7) style.inverse = true;
    else if (n === 9) style.strike = true;
    else if (n === 21 || n === 22) { style.bold = false; style.dim = false; }
    else if (n === 23) style.italic = false;
    else if (n === 24) style.underline = false;
    else if (n === 27) style.inverse = false;
    else if (n === 29) style.strike = false;
    else if (n >= 30 && n <= 37) style.fg = { ansi: n - 30 };
    else if (n === 39) style.fg = null;
    else if (n >= 40 && n <= 47) style.bg = { ansi: n - 40 };
    else if (n === 49) style.bg = null;
    else if (n >= 90 && n <= 97) style.fg = { ansi: n - 90 + 8 };
    else if (n >= 100 && n <= 107) style.bg = { ansi: n - 100 + 8 };
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg';
      if (p[i + 1] === 5 && p.length > i + 2) { style[key] = color256(p[i + 2] & 255); i += 2; }
      else if (p[i + 1] === 2 && p.length > i + 4) { style[key] = { rgb: `rgb(${p[i + 2] & 255}, ${p[i + 3] & 255}, ${p[i + 4] & 255})` }; i += 4; }
    }
  }
}

const ANSI_NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White',
  'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite'];
const cssColor = c => c.rgb || `var(--vscode-terminal-ansi${ANSI_NAMES[c.ansi]})`;

/** Class list + inline style for a styled run (null when the run is unstyled). */
export function styleToAttrs(s) {
  if (!s) return null;
  const cls = [], css = [];
  let fg = s.fg, bg = s.bg;
  // Bold text in the 8 base colors renders bright, like xterm.js' drawBoldTextInBrightColors.
  if (s.bold && fg?.ansi != null && fg.ansi < 8) fg = { ansi: fg.ansi + 8 };
  if (s.inverse) {
    css.push(`color:${bg ? cssColor(bg) : 'var(--vscode-terminal-background, var(--vscode-panel-background))'}`);
    css.push(`background:${fg ? cssColor(fg) : 'var(--vscode-terminal-foreground)'}`);
  } else {
    if (fg) { if (fg.ansi != null) cls.push(`xterm-fg-${fg.ansi}`); else css.push(`color:${fg.rgb}`); }
    if (bg) { if (bg.ansi != null) cls.push(`xterm-bg-${bg.ansi}`); else css.push(`background:${bg.rgb}`); }
  }
  if (s.bold) cls.push('xterm-bold');
  if (s.dim) cls.push('xterm-dim');
  if (s.italic) cls.push('xterm-italic');
  if (s.underline) cls.push('xterm-underline');
  if (s.strike) cls.push('xterm-strike');
  if (!cls.length && !css.length) return null;
  return { class: cls.join(' '), style: css.join(';') };
}

/** Streaming parser: keeps SGR state and partial escape sequences between feed() calls. */
export class AnsiParser {
  constructor() { this.style = defaultStyle(); this.pending = ''; }
  reset() { this.style = defaultStyle(); this.pending = ''; }
  /** onText(text, styleSnapshot) · onControl('clear' | 'eraseLine' | 'cr' | 'newline') */
  feed(chunk, onText, onControl) {
    let s = this.pending + String(chunk ?? '');
    this.pending = '';
    let buf = '';
    const flush = () => { if (buf) { onText(buf, { ...this.style }); buf = ''; } };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === ESC) {
        if (i + 1 >= s.length) { flush(); this.pending = s.slice(i); return; }
        const next = s[i + 1];
        if (next === '[') {
          let j = i + 2;
          while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
          if (j >= s.length) { flush(); this.pending = s.slice(i); return; }
          const final = s[j], body = s.slice(i + 2, j);
          flush();
          if (final === 'm') applySgr(this.style, body.split(';').filter(x => x !== '').map(Number));
          else if (final === 'J' && (body === '2' || body === '3')) onControl('clear');
          else if (final === 'K') onControl('eraseLine');
          i = j; continue;
        }
        if (next === ']') {
          const bel = s.indexOf('\x07', i + 2), st = s.indexOf(`${ESC}\\`, i + 2);
          const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
          if (end < 0) { flush(); this.pending = s.slice(i); return; }
          i = end + (end === st ? 1 : 0); continue;
        }
        flush();
        if (next === 'c') onControl('clear');
        i += 1; continue;
      }
      if (ch === '\n') { flush(); onControl('newline'); continue; }
      if (ch === '\r') { if (s[i + 1] === '\n') continue; flush(); onControl('cr'); continue; }
      if (ch === '\x07' || ch === '\x00') continue;
      if (ch === '\b') { if (buf) buf = buf.slice(0, -1); continue; }
      buf += ch; // tabs render with CSS tab-size: 8
    }
    flush();
  }
}

const wrap = (open, close = 0) => text => `\x1b[${open}m${text}\x1b[${close}m`;
/** SGR helpers for command output. */
export const sgr = {
  bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), underline: wrap(4, 24), inverse: wrap(7, 27),
  black: wrap(30, 39), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39),
  magenta: wrap(35, 39), cyan: wrap(36, 39), white: wrap(37, 39), gray: wrap(90, 39),
  brightRed: wrap(91, 39), brightGreen: wrap(92, 39), brightYellow: wrap(93, 39), brightBlue: wrap(94, 39),
  brightMagenta: wrap(95, 39), brightCyan: wrap(96, 39),
  boldGreen: text => `\x1b[1;32m${text}\x1b[0m`, boldBlue: text => `\x1b[1;34m${text}\x1b[0m`,
  boldRed: text => `\x1b[1;31m${text}\x1b[0m`, boldCyan: text => `\x1b[1;36m${text}\x1b[0m`
};
