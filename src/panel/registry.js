// Commands contributed to xsh by other features through terminal.registerCommand (src/panel/api.js),
// e.g. `git` from Source Control. Kept separate so the API can be imported before the Panel activates.

import { sgr } from './ansi.js';
import { Emitter } from '../core/events.js';

export const externalCommands = new Map();
export const registryEvents = new Emitter(); // 'changed'

const STYLE = { error: sgr.red, success: sgr.green, muted: sgr.gray, info: sgr.cyan, warning: sgr.yellow, bold: sgr.bold };

/**
 * handler: { description?, usage?, run(args, io) }
 * io: { print(text, style?), println(text, style?), write(text), error(text), cwd, setCwd(path), resolve(path),
 *       raw, signal, stdin, env, columns, isTTY, run(commandLine) }
 * print/println end the text with a newline (unless it already ends with one); write() does not.
 * style: 'error' | 'success' | 'muted' | 'info' | 'warning' | 'bold'. run() may return an exit code.
 */
export function registerExternal(name, handler) {
  if (!name || !/^[\w.+-]+$/.test(name)) throw new Error(`Invalid terminal command name: ${name}`);
  if (typeof handler?.run !== 'function') throw new Error(`Terminal command "${name}" needs run(args, io)`);
  const entry = {
    external: true, name,
    summary: handler.description || '',
    usage: handler.usage || name,
    category: handler.category || 'Extensions',
    async invoke(args, ctx) {
      const line = (text, style) => {
        let t = String(text ?? '');
        if (!t.endsWith('\n')) t += '\n';
        return style && STYLE[style] ? t.replace(/[^\n]+/g, m => STYLE[style](m)) : t;
      };
      const io = {
        print: (text, style) => ctx.out(line(text, style)),
        println: (text, style) => ctx.out(line(text, style)),
        write: text => ctx.out(String(text ?? '')),
        error: text => ctx.err(line(text, 'error')),
        get cwd() { return ctx.shell.cwd; },
        setCwd: path => ctx.shell.setCwd(ctx.shell.resolve(path)),
        resolve: path => ctx.shell.resolve(path),
        raw: ctx.raw,
        signal: ctx.signal,
        stdin: ctx.stdin,
        env: Object.fromEntries(ctx.shell.env()),
        columns: ctx.columns,
        isTTY: ctx.isTTY,
        run: commandLine => ctx.run(commandLine)
      };
      return handler.run(args, io);
    }
  };
  externalCommands.set(name, entry);
  registryEvents.emit('changed');
  return () => {
    if (externalCommands.get(name) === entry) { externalCommands.delete(name); registryEvents.emit('changed'); }
  };
}
