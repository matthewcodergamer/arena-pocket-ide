// Small UI helpers shared by Source Control, Accounts and X Coder Cloud:
//   modal(...)  a VS Code dialog (same look as platform/dialogs) whose buttons run synchronously inside
//               the tap — needed on iOS for window.open() and clipboard writes — and can hold custom content.
//   pickRepository(...)  quick pick for "owner/repo" / GitHub URL with the signed-in user's repositories.

import { h, codicon } from '../core/dom.js';
import { quickInput } from '../platform/quickinput.js';
import { parseRepo } from './util.js';

/**
 * modal({ type, message, detail, body: Node|Node[], buttons: [{ label, primary?, run?(): any, value? }], cancelValue })
 * Resolves with the clicked button's value (or run()'s return value); Escape/backdrop → cancelValue.
 * Returns { promise, close(value) } when `handle: true`, otherwise the promise.
 */
export function modal({ type = 'info', message = '', detail = '', body = null, buttons = [{ label: 'OK', primary: true }], cancelValue, className = '', handle = false } = {}) {
  let close;
  const promise = new Promise(resolve => {
    const overlay = h('div', { class: 'monaco-dialog-modal-block', role: 'presentation' });
    const btnRow = h('div', { class: 'dialog-buttons' });
    const box = h('div', { class: ['monaco-dialog-box', className], role: 'dialog', 'aria-modal': 'true', 'aria-label': message },
      h('div', { class: 'dialog-message-row' },
        h('div', { class: `dialog-icon ${type}` }, codicon(type === 'error' ? 'error' : type === 'warning' ? 'warning' : type === 'question' ? 'question' : type)),
        h('div', { class: 'dialog-message-container' },
          h('div', { class: 'dialog-message' }, message),
          detail ? h('div', { class: 'dialog-message-detail' }, detail) : null,
          body ? h('div', { class: 'dialog-message-body' }, body) : null)),
      h('div', { class: 'dialog-buttons-row' }, btnRow));
    let done = false;
    close = value => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    for (const b of buttons) {
      const el = h('button', { class: ['monaco-button', b.primary ? 'primary' : 'secondary'], type: 'button' }, b.icon ? codicon(b.icon) : null, b.label);
      el.addEventListener('click', () => {
        let value = b.value ?? b.label;
        try { if (b.run) { const r = b.run(); if (r !== undefined) value = r; } } catch (err) { console.error(err); }
        if (b.keepOpen) return;
        close(value);
      });
      btnRow.append(el);
    }
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelValue); }
    };
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) { box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 400); } });
    document.addEventListener('keydown', onKey, true);
    overlay.append(box);
    document.body.append(overlay);
    requestAnimationFrame(() => (btnRow.querySelector('.primary') || btnRow.firstChild)?.focus());
  });
  return handle ? { promise, close: v => close(v) } : promise;
}

/**
 * Quick pick for a GitHub repository: type "owner/repo" or a URL, or choose one of your repositories.
 * listRepos: async () => [{ full_name, description, private, updated_at, default_branch }] (optional)
 * Resolves with { owner, repo, full, branch? } or undefined.
 */
export async function pickRepository({ title, placeholder = 'Provide repository URL or pick a repository source.', listRepos = null } = {}) {
  let repos = null, repoError = '';
  const load = async () => {
    if (repos || !listRepos) return;
    try { repos = await listRepos(); } catch (err) { repos = []; repoError = err.message || String(err); }
  };
  const item = await quickInput.pick(async value => {
    await load();
    const v = value.trim();
    const items = [];
    const parsed = parseRepo(v);
    if (v) {
      items.push(parsed
        ? { label: parsed.full, description: parsed.branch ? `branch ${parsed.branch}` : 'Repository on GitHub', icon: 'repo', parsed, alwaysShow: true }
        : { label: v, description: 'Type owner/repository or a https://github.com/… URL', icon: 'warning', disabled: true, alwaysShow: true });
    }
    const lower = v.toLowerCase();
    const mine = (repos || []).filter(r => !lower || r.full_name.toLowerCase().includes(lower) || (parsed && r.full_name.toLowerCase() === parsed.full.toLowerCase()));
    if (mine.length) {
      items.push({ kind: 'separator', label: 'your repositories' });
      for (const r of mine.slice(0, 50)) {
        if (parsed && r.full_name.toLowerCase() === parsed.full.toLowerCase()) continue;
        items.push({ label: r.full_name, description: r.description || '', detail: undefined, icon: r.private ? 'lock' : 'repo', parsed: parseRepo(r.full_name) });
      }
    } else if (!v) {
      items.push({ label: listRepos ? (repoError ? `Could not list your repositories: ${repoError}` : 'Type owner/repository or paste a GitHub URL') : 'Type owner/repository or paste a GitHub URL', description: listRepos ? '' : 'Sign in to GitHub to pick from your repositories', icon: repoError ? 'warning' : 'info', disabled: true });
    }
    return items;
  }, { title, placeholder, filter: false });
  return item?.parsed || undefined;
}
