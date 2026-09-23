// Output channels (the OUTPUT panel's data model). Any module can log:
//   const log = output.channel('Git');
//   log.info('Pushed abc123'); log.error('Push failed', err); log.show();
// The panel UI (src/panel/output.js) renders channels and listens for changes.

import { Emitter } from './events.js';

const channels = new Map();
export const outputEvents = new Emitter(); // 'append' (channel, line) | 'clear' (channel) | 'show' (channel) | 'added' (channel)

class OutputChannel {
  constructor(name) { this.name = name; this.lines = []; }
  append(level, ...parts) {
    const text = parts.map(p => p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : safeJson(p)).join(' ');
    const line = { time: Date.now(), level, text };
    this.lines.push(line);
    if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 2000);
    outputEvents.emit('append', this, line);
    return line;
  }
  appendLine(...parts) { return this.append('info', ...parts); }
  info(...parts) { return this.append('info', ...parts); }
  warn(...parts) { return this.append('warning', ...parts); }
  error(...parts) { return this.append('error', ...parts); }
  debug(...parts) { return this.append('debug', ...parts); }
  trace(...parts) { return this.append('trace', ...parts); }
  clear() { this.lines = []; outputEvents.emit('clear', this); }
  /** Opens the Output panel on this channel. */
  show() { outputEvents.emit('show', this); }
  text() { return this.lines.map(l => `${new Date(l.time).toISOString().slice(11, 23)} [${l.level}] ${l.text}`).join('\n'); }
}

function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

export const output = {
  channel(name) {
    if (!channels.has(name)) { channels.set(name, new OutputChannel(name)); outputEvents.emit('added', channels.get(name)); }
    return channels.get(name);
  },
  channels() { return [...channels.values()]; }
};

/** The main application log channel. */
export const log = output.channel('X Coder');
