// X Coder AI engine — the contract between the chat UI (src/ai/chat*.js) and the agent engine.
// STUB — replaced by the engine implementation. Keep every export name and signature.
//
// runTurn(request) drives one user request to completion (possibly many model/tool rounds):
//   request = {
//     sessionId, prompt,                      // user text (slash command already expanded by the UI)
//     mode: 'ask' | 'edit' | 'agent',
//     model: 'auto' | selection id from catalog.list(),
//     attachments: [ {type:'file', path} | {type:'image', name, dataUrl, mime} | {type:'text', name, text}
//                    | {type:'selection', path, text, startLine, endLine} | {type:'problems'} | {type:'terminal'}
//                    | {type:'codebase'} | {type:'git'} ],
//     history: [{ role: 'user'|'assistant', text }],     // prior turns of this chat session (UI provides)
//     signal: AbortSignal,
//     onEvent(event)                                      // streamed progress for the UI
//   }
//   events:
//     { type: 'status', text }                                        e.g. 'Thinking…', 'Reading src/app.js'
//     { type: 'route', provider, model }                              which model is answering
//     { type: 'text', delta }                                         visible markdown text (tool tags already removed)
//     { type: 'reasoning', delta }                                    optional model reasoning summary text
//     { type: 'tool', id, name, label, state: 'running'|'done'|'error', detail }   e.g. label 'Read src/app.js (120 lines)'
//     { type: 'edit', id, path, to?, kind: 'create'|'modify'|'delete'|'rename', added, removed, state: 'pending'|'applied'|'failed', error? }
//     { type: 'project', id, name }                                   agent created/switched to a new project
//     { type: 'round', index }                                        a new model round started (UI may start a new text block)
//   resolves → { text, edits: [{id, path, to, kind, added, removed, state}], checkpointId, provider, model, usage, rounds }
//   rejects  → Error (AbortError when cancelled). Files are never left half-written.
//
// Edit review (Edit mode stages edits as 'pending'; Agent mode applies them immediately):
//   edits.keep(turnId, editId?)   → writes pending edits (Edit mode) / accepts applied ones
//   edits.undo(turnId, editId?)   → discards pending / restores applied edits from the checkpoint
//   edits.diff(turnId, editId)    → { path, original, modified } for the diff editor
//
// Model catalog:
//   catalog.refresh({ force }) → Promise<void>      loads Worker /models + Puter models
//   catalog.list() → [{ id, label, description, group, provider, source: 'auto'|'worker'|'puter', vision, context }]
//   catalog.current() → selection id (settings 'xcoder.ai.model', default 'auto')
//   catalog.status() → { worker: 'ready'|'unreachable'|'unconfigured', puter: 'signed-in'|'signed-out'|'unavailable', providers: [...] }
//   catalog.onChange(fn) → disposer

export async function runTurn(request) { throw new Error('X Coder AI engine is not available'); }
export const edits = {
  async keep(turnId, editId) {},
  async undo(turnId, editId) {},
  async diff(turnId, editId) { return null; }
};
export const catalog = {
  async refresh() {},
  list() { return [{ id: 'auto', label: 'Auto', description: 'Best available model', group: 'Auto', source: 'auto', vision: true }]; },
  current() { return 'auto'; },
  status() { return { worker: 'unconfigured', puter: 'unavailable', providers: [] }; },
  onChange() { return () => {}; }
};
