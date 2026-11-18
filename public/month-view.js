// "Місяць" view: one month laid out like the owner's old spreadsheet — a row per day, a column
// per expense category, the day's descriptions, a totals row, and the month's income on the side.
// Built client-side from /api/transactions (no dedicated endpoint needed).
import { $, h, api, todayIso, isoToUtc, formatMoney, formatSigned } from './lib.js';
import * as categories from './categories-store.js';
import { goToDay } from './transactions-view.js';
import { openTxModal } from './tx-modal.js';

// Owner's highlight rule for a day × category cell: above 2 000 ₴ a bit visible, above 10 000 ₴ more.
const HIGHLIGHT_STEPS = [[1_000_000, 'heat-2'], [200_000, 'heat-1']];
const highlightOf = (minor) => HIGHLIGHT_STEPS.find(([limit]) => minor > limit)?.[1] ?? '';

const NONE = 'none';

const els = {
  label: $('monthLabel'),
  prev: $('monthPrev'),
  next: $('monthNext'),
  input: $('monthInput'),
  today: $('monthToday'),
  income: $('monthIncome'),
  addIncome: $('monthAddIncome'),
  expense: $('monthExpense'),
  balance: $('monthBalance'),
  table: $('monthTable'),
  incomeList: $('monthIncomeList'),
  error: $('monthError'),
};

const state = {
  month: todayIso().slice(0, 7),
  items: [],
};

let loadSeq = 0;

const monthTitleFmt = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const weekdayFmt = new Intl.DateTimeFormat('uk-UA', { weekday: 'short', timeZone: 'UTC' });
const wholeFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const formatWhole = (minor) => wholeFmt.format(Math.round(minor / 100));

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function daysOf(month) {
  const [y, m] = month.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

// Columns: every active expense category in creation order (the seed follows the old sheet's
// column order), archived ones only if used this month, "Інше" last, "Без категорії" if used.
function columnsFor(expenses) {
  const used = new Set(expenses.map((t) => t.category_id ?? NONE));
  const cols = categories.all()
    .filter((c) => c.type === 'expense' && (!c.archived_at || used.has(c.id)))
    .sort((a, b) => a.id - b.id);
  const other = cols.findIndex((c) => c.name === 'Інше');
  if (other !== -1) cols.push(...cols.splice(other, 1));
  const result = cols.map((c) => ({ key: c.id, name: c.name, color: c.color }));
  if (used.has(NONE)) result.push({ key: NONE, name: 'Без категорії', color: null });
  return result;
}

// ---------- loading ----------

function setMonth(month) {
  state.month = month;
  load();
}

async function load() {
  els.input.value = state.month;
  els.label.textContent = monthTitleFmt.format(isoToUtc(`${state.month}-01`));
  els.today.disabled = state.month === todayIso().slice(0, 7);
  els.error.textContent = '';

  const days = daysOf(state.month);
  const seq = ++loadSeq;
  try {
    const { items } = await api('GET', `/transactions?from=${days[0]}&to=${days.at(-1)}`);
    if (seq !== loadSeq) return;
    state.items = items;
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    els.error.textContent = `Не вдалося завантажити: ${err.message}`;
  }
}

// ---------- rendering ----------

function render() {
  const days = daysOf(state.month);
  const expenses = state.items.filter((t) => t.type === 'expense');
  const incomes = state.items.filter((t) => t.type === 'income');
  const columns = columnsFor(expenses);

  // cells[day][colKey] = { sum, items }
  const cells = new Map(days.map((d) => [d, new Map()]));
  const colTotals = new Map(columns.map((c) => [c.key, 0]));
  for (const t of expenses) {
    const key = t.category_id ?? NONE;
    const row = cells.get(t.occurred_on);
    if (!row) continue;
    const cell = row.get(key) ?? { sum: 0, items: [] };
    cell.sum += t.amount_minor;
    cell.items.push(t);
    row.set(key, cell);
    colTotals.set(key, (colTotals.get(key) ?? 0) + t.amount_minor);
  }

  const expenseTotal = expenses.reduce((s, t) => s + t.amount_minor, 0);
  const incomeTotal = incomes.reduce((s, t) => s + t.amount_minor, 0);
  const balance = incomeTotal - expenseTotal;
  els.expense.textContent = formatMoney(expenseTotal);
  els.income.textContent = formatMoney(incomeTotal);
  els.balance.textContent = `${balance < 0 ? '−' : ''}${formatMoney(Math.abs(balance))}`;
  els.balance.className = `stat-value ${balance < 0 ? 'expense' : balance > 0 ? 'income' : ''}`;

  const today = todayIso();

  const head = h('thead', {},
    h('tr', {},
      h('th', { scope: 'col', class: 'pivot-cat month-day' }, 'Дата'),
      columns.map((c) => h('th', { scope: 'col', class: 'num month-col', title: c.name },
        h('span', { class: 'month-col-name', style: { '--chip-color': c.color || 'var(--muted)' } }, c.name))),
      h('th', { scope: 'col', class: 'num pivot-total' }, 'Разом'),
      h('th', { scope: 'col', class: 'month-desc' }, 'Опис'),
    ),
  );

  const body = h('tbody', { class: 'pivot-section section-expense' },
    days.map((day) => {
      const row = cells.get(day);
      const dayTotal = [...row.values()].reduce((s, c) => s + c.sum, 0);
      const weekday = isoToUtc(day).getUTCDay();
      const descriptions = [...new Set([...row.values()].flatMap((c) => c.items.map((t) => t.description)).filter(Boolean))];
      return h('tr', { class: `${weekday === 0 || weekday === 6 ? 'is-weekend' : ''}${day === today ? ' is-today' : ''}` },
        h('th', { scope: 'row', class: 'pivot-cat month-day' },
          h('button', {
            type: 'button', class: 'link-btn month-day-btn', title: 'Відкрити день в «Операціях»',
            onclick: () => { goToDay(day); location.hash = '#/'; },
          }, `${day.slice(8)}.${day.slice(5, 7)}`),
          h('span', { class: 'muted month-weekday' }, weekdayFmt.format(isoToUtc(day))),
        ),
        columns.map((c) => {
          const cell = row.get(c.key);
          const label = `${c.name}, ${day.slice(8)}.${day.slice(5, 7)}`;
          const defaults = { type: 'expense', occurred_on: day, category_id: c.key === NONE ? null : c.key };
          if (!cell) {
            return h('td', { class: 'num month-cell is-empty' },
              h('button', {
                type: 'button', class: 'cell-btn month-add', 'aria-label': `Додати: ${label}`, title: `Додати: ${label}`,
                onclick: () => openTxModal({ defaults, onChanged: load }),
              }, '+'));
          }
          const title = cell.items.map((t) => `${formatMoney(t.amount_minor)}${t.description ? ` — ${t.description}` : ''}`).join('\n');
          return h('td', { class: `num month-cell ${highlightOf(cell.sum)}` },
            h('button', { type: 'button', class: 'cell-btn', title, onclick: () => openCell(cell.items, label, defaults) },
              formatWhole(cell.sum)));
        }),
        h('td', { class: 'num pivot-total' }, dayTotal
          ? h('button', {
            type: 'button', class: 'cell-btn', title: 'Усі операції дня',
            onclick: () => openCell([...row.values()].flatMap((cell) => cell.items),
              `Витрати за ${day.slice(8)}.${day.slice(5, 7)}`, { type: 'expense', occurred_on: day }),
          }, formatWhole(dayTotal))
          : ''),
        h('td', { class: 'month-desc' }, descriptions.join(', ')),
      );
    }),
  );

  const foot = h('tfoot', {},
    h('tr', { class: 'pivot-subtotal month-total' },
      h('th', { scope: 'row', class: 'pivot-cat month-day' }, 'Разом'),
      columns.map((c) => h('td', { class: 'num', title: formatMoney(colTotals.get(c.key) ?? 0) },
        colTotals.get(c.key) ? formatWhole(colTotals.get(c.key)) : '·')),
      h('td', { class: 'num pivot-total month-grand', title: formatMoney(expenseTotal) }, formatWhole(expenseTotal)),
      h('td', {}, ''),
    ),
  );

  els.table.replaceChildren(head, body, foot);
  renderIncome(incomes, incomeTotal);
}

// One transaction: edit it right away; several: pick one from the list (or add another).
function openCell(items, title, defaults) {
  if (items.length === 1) openTxModal({ tx: items[0], onChanged: load });
  else openTxModal({ list: items, title, defaults, onChanged: load });
}

function renderIncome(incomes, total) {
  if (incomes.length === 0) {
    els.incomeList.replaceChildren(h('p', { class: 'muted' }, 'Доходів за місяць немає.'));
    return;
  }
  els.incomeList.replaceChildren(
    h('ul', { class: 'tx-rows' },
      incomes.map((t) => h('li', { class: 'tx-row' },
        h('div', { class: 'tx-main' },
          h('span', { class: 'muted month-income-date' }, `${t.occurred_on.slice(8)}.${t.occurred_on.slice(5, 7)}`),
          h('span', { class: 'chip', style: { '--chip-color': t.category_color || 'var(--muted)' } }, t.category_name ?? 'без категорії'),
          t.description && h('span', { class: 'tx-description' }, t.description),
        ),
        h('span', { class: 'tx-amount income' }, formatSigned('income', t.amount_minor)),
        h('div', { class: 'tx-actions' },
          h('button', { type: 'button', class: 'btn-icon', title: 'Редагувати', 'aria-label': 'Редагувати', onclick: () => openTxModal({ tx: t, onChanged: load }) }, '✎'),
        ),
      )),
    ),
    h('p', { class: 'month-income-total' }, 'Разом ', h('strong', { class: 'income' }, formatMoney(total))),
  );
}

// ---------- wiring ----------

export function initMonthView() {
  els.prev.addEventListener('click', () => setMonth(addMonths(state.month, -1)));
  els.next.addEventListener('click', () => setMonth(addMonths(state.month, 1)));
  els.today.addEventListener('click', () => setMonth(todayIso().slice(0, 7)));
  els.input.addEventListener('change', () => {
    if (/^\d{4}-\d{2}$/.test(els.input.value)) setMonth(els.input.value);
  });
  els.addIncome.addEventListener('click', () => {
    // Default date: today if it is in the shown month, otherwise the 1st.
    const today = todayIso();
    openTxModal({
      defaults: { type: 'income', occurred_on: today.startsWith(state.month) ? today : `${state.month}-01` },
      onChanged: load,
    });
  });
  categories.subscribe(() => { if (state.items.length) render(); });
}

// Called when the view becomes visible: transactions may have changed elsewhere.
export function showMonthView() {
  load();
}
