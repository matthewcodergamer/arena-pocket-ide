// Panel feature: PROBLEMS · OUTPUT · DEBUG CONSOLE · TERMINAL, the problems status bar item,
// terminal settings and the panel commands (VS Code ids).

import { bus } from '../core/events.js';
import { commands } from '../core/commands.js';
import { settings } from '../core/settings.js';
import { menus } from '../core/menus.js';
import { log } from '../core/output.js';
import { posix } from '../core/path.js';
import { diagnostics } from '../core/diagnostics.js';
import { workspace } from '../core/workspace.js';
import { panel } from '../workbench/panel.js';
import { layout } from '../workbench/layout.js';
import { statusbar } from '../workbench/statusbar.js';
import { editors } from '../workbench/editors.js';
import { notify } from '../platform/notifications.js';
import { problemsTab, refreshProblems } from './problems.js';
import { outputTab, clearOutput } from './output.js';
import { debugConsoleTab } from './debugConsole.js';
import { terminalTab } from './terminalView.js';
import { terminals } from './terminal.js';
import { terminal } from './api.js';

function registerSettings() {
  settings.register([
    { key: 'terminal.integrated.fontSize', type: 'number', default: 13, min: 6, max: 40, integer: true, title: 'Font Size', category: 'Features/Terminal', order: 1, description: 'Controls the font size in pixels of the terminal.' },
    { key: 'terminal.integrated.fontFamily', type: 'string', default: '', title: 'Font Family', category: 'Features/Terminal', order: 2, description: "Controls the font family of the terminal. Defaults to Menlo / the system monospace font when empty." },
    { key: 'terminal.integrated.lineHeight', type: 'number', default: 1, min: 1, max: 3, title: 'Line Height', category: 'Features/Terminal', order: 3, description: 'Controls the line height of the terminal. This number is multiplied by the terminal font size to get the actual line-height in pixels.' },
    { key: 'terminal.integrated.cursorBlinking', type: 'boolean', default: true, title: 'Cursor Blinking', category: 'Features/Terminal', order: 4, description: 'Controls whether the terminal cursor blinks.' },
    { key: 'terminal.integrated.cursorStyle', type: 'enum', enum: ['block', 'line', 'underline'], default: 'block', title: 'Cursor Style', category: 'Features/Terminal', order: 5, description: 'Controls the style of terminal cursor when the terminal is focused.' },
    { key: 'terminal.integrated.scrollback', type: 'number', default: 1000, min: 100, max: 100000, integer: true, title: 'Scrollback', category: 'Features/Terminal', order: 6, description: 'Controls the maximum number of lines the terminal keeps in its buffer.' }
  ]);
}

// ---------------------------------------------------------------- problems status bar item

let problemsItem = null;
function updateProblemsStatus() {
  const { errors, warnings, infos } = diagnostics.counts();
  // The info count is omitted on phones so the remote host label keeps its room (it stays in the tooltip).
  const text = `$(error) ${errors} $(warning) ${warnings}${infos && !layout.isPhone ? ` $(info) ${infos}` : ''}`;
  const parts = [];
  if (errors) parts.push(`Errors: ${errors}`);
  if (warnings) parts.push(`Warnings: ${warnings}`);
  if (infos) parts.push(`Infos: ${infos}`);
  problemsItem?.update({ text, tooltip: parts.length ? parts.join(', ') : 'No Problems', ariaLabel: parts.length ? parts.join(', ') : 'No Problems' });
  refreshProblems();
  requestAnimationFrame(revealActiveTab); // the badge re-render resets the tab strip's scroll position
}

// ---------------------------------------------------------------- helpers for commands

const shellQuote = p => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

/** Path of `path` as typed in the active terminal (relative to its cwd when inside it). */
function terminalPath(path) {
  const cwd = terminals.active?.shell.cwd || '';
  if (!cwd) return shellQuote(path);
  if (path.startsWith(cwd + '/')) return shellQuote(path.slice(cwd.length + 1));
  return shellQuote('/' + path);
}

async function editorApi() {
  try { return (await import('../editor/api.js')).codeEditor; } catch { return null; }
}

function commandForFile(path) {
  const ext = posix.ext(path);
  const p = terminalPath(path);
  if (['.js', '.mjs', '.cjs'].includes(ext)) return `node ${p}`;
  if (ext === '.py') return `python3 ${p}`;
  if (['.sh', '.bash', '.zsh'].includes(ext)) return `sh ${p}`;
  if (['.html', '.htm', '.jsx', '.tsx', '.ts', '.css', '.md', '.svg', '.vue', '.svelte'].includes(ext)) return `run ${p}`;
  return null;
}

async function runActiveFile() {
  const path = editors.activePath;
  if (!path || !workspace.fs?.isFile(path)) { notify.info('Open a file in the editor to run it in the terminal.', { source: 'Terminal' }); return; }
  const cmd = commandForFile(path);
  if (!cmd) { notify.info(`X Coder can't run ${posix.basename(path)} in the terminal. Supported: .js, .mjs, .py, .sh and web files (opened in the Live Preview).`, { source: 'Terminal' }); return; }
  const ce = await editorApi();
  try { if (ce?.isDirty?.(path)) await commands.execute('workbench.action.files.save'); } catch {}
  return terminal.run(cmd);
}

async function runSelectedText() {
  const ce = await editorApi();
  const ed = ce?.getActive?.();
  if (!ed) { notify.info('Select text in an editor to run it in the terminal.', { source: 'Terminal' }); return; }
  let text = ed.getSelectionText?.() || '';
  if (!text.trim()) {
    // VS Code runs the current line when nothing is selected.
    const sel = ed.getSelection?.();
    const lines = String(ed.getText?.() || '').split('\n');
    text = sel ? lines[sel.startLine - 1] || '' : '';
  }
  if (!text.trim()) return;
  return terminal.run(text.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
}

function toggleTab(id) {
  if (panel.isVisible(id)) panel.close();
  else panel.open(id, { focus: true });
}

function registerCommands() {
  commands.registerAll([
    { id: 'workbench.actions.view.problems', title: 'Toggle Problems (Errors, Warnings, Infos)', category: 'View', icon: 'warning', keybinding: 'Mod+Shift+M', run: () => toggleTab('problems') },
    { id: 'workbench.action.output.toggleOutput', title: 'Toggle Output', category: 'View', icon: 'output', keybinding: 'Mod+Shift+U', run: () => toggleTab('output') },
    { id: 'workbench.output.action.clearOutput', title: 'Clear Output', category: 'Output', icon: 'clear-all', run: () => clearOutput() },
    { id: 'workbench.debug.action.toggleRepl', title: 'Toggle Debug Console', category: 'View', icon: 'debug-console', keybinding: 'Mod+Shift+Y', run: () => toggleTab('debug') },
    {
      id: 'workbench.action.terminal.toggleTerminal', title: 'Toggle Terminal', category: 'View', icon: 'terminal', keybinding: 'Ctrl+`', allowInInput: true,
      run: () => {
        if (panel.isVisible('terminal')) { panel.close(); return; }
        const inst = terminals.ensure();
        panel.open('terminal');
        inst.focus({ gesture: true });
      }
    },
    {
      id: 'workbench.action.terminal.new', title: 'Create New Terminal', category: 'Terminal', icon: 'add', keybinding: 'Ctrl+Shift+`', allowInInput: true,
      run: (opts = {}) => {
        const cwd = typeof opts?.cwd === 'string' ? opts.cwd : terminals.active?.shell.cwd || '';
        const inst = terminals.create({ cwd });
        panel.open('terminal');
        inst.focus({ gesture: true });
        return inst.id;
      }
    },
    {
      id: 'workbench.action.terminal.kill', title: 'Kill the Active Terminal Instance', category: 'Terminal', icon: 'trash',
      run: () => terminals.kill()
    },
    { id: 'workbench.action.terminal.clear', title: 'Clear', category: 'Terminal', icon: 'clear-all', run: () => terminals.active?.clear() },
    {
      id: 'workbench.action.terminal.focus', title: 'Focus Terminal', category: 'Terminal', icon: 'terminal',
      run: () => { const inst = terminals.ensure(); panel.open('terminal'); inst.focus({ gesture: true }); }
    },
    { id: 'workbench.action.terminal.runActiveFile', title: 'Run Active File In Active Terminal', category: 'Terminal', icon: 'play', run: runActiveFile },
    { id: 'workbench.action.terminal.runSelectedText', title: 'Run Selected Text In Active Terminal', category: 'Terminal', icon: 'run-all', run: runSelectedText }
  ]);
}

function registerMenus() {
  // Explorer: Open in Integrated Terminal (VS Code's openInTerminal).
  menus.append('explorer/context', {
    title: 'Open in Integrated Terminal', group: 'navigation', order: 30,
    when: ctx => !!ctx && (ctx.type === 'folder' || ctx.type === 'file' || ctx.path === ''),
    run: ctx => {
      const path = ctx?.type === 'file' ? posix.dirname(ctx.path) : (ctx?.path || '');
      return commands.execute('workbench.action.terminal.new', { cwd: path });
    }
  });
  menus.append('editor/context', {
    title: 'Run Selected Text In Active Terminal', group: '9_terminal', order: 1,
    command: 'workbench.action.terminal.runSelectedText'
  });
}

export async function activate() {
  registerSettings();
  panel.registerTab(problemsTab);
  panel.registerTab(outputTab);
  panel.registerTab(debugConsoleTab);
  panel.registerTab(terminalTab);
  registerCommands();
  try { registerMenus(); } catch (err) { log.warn('Panel menus not registered', err); }

  problemsItem = statusbar.add({
    id: 'status.problems', alignment: 'left', priority: 8000, text: '$(error) 0 $(warning) 0',
    tooltip: 'No Problems', command: 'workbench.actions.view.problems', className: 'problems-status'
  });
  bus.on('diagnostics:changed', updateProblemsStatus);
  updateProblemsStatus();

  // Keep the active panel tab scrolled into view on narrow screens (the tab strip scrolls horizontally).
  let wasPhone = layout.isPhone;
  bus.on('layout:changed', () => {
    requestAnimationFrame(revealActiveTab);
    if (wasPhone !== layout.isPhone) { wasPhone = layout.isPhone; updateProblemsStatus(); }
  });
  terminals.events.on('changed', () => requestAnimationFrame(revealActiveTab));
  document.addEventListener('click', e => { if (e.target.closest?.('#panel .panel-switcher')) requestAnimationFrame(revealActiveTab); }, true);
}

function revealActiveTab() {
  if (!layout.isPhone) return;
  const tab = document.querySelector('#panel .panel-switcher .action-item.checked');
  const strip = tab?.parentElement;
  if (!tab || !strip || strip.scrollWidth <= strip.clientWidth) return;
  const tabs = [...strip.children];
  const l = tab.offsetLeft - tabs[0].offsetLeft, r = l + tab.offsetWidth;
  const view = strip.clientWidth;
  if (l >= strip.scrollLeft && r <= strip.scrollLeft + view) return;
  // Align the strip to a tab boundary so no half-cut label is left at the edge.
  const first = tabs.find(t => r - (t.offsetLeft - tabs[0].offsetLeft) <= view) || tab;
  strip.scrollLeft = Math.min(l, first.offsetLeft - tabs[0].offsetLeft);
}
