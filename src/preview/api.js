// Preview API (Run / Live Preview). Implemented by the Preview feature (src/preview/).
// STUB — replaced by the preview implementation. Keep every export name and signature.
export const preview = {
  /** Opens the preview editor tab for `entry` (default: resolveEntry()) and runs it. */
  async run(entry) { throw new Error('Preview is not available'); },
  /** Re-runs the current preview if open. */
  async refresh() {},
  /** Best entry file for the active editor / project (index.html, main.py, …). */
  resolveEntry(path) { return path || 'index.html'; },
  /** Builds the sandboxed HTML document for an entry file. */
  async buildDocument(entry) { return ''; },
  /** Runs `entry` headlessly in a hidden sandboxed iframe and collects console output.
   *  → { entry, logs: [{level, text}], errors: [string], durationMs } */
  async captureRun({ entry, timeoutMs = 4000 } = {}) { return { entry, logs: [], errors: ['Preview is not available'], durationMs: 0 }; },
  /** Recent console entries from the visible preview: [{level, text, time}] */
  logs() { return []; },
  /** Evaluates an expression inside the running preview (Debug Console REPL) → { ok, text } */
  async evaluate(expression) { return { ok: false, text: 'Preview is not running' }; },
  /** Runs a script file headlessly (terminal `node file.js` / `python file.py`).
   *  opts: { args: string[], onOutput(stream: 'stdout'|'stderr', text), signal } → Promise<{ exitCode }> */
  async runScript(path, opts = {}) { throw new Error('Script runner is not available'); }
};
