// Terminal API. Implemented by the Panel feature (src/panel/).
// STUB — replaced by the panel implementation. Keep every export name and signature.
export const terminal = {
  /** Adds a shell command. handler.run(args: string[], io) where
   *  io = { print(text, style?: 'error'|'success'|'muted'|'info'), cwd, setCwd(path), resolve(path), raw: string } */
  registerCommand(name, handler) { return () => {}; },
  /** Runs a command line as if typed (shows the terminal). */
  async run(commandLine) {},
  /** Last N lines of terminal output as plain text. */
  recentOutput(lines = 80) { return ''; },
  show() {}
};
