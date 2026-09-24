// X Coder AI API used by other features (editor context menu, welcome page, terminal, explorer).
// STUB — replaced by the AI implementation (src/ai/). Keep every export name and signature.
export const ai = {
  /** Opens the chat view (and focuses the input). */
  async open() {},
  /** Sends a prompt. opts: { mode: 'ask'|'edit'|'agent', attachments: [{type:'file', path}|{type:'image', name, dataUrl}|{type:'selection', path, text, startLine, endLine}], newSession } */
  async ask(prompt, opts = {}) { throw new Error('X Coder AI is not available'); },
  /** Adds a context attachment to the chat input without sending. */
  attach(attachment) {},
  isBusy() { return false; }
};
