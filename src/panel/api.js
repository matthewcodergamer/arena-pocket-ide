// Terminal API. Implemented by the Panel feature (src/panel/). Safe to import before the Panel activates.
//
//   terminal.registerCommand('git', { description, usage, run(args, io) })  → disposer
//     io = { print(text, style?), println(text, style?), write(text), error(text), cwd, setCwd(path), resolve(path),
//            raw, signal, stdin (piped text), env, columns, isTTY, run(commandLine) }
//     style: 'error' | 'success' | 'muted' | 'info' | 'warning' | 'bold'. run() may return an exit code (number).
//   await terminal.run('npm run build')   → { exitCode, output }  (opens the terminal and executes visibly)
//   terminal.recentOutput(80)             → plain text (no ANSI) of the active terminal
//   terminal.show()                       → opens the Terminal panel (creating a terminal if needed)

import { registerExternal } from './registry.js';

const ui = () => import('./terminal.js').then(m => m.terminals);
const panelApi = () => import('../workbench/panel.js').then(m => m.panel);

export const terminal = {
  /** Adds a shell command. handler.run(args: string[], io) — see the header for io. */
  registerCommand(name, handler) { return registerExternal(name, handler); },

  /** Runs a command line (or several, one per line) as if typed in the active terminal. */
  async run(commandLine) {
    const terminals = await ui();
    const panel = await panelApi();
    const inst = terminals.ensure();
    panel.open('terminal');
    const lines = String(commandLine ?? '').split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    let result = { exitCode: 0, output: '' };
    const outputs = [];
    for (const line of lines) {
      result = await inst.enqueue(line);
      outputs.push(result.output);
    }
    return { exitCode: result.exitCode, output: outputs.join('') };
  },

  /** Last N lines of terminal output as plain text. */
  recentOutput(lines = 80) {
    const t = loaded?.active;
    return t ? t.recentOutput(lines) : '';
  },

  /** Opens the Terminal panel (optionally focusing the input). */
  async show({ focus = false } = {}) {
    const terminals = await ui();
    const panel = await panelApi();
    terminals.ensure();
    panel.open('terminal', { focus });
  }
};

// recentOutput() is synchronous: keep a reference once the terminal module has loaded.
let loaded = null;
ui().then(t => { loaded = t; }).catch(() => {});
