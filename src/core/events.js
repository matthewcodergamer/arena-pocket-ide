// Event emitter + the global workbench event bus.
//
// Bus events (payloads):
//   'project:opened'      (project)                    after a project becomes active (fs loaded)
//   'project:willClose'   (project)                    before switching away
//   'project:renamed'     (project)
//   'projects:changed'    ()                           list of projects changed (create/delete/rename)
//   'fs:changed'          ({type, path, to?, source?}) type: create|write|delete|rename|mkdir|reset
//   'editor:activeChanged'({key, input} | null)
//   'editor:opened'       ({key, input})
//   'editor:closed'       ({key, input})
//   'editor:dirty'        ({key, path, dirty})
//   'editor:saved'        ({path})
//   'editor:cursor'       ({path, line, col, selectionLength, lines})
//   'settings:changed'    ({key, value})
//   'theme:changed'       ({id, type})              type: 'dark' | 'light' | 'hc'
//   'diagnostics:changed' ({errors, warnings, infos})
//   'git:changed'         ({changes})
//   'preview:console'     ({level, text, time, source})
//   'preview:ran'         ({entry})
//   'layout:changed'      ({sidebar, panel, aux, phone})
//   'keyboard:changed'    ({open, height})
//   'ai:status'           ({state, text})             state: idle|busy|error|ready

export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }
  once(event, fn) {
    const off = this.on(event, (...args) => { off(); fn(...args); });
    return off;
  }
  off(event, fn) { this.handlers.get(event)?.delete(fn); }
  emit(event, ...args) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (err) { console.error(`[X Coder] handler for "${event}" failed`, err); }
    }
  }
}

export const bus = new Emitter();

/** Collects disposers so views can clean up listeners in one call. */
export class DisposableStore {
  constructor() { this.items = []; }
  add(d) { if (d) this.items.push(d); return d; }
  dispose() {
    for (const d of this.items.splice(0)) {
      try { typeof d === 'function' ? d() : d?.dispose?.(); } catch (err) { console.error(err); }
    }
  }
}
