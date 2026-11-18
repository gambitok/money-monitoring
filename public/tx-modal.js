// Shared modal for adding, editing and deleting transactions from any view.
//
//   openTxModal({ tx, onChanged })                         edit one transaction
//   openTxModal({ defaults: { type, occurred_on, category_id }, onChanged })   add one
//   openTxModal({ list: [tx, ...], title, defaults, onChanged })   pick from several (a cell
//                                                          with many transactions), or add more
//
// onChanged() is called after every successful save or delete so the caller can reload.
import { h, api, minorToInput, formatSigned, todayIso } from './lib.js';
import * as categories from './categories-store.js';

let dialog = null;
let current = null; // { onChanged, list, defaults, title }

function ensureDialog() {
  if (dialog) return dialog;
  dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'txModalTitle' });
  // Click on the backdrop (the dialog element itself, outside the content) closes it.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return dialog;
}

export function openTxModal(options) {
  current = { onChanged: () => {}, ...options };
  ensureDialog();
  if (options.tx) renderForm(options.tx);
  else if (options.list?.length) renderList();
  else renderForm(null);
  if (!dialog.open) dialog.showModal();
}

function close() {
  dialog.close();
}

function changed() {
  try { current.onChanged(); } catch (err) { console.error(err); }
}

// ---------- list mode ----------

function renderList() {
  const { list, title } = current;
  dialog.replaceChildren(h('div', { class: 'modal-body' },
    h('div', { class: 'modal-head' },
      h('h2', { id: 'txModalTitle', class: 'modal-title' }, title ?? 'Операції'),
      h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Закрити', onclick: close }, '✕'),
    ),
    h('ul', { class: 'tx-rows modal-list' }, list.map((tx) => h('li', { class: 'tx-row' },
      h('div', { class: 'tx-main' },
        tx.category_id
          ? h('span', { class: 'chip', style: { '--chip-color': tx.category_color || 'var(--muted)' } }, tx.category_name)
          : h('span', { class: 'chip chip-empty' }, 'без категорії'),
        tx.description && h('span', { class: 'tx-description' }, tx.description),
      ),
      h('span', { class: `tx-amount ${tx.type}` }, formatSigned(tx.type, tx.amount_minor)),
      h('div', { class: 'tx-actions' },
        h('button', { type: 'button', class: 'btn-icon', title: 'Редагувати', 'aria-label': 'Редагувати', onclick: () => renderForm(tx) }, '✎'),
      ),
    ))),
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn-primary', onclick: () => renderForm(null) }, '+ Додати ще'),
      h('button', { type: 'button', class: 'btn-ghost', onclick: close }, 'Закрити'),
    ),
  ));
}

// ---------- form mode ----------

function renderForm(tx) {
  const editing = Boolean(tx);
  const d = current.defaults ?? {};
  let type = tx?.type ?? d.type ?? 'expense';

  const amount = h('input', { name: 'amount', inputmode: 'decimal', placeholder: '0,00', value: tx ? minorToInput(tx.amount_minor) : '' });
  const date = h('input', { name: 'occurred_on', type: 'date', value: tx?.occurred_on ?? d.occurred_on ?? todayIso() });
  const category = h('select', { name: 'category_id' });
  const description = h('input', { name: 'description', maxlength: 500, value: tx?.description ?? '', placeholder: 'напр. кава з собою' });
  const message = h('p', { class: 'form-message is-error', role: 'alert' });
  const errorSlot = (field) => h('small', { class: 'field-error', 'data-error-for': field });
  const typeButtons = ['expense', 'income'].map((t) => h('button', {
    type: 'button', role: 'radio', 'data-type': t,
    onclick: () => { type = t; syncType(); fillCategories(null); },
  }, t === 'expense' ? 'Витрата' : 'Дохід'));
  const typeToggle = h('div', { class: 'type-toggle', role: 'radiogroup', 'aria-label': 'Тип операції' }, typeButtons);

  function syncType() {
    for (const b of typeButtons) b.setAttribute('aria-checked', String(b.dataset.type === type));
    form.dataset.type = type;
  }

  function fillCategories(selectedId) {
    const options = categories.active(type);
    // An archived category stays available only on the transaction that already has it.
    const own = tx && categories.byId(tx.category_id);
    if (own?.archived_at && own.type === type) options.push(own);
    category.replaceChildren(
      h('option', { value: '' }, '— без категорії —'),
      ...options.map((c) => h('option', { value: c.id }, c.archived_at ? `${c.name} (архів)` : c.name)),
    );
    category.value = options.some((c) => c.id === selectedId) ? String(selectedId) : '';
  }

  const deleteBtn = editing && h('button', {
    type: 'button', class: 'btn-ghost danger-text',
    onclick: async () => {
      if (!confirm(`Видалити операцію ${formatSigned(tx.type, tx.amount_minor)}${tx.description ? ` (${tx.description})` : ''}?`)) return;
      try {
        await api('DELETE', `/transactions/${tx.id}`);
        changed();
        back(tx, null);
      } catch (err) {
        message.textContent = err.message;
      }
    },
  }, 'Видалити');

  const form = h('form', {
    class: 'modal-body entry-form modal-form',
    novalidate: true,
    autocomplete: 'off',
    onsubmit: async (e) => {
      e.preventDefault();
      for (const slot of form.querySelectorAll('.field-error')) slot.textContent = '';
      message.textContent = '';
      const payload = {
        type,
        amount: amount.value,
        occurred_on: date.value,
        category_id: category.value === '' ? null : Number(category.value),
        description: description.value,
      };
      try {
        const saved = editing
          ? await api('PATCH', `/transactions/${tx.id}`, payload)
          : await api('POST', '/transactions', payload);
        changed();
        back(tx, saved);
      } catch (err) {
        if (!err.fields) { message.textContent = err.message; return; }
        for (const [field, text] of Object.entries(err.fields)) {
          const slot = form.querySelector(`[data-error-for="${field}"]`);
          if (slot) slot.textContent = text;
          else message.textContent = text;
        }
      }
    },
  },
    h('div', { class: 'modal-head' },
      h('h2', { id: 'txModalTitle', class: 'modal-title' }, editing ? 'Редагування операції' : 'Нова операція'),
      h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Закрити', onclick: close }, '✕'),
    ),
    typeToggle,
    h('label', { class: 'field field-amount' }, h('span', {}, 'Сума, ₴'), amount, errorSlot('amount')),
    h('label', { class: 'field field-date' }, h('span', {}, 'Дата'), date, errorSlot('occurred_on')),
    h('label', { class: 'field field-category' }, h('span', {}, 'Категорія'), category, errorSlot('category_id')),
    h('label', { class: 'field field-description' }, h('span', {}, 'Опис ', h('em', { class: 'muted' }, '— обов\'язковий без категорії')), description, errorSlot('description')),
    message,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'submit', class: 'btn-primary' }, editing ? 'Зберегти' : 'Додати'),
      current.list?.length && h('button', { type: 'button', class: 'btn-ghost', onclick: renderList }, '← До списку'),
      h('button', { type: 'button', class: 'btn-ghost', onclick: close }, 'Скасувати'),
      deleteBtn,
    ),
  );

  syncType();
  fillCategories(tx?.category_id ?? d.category_id ?? null);
  dialog.replaceChildren(form);
  amount.focus();
  if (editing) amount.select();
}

// After a save/delete: in list mode update the list and return to it; otherwise close.
function back(before, after) {
  if (!current.list) { close(); return; }
  const list = current.list.filter((t) => t.id !== before?.id);
  if (after) list.push(after);
  current.list = list;
  if (list.length) renderList();
  else close();
}
