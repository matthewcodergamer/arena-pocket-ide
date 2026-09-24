// X Coder AI API used by other features (editor context menu, welcome page, terminal, explorer).
// Implemented by the chat UI (src/ai/chat*.js). Safe to import before the AI feature activates.
//
//   await ai.open()                                    opens the Chat view and focuses the input
//   await ai.ask(prompt, { mode, attachments, newSession })  sends through the same path as the chat input
//                                                      → engine result { turnId, text, edits, … }; throws on failure
//   ai.attach({ type: 'file', path } | { type: 'image', name, dataUrl } | { type: 'selection', path, text, startLine, endLine })
//   ai.isBusy()

import { chat, submitChat } from './chatSession.js';
import { addPendingAttachment, currentModelId } from './chatInput.js';
import { views } from '../workbench/views.js';

const CHAT_CONTAINER = 'workbench.view.chat';

function normalize(att = {}) {
  if (!att || typeof att !== 'object') return null;
  if (att.type === 'file' && att.path) return { type: 'file', path: String(att.path).replace(/^\/+/, '') };
  if (att.type === 'image' && att.dataUrl) return { type: 'image', name: att.name || 'image.png', dataUrl: att.dataUrl, mime: att.mime || (att.dataUrl.match(/^data:([^;,]+)/)?.[1] ?? 'image/png'), thumb: att.thumb || att.dataUrl, width: att.width, height: att.height, size: att.size };
  if (att.type === 'selection' && att.text != null) return { type: 'selection', path: att.path || '', text: String(att.text), startLine: att.startLine || 1, endLine: att.endLine || att.startLine || 1 };
  if (att.type === 'text' && att.text != null) return { type: 'text', name: att.name || 'text.txt', text: String(att.text) };
  if (['problems', 'terminal', 'git', 'codebase'].includes(att.type)) return { type: att.type };
  return null;
}

export const ai = {
  /** Opens the chat view (and focuses the input). */
  async open({ focus = true } = {}) {
    views.open(CHAT_CONTAINER, { focus: false });
    if (focus) {
      const { getChatInput } = await import('./chatView.js');
      requestAnimationFrame(() => getChatInput()?.focus());
    }
  },

  /** Sends a prompt. opts: { mode: 'ask'|'edit'|'agent', attachments: [...], newSession } */
  async ask(prompt, opts = {}) {
    if (chat.busy) throw new Error('X Coder is still working on the previous request. Stop it first or wait for it to finish.');
    await this.open({ focus: false });
    if (opts.newSession) chat.newSession();
    const attachments = (opts.attachments || []).map(normalize).filter(Boolean);
    const result = await submitChat({ text: String(prompt ?? ''), attachments, mode: opts.mode, model: opts.model || currentModelId() });
    const resp = chat.lastResponse;
    if (resp?.state === 'error') throw new Error(resp.error || 'X Coder AI could not answer.');
    if (resp?.state === 'stopped') { const err = new Error('The request was stopped.'); err.name = 'AbortError'; throw err; }
    return result;
  },

  /** Adds a context attachment to the chat input without sending. */
  attach(attachment) {
    const a = normalize(attachment);
    if (!a) return false;
    return addPendingAttachment(a);
  },

  isBusy() { return chat.busy; }
};
