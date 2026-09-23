// VS Code custom dialogs (modal message boxes).
//
//   const ok = await dialogs.confirm({ message: 'Delete "app.js"?', detail: 'You can restore it from Undo.', primary: 'Delete', danger: true })
//   const choice = await dialogs.show({ type: 'warning', message, detail, buttons: ['Save', "Don't Save", 'Cancel'], cancelId: 2 }) → index
//   await dialogs.alert({ message, detail })

import { h, codicon } from '../core/dom.js';

function show({ type = 'info', message = '', detail = '', buttons = ['OK'], cancelId, defaultId = 0, danger = false, checkbox = null, html = null } = {}) {
  return new Promise(resolve => {
    const cancelIndex = cancelId ?? buttons.length - 1;
    const overlay = h('div', { class: 'monaco-dialog-modal-block', role: 'presentation' });
    const checkboxInput = checkbox ? h('input', { type: 'checkbox', id: 'dialog-checkbox' }) : null;
    if (checkboxInput) checkboxInput.checked = !!checkbox.checked;
    const btnRow = h('div', { class: 'dialog-buttons' });
    const box = h('div', { class: 'monaco-dialog-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': message },
      h('div', { class: 'dialog-message-row' },
        h('div', { class: `dialog-icon ${type}` }, codicon(type === 'error' ? 'error' : type === 'warning' ? 'warning' : type === 'question' ? 'question' : 'info')),
        h('div', { class: 'dialog-message-container' },
          h('div', { class: 'dialog-message' }, message),
          detail ? h('div', { class: 'dialog-message-detail' }, detail) : null,
          html ? h('div', { class: 'dialog-message-body', html }) : null,
          checkbox ? h('label', { class: 'dialog-checkbox-row' }, checkboxInput, h('span', {}, checkbox.label)) : null)),
      h('div', { class: 'dialog-buttons-row' }, btnRow));
    const finish = index => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(checkbox ? { index, checked: checkboxInput.checked } : index);
    };
    buttons.forEach((label, i) => {
      const primary = i === defaultId;
      const b = h('button', { class: ['monaco-button', primary ? 'primary' : 'secondary', primary && danger && 'danger'] }, label);
      b.addEventListener('click', () => finish(i));
      btnRow.append(b);
    });
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelIndex); }
      else if (e.key === 'Enter' && !e.isComposing && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); finish(defaultId); }
    };
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) { box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 400); } });
    document.addEventListener('keydown', onKey, true);
    overlay.append(box);
    document.body.append(overlay);
    requestAnimationFrame(() => btnRow.children[defaultId]?.focus());
  });
}

export const dialogs = {
  show,
  async confirm({ message, detail = '', primary = 'OK', cancel = 'Cancel', danger = false, type = danger ? 'warning' : 'question' } = {}) {
    const i = await show({ type, message, detail, buttons: [primary, cancel], defaultId: 0, cancelId: 1, danger });
    return i === 0;
  },
  alert({ message, detail = '', type = 'info', html = null } = {}) { return show({ type, message, detail, html, buttons: ['OK'] }); }
};
