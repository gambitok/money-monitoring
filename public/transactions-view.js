// "Операції" view: quick entry form + day/week list with totals.
import {
  $, h, api, readPref, writePref, todayIso, isoToUtc, addDays, startOfWeek,
  dayFmt, shortDateFmt, yearFmt, formatMoney, formatSigned,
} from './lib.js';
import * as categories from './categories-store.js';
import { openTxModal } from './tx-modal.js';

const NEW_CATEGORY = '__new';

const els = {
  form: $('entryForm'),
  typeButtons: [...document.querySelectorAll('#entryForm .type-toggle [data-type]')],
  amount: $('amount'),
  date: $('date'),
  category: $('category'),
  newCategoryRow: $('newCategoryRow'),
  newCategoryName: $('newCategoryName'),
  newCategoryCreate: $('newCategoryCreate'),
  newCategoryCancel: $('newCategoryCancel'),
  description: $('description'),
  descriptionHint: $('descriptionHint'),
  submitBtn: $('submitBtn'),
  formMessage: $('formMessage'),
  modeButtons: [...document.querySelectorAll('.segmented [data-mode]')],
  periodLabel: $('periodLabel'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  todayBtn: $('todayBtn'),
  totalIncome: $('totalIncome'),
  totalExpense: $('totalExpense'),
  totalBalance: $('totalBalance'),
  list: $('list'),
};

const state = {
  type: 'expense',
  mode: readPref('mode', 'day') === 'week' ? 'week' : 'day',
  anchor: todayIso(),
  selectedCategoryId: null, // remembered across type switches and re-renders
};

let lastData = { items: [], totals: { income: 0, expense: 0, balance: 0 } };
let loadSeq = 0;

function currentRange() {
  if (state.mode === 'day') return { from: state.anchor, to: state.anchor };
  const from = startOfWeek(state.anchor);
  return { from, to: addDays(from, 6) };
}

// ---------- entry form ----------

function setType(type) {
  state.type = type;
  for (const btn of els.typeButtons) btn.setAttribute('aria-checked', String(btn.dataset.type === type));
  els.form.dataset.type = type;
  closeNewCategory();
  renderCategoryOptions();
}

function renderCategoryOptions() {
  const options = categories.active(state.type);

  els.category.replaceChildren(
    h('option', { value: '' }, '— без категорії —'),
    ...options.map((c) => h('option', { value: c.id }, c.archived_at ? `${c.name} (архів)` : c.name)),
    h('option', { value: NEW_CATEGORY }, '+ Нова категорія…'),
  );
  const keep = options.some((c) => c.id === state.selectedCategoryId);
  els.category.value = keep ? String(state.selectedCategoryId) : '';
  if (!keep) state.selectedCategoryId = null;
  updateDescriptionHint();
}

function selectCategory(id) {
  state.selectedCategoryId = id;
  els.category.value = id === null ? '' : String(id);
  updateDescriptionHint();
}

function updateDescriptionHint() {
  els.descriptionHint.hidden = state.selectedCategoryId !== null;
}

function onCategoryChange() {
  if (els.category.value === NEW_CATEGORY) {
    els.category.value = state.selectedCategoryId === null ? '' : String(state.selectedCategoryId);
    openNewCategory();
    return;
  }
  state.selectedCategoryId = els.category.value === '' ? null : Number(els.category.value);
  updateDescriptionHint();
}

// ---------- inline "new category" ----------

function openNewCategory() {
  els.newCategoryRow.hidden = false;
  els.newCategoryName.value = '';
  setFieldError('new_category', '');
  els.newCategoryName.placeholder = state.type === 'income' ? 'напр. Фриланс' : 'напр. Кафе';
  els.newCategoryName.focus();
}

function closeNewCategory() {
  els.newCategoryRow.hidden = true;
  setFieldError('new_category', '');
}

async function createInlineCategory() {
  setFieldError('new_category', '');
  const name = els.newCategoryName.value;
  els.newCategoryCreate.disabled = true;
  try {
    const created = await categories.create({ name, type: state.type, color: categories.nextColor(state.type) });
    closeNewCategory();
    selectCategory(created.id);
    showMessage(`Категорію «${created.name}» створено`);
    els.amount.focus();
  } catch (err) {
    const conflict = err.status === 409 && categories.byId(err.body?.conflict_id);
    if (conflict && !conflict.archived_at) {
      // Already exists: just pick it.
      closeNewCategory();
      selectCategory(conflict.id);
      showMessage(`Категорія «${conflict.name}» вже є — вибрано її`);
    } else if (conflict) {
      setFieldError('new_category', '', h('span', {},
        `«${conflict.name}» є в архіві. `,
        h('button', { type: 'button', class: 'link-btn', onclick: () => restoreAndSelect(conflict.id) }, 'Відновити'),
      ));
    } else {
      setFieldError('new_category', err.fields?.name ?? err.message);
    }
  } finally {
    els.newCategoryCreate.disabled = false;
  }
}

async function restoreAndSelect(id) {
  try {
    const restored = await categories.update(id, { archived: false });
    closeNewCategory();
    selectCategory(restored.id);
    showMessage(`Категорію «${restored.name}» відновлено`);
  } catch (err) {
    setFieldError('new_category', err.message);
  }
}

// ---------- errors & messages ----------

function setFieldError(field, text, node = null) {
  const slot = els.form.querySelector(`[data-error-for="${field}"]`);
  if (slot) slot.replaceChildren(node ?? text);
}

function clearErrors() {
  for (const el of els.form.querySelectorAll('.field-error')) el.replaceChildren();
  for (const el of els.form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  showMessage('');
}

function showErrors(fields) {
  const inputs = { amount: els.amount, occurred_on: els.date, category_id: els.category, description: els.description };
  let first = null;
  for (const [field, message] of Object.entries(fields)) {
    if (els.form.querySelector(`[data-error-for="${field}"]`)) setFieldError(field, message);
    else showMessage(message, true);
    if (inputs[field]) {
      inputs[field].setAttribute('aria-invalid', 'true');
      first ??= inputs[field];
    }
  }
  first?.focus();
}

let messageTimer;
function showMessage(text, isError = false) {
  clearTimeout(messageTimer);
  els.formMessage.textContent = text;
  els.formMessage.classList.toggle('is-error', isError);
  if (text && !isError) messageTimer = setTimeout(() => { els.formMessage.textContent = ''; }, 3000);
}

// Editing happens in the shared modal (tx-modal.js); this form only adds new transactions.

async function submitForm(event) {
  event.preventDefault();
  clearErrors();

  const payload = {
    type: state.type,
    amount: els.amount.value,
    occurred_on: els.date.value,
    category_id: state.selectedCategoryId,
    description: els.description.value,
  };

  els.submitBtn.disabled = true;
  try {
    const saved = await api('POST', '/transactions', payload);
    // Keep type, date and category for fast entry of the next one; clear the rest.
    els.amount.value = '';
    els.description.value = '';
    showMessage(`Додано: ${formatSigned(saved.type, saved.amount_minor)}`);
    // Jump to the period that contains the saved date, so the row is visible.
    const { from, to } = currentRange();
    if (payload.occurred_on < from || payload.occurred_on > to) state.anchor = payload.occurred_on;
    await loadList();
    els.amount.focus();
  } catch (err) {
    if (err.fields) showErrors(err.fields);
    else showMessage(err.message, true);
  } finally {
    els.submitBtn.disabled = false;
  }
}

// ---------- period list ----------

function renderPeriod() {
  for (const btn of els.modeButtons) btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
  const { from, to } = currentRange();
  const today = todayIso();

  if (state.mode === 'day') {
    const label = dayFmt.format(isoToUtc(from));
    els.periodLabel.textContent = from === today ? `Сьогодні, ${label}` : label;
  } else {
    const year = yearFmt.format(isoToUtc(to));
    els.periodLabel.textContent = `${shortDateFmt.format(isoToUtc(from))} – ${shortDateFmt.format(isoToUtc(to))} ${year}`;
  }
  els.todayBtn.disabled = today >= from && today <= to;
}

export async function loadList() {
  renderPeriod();
  const { from, to } = currentRange();
  const seq = ++loadSeq;
  try {
    const data = await api('GET', `/transactions?from=${from}&to=${to}`);
    if (seq !== loadSeq) return; // a newer period was requested meanwhile
    lastData = data;
    renderList(data);
  } catch (err) {
    if (seq !== loadSeq) return;
    els.list.replaceChildren(h('p', { class: 'empty is-error' }, `Не вдалося завантажити: ${err.message}`));
  }
}

function renderList({ items, totals }) {
  els.totalIncome.textContent = formatMoney(totals.income);
  els.totalExpense.textContent = formatMoney(totals.expense);
  els.totalBalance.textContent = `${totals.balance < 0 ? '−' : ''}${formatMoney(Math.abs(totals.balance))}`;
  els.totalBalance.classList.toggle('expense', totals.balance < 0);
  els.totalBalance.classList.toggle('income', totals.balance > 0);

  if (items.length === 0) {
    els.list.replaceChildren(h('p', { class: 'empty' }, 'За цей період операцій немає.'));
    return;
  }

  const byDay = Map.groupBy(items, (t) => t.occurred_on);
  const groups = [...byDay].map(([day, rows]) => {
    const income = rows.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount_minor, 0);
    const expense = rows.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount_minor, 0);
    return h('div', { class: 'day-group' },
      state.mode === 'week' && h('div', { class: 'day-header' },
        h('span', {}, dayFmt.format(isoToUtc(day))),
        h('span', { class: 'day-sums' },
          income > 0 && h('span', { class: 'income' }, `+${formatMoney(income)}`),
          expense > 0 && h('span', { class: 'expense' }, `−${formatMoney(expense)}`),
        ),
      ),
      h('ul', { class: 'tx-rows' }, rows.map(renderRow)),
    );
  });
  els.list.replaceChildren(...groups);
}

function renderRow(tx) {
  const categoryEl = tx.category_id
    ? h('span', { class: 'chip', style: { '--chip-color': tx.category_color || 'var(--muted)' } }, tx.category_name)
    : h('span', { class: 'chip chip-empty' }, 'без категорії');

  return h('li', { class: 'tx-row' },
    h('div', { class: 'tx-main' },
      categoryEl,
      tx.description && h('span', { class: 'tx-description' }, tx.description),
    ),
    h('span', { class: `tx-amount ${tx.type}` }, formatSigned(tx.type, tx.amount_minor)),
    h('div', { class: 'tx-actions' },
      h('button', { type: 'button', class: 'btn-icon', title: 'Редагувати', 'aria-label': 'Редагувати', onclick: () => openTxModal({ tx, onChanged: loadList }) }, '✎'),
      h('button', { type: 'button', class: 'btn-icon danger', title: 'Видалити', 'aria-label': 'Видалити', onclick: () => deleteTx(tx) }, '✕'),
    ),
  );
}

async function deleteTx(tx) {
  const what = tx.description || tx.category_name || '';
  if (!confirm(`Видалити операцію ${formatSigned(tx.type, tx.amount_minor)}${what ? ` (${what})` : ''}?`)) return;
  try {
    await api('DELETE', `/transactions/${tx.id}`);
    await loadList();
  } catch (err) {
    alert(`Не вдалося видалити: ${err.message}`);
  }
}

function shiftPeriod(direction) {
  state.anchor = addDays(state.anchor, direction * (state.mode === 'day' ? 1 : 7));
  loadList();
}

// ---------- wiring ----------

export function initTransactionsView() {
  for (const btn of els.typeButtons) btn.addEventListener('click', () => setType(btn.dataset.type));
  for (const btn of els.modeButtons) {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      writePref('mode', state.mode);
      loadList();
    });
  }
  els.category.addEventListener('change', onCategoryChange);
  els.newCategoryCreate.addEventListener('click', createInlineCategory);
  els.newCategoryCancel.addEventListener('click', () => {
    closeNewCategory();
    els.category.focus();
  });
  els.newCategoryName.addEventListener('keydown', (e) => {
    // Enter here creates the category instead of submitting the transaction form.
    if (e.key === 'Enter') {
      e.preventDefault();
      createInlineCategory();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeNewCategory();
      els.category.focus();
    }
  });
  els.form.addEventListener('submit', submitForm);
  els.prevBtn.addEventListener('click', () => shiftPeriod(-1));
  els.nextBtn.addEventListener('click', () => shiftPeriod(1));
  els.todayBtn.addEventListener('click', () => {
    state.anchor = todayIso();
    loadList();
  });

  categories.subscribe(() => renderCategoryOptions());

  els.date.value = todayIso();
  setType('expense');
}

// Used by the summary drill-down: show this day next time the view is shown.
export function goToDay(iso) {
  state.anchor = iso;
  state.mode = 'day';
}

// Called when the view becomes visible: category names/colors may have changed elsewhere.
export function showTransactionsView() {
  loadList();
  els.amount.focus();
}
