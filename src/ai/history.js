// X Coder AI chat history: chat sessions stored in the IndexedDB 'chats' store, one list per project.
//
//   session = { id, projectId, title, createdAt, updatedAt,
//               turns: [{ id, role: 'user'|'assistant', text, attachments?, parts?, reasoning?, tools?, edits?,
//                         model?, mode?, error?, stopped?, vote?, turnId?, time }] }
//
//   await chatHistory.list(projectId)        → sessions (newest first)
//   await chatHistory.latest(projectId)      → newest session or null
//   await chatHistory.get(id) / save(session) / remove(id) / removeAll(projectId)
//   chatHistory.create(projectId)            → a new, unsaved session object
//   await chatHistory.migrateLegacy(projectId) → imports X Coder 5 'aiSession:<projectId>' messages once
//
// Stored turns never contain full-size images: attachments keep metadata and a small thumbnail only.

import { tx, idbGet, idbPut, idbDelete, idbGetAllByIndex, kvGet, kvSet } from '../core/db.js';
import { uid } from '../core/dom.js';

const STORE = 'chats';
const MAX_TURNS = 240;
const MAX_TEXT = 60000;
const MAX_THUMB = 40000; // characters of a thumbnail data URL
const MAX_KEPT_TEXT = 20000;

export function titleFrom(text = '') {
  const clean = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New Chat';
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
}

function slimAttachment(a = {}) {
  const out = { type: a.type };
  for (const k of ['name', 'path', 'mime', 'size', 'startLine', 'endLine', 'width', 'height', 'truncated', 'implicit']) if (a[k] != null) out[k] = a[k];
  if (a.type === 'image') {
    const thumb = a.thumb || '';
    if (thumb && thumb.length <= MAX_THUMB) out.thumb = thumb;
  }
  // small text context is kept so Retry still works after a reload
  if ((a.type === 'text' || a.type === 'selection') && a.text) {
    out.chars = a.text.length;
    if (a.text.length <= MAX_KEPT_TEXT) out.text = a.text;
  }
  return out;
}

function slimTurn(t = {}) {
  const out = { id: t.id || uid('t'), role: t.role === 'user' ? 'user' : 'assistant', text: String(t.text || '').slice(0, MAX_TEXT), time: t.time || Date.now() };
  if (t.attachments?.length) out.attachments = t.attachments.map(slimAttachment);
  if (t.role !== 'user') {
    if (Array.isArray(t.parts)) {
      out.parts = t.parts.map(p => p.kind === 'markdown'
        ? { kind: 'markdown', text: String(p.text || '').slice(0, MAX_TEXT) }
        : p.kind === 'tools'
          ? { kind: 'tools', items: (p.items || []).slice(0, 200).map(i => ({ id: i.id, name: i.name, label: String(i.label || '').slice(0, 300), state: i.state === 'running' ? 'error' : i.state, detail: String(i.detail || '').slice(0, 500) })) }
          : { kind: p.kind, text: String(p.text || '').slice(0, 2000), name: p.name, id: p.id });
    }
    if (t.reasoning) out.reasoning = String(t.reasoning).slice(0, 20000);
    if (Array.isArray(t.edits) && t.edits.length) out.edits = t.edits.slice(0, 300).map(e => ({ id: e.id, turnId: e.turnId, path: e.path, to: e.to, kind: e.kind, added: e.added, removed: e.removed, state: e.state, error: e.error, projectId: e.projectId }));
    for (const k of ['state', 'requestId', 'model', 'provider', 'mode', 'error', 'stopped', 'vote', 'turnId', 'aborted', 'usage', 'local']) if (t[k] != null && t[k] !== '') out[k] = t[k];
  } else {
    for (const k of ['mode', 'command', 'display', 'local']) if (t[k]) out[k] = t[k];
  }
  return out;
}

export const chatHistory = {
  create(projectId) {
    const now = Date.now();
    return { id: uid('chat'), projectId, title: '', createdAt: now, updatedAt: now, turns: [] };
  },

  async list(projectId) {
    if (!projectId) return [];
    try {
      const all = await idbGetAllByIndex(STORE, 'projectId', projectId);
      return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch (err) { console.warn('[X Coder AI] chat history unavailable', err); return []; }
  },

  async latest(projectId) { return (await this.list(projectId))[0] || null; },

  async get(id) { try { return (await idbGet(STORE, id)) || null; } catch { return null; } },

  /** Persists a session (empty sessions are not stored). Returns the stored record. */
  async save(session, { touch = true } = {}) {
    if (!session?.id || !session.projectId) return null;
    const turns = (session.turns || []).slice(-MAX_TURNS).map(slimTurn);
    if (!turns.length) return null;
    const firstUser = turns.find(t => t.role === 'user');
    const record = {
      id: session.id, projectId: session.projectId,
      title: session.title || titleFrom(firstUser?.display || firstUser?.text || ''),
      createdAt: session.createdAt || Date.now(), updatedAt: touch || !session.updatedAt ? Date.now() : session.updatedAt, turns
    };
    if (session.legacy) record.legacy = true;
    await idbPut(STORE, record);
    session.title = record.title;
    session.updatedAt = record.updatedAt;
    return record;
  },

  async remove(id) { await idbDelete(STORE, id); },

  async removeAll(projectId) {
    const list = await this.list(projectId);
    await tx(STORE, 'readwrite', s => { for (const c of list) s.delete(c.id); });
    return list.length;
  },

  /** One-time import of the X Coder ≤5.1 conversation ('aiSession:<projectId>' in the settings store). */
  async migrateLegacy(projectId) {
    if (!projectId) return null;
    const flag = `aiSessionMigrated:${projectId}`;
    try {
      if (await kvGet(flag, false)) return null;
      const messages = await kvGet(`aiSession:${projectId}`, null);
      await kvSet(flag, true);
      if (!Array.isArray(messages) || !messages.length) return null;
      const turns = messages
        .filter(m => (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
        .map(m => ({ id: uid('t'), role: m.role, text: String(m.text), time: m.time || Date.now(), ...(m.role === 'assistant' ? { parts: [{ kind: 'markdown', text: String(m.text) }], model: typeof m.meta === 'string' ? m.meta.slice(0, 80) : '' } : {}) }));
      if (!turns.length) return null;
      const session = { ...this.create(projectId), title: 'Previous conversation', legacy: true, turns, createdAt: turns[0].time, updatedAt: turns.at(-1).time };
      await this.save(session, { touch: false }); // keeps its original time: newer chats stay on top
      return session;
    } catch (err) { console.warn('[X Coder AI] legacy chat migration failed', err); return null; }
  }
};
