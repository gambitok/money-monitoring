// "Зведення" view: category × month pivot with drill-down into transactions.
import {
  $, h, api, readPref, writePref, todayIso, isoToUtc, dayFmt, formatMoney, formatSigned, plural, TYPE_LABELS,
} from './lib.js';
import { goToDay } from './transactions-view.js';

const PRESETS = ['3m', '6m', '12m', 'year', 'prevYear'];
const SECTION_ORDER = ['expense', 'income'];
const COUNT_WORDS = ['операція', 'операції', 'операцій'];

const els = {
  presetButtons: [...document.querySelectorAll('#summaryPresets [data-preset]')],
  from: $('summaryFrom'),
  to: $('summaryTo'),
  rangeError: $('summaryRangeError'),
  income: $('summaryIncome'),
  expense: $('summaryExpense'),
  balance: $('summaryBalance'),
  avgExpense: $('summaryAvgExpense'),
  table: $('pivotTable'),
  empty: $('summaryEmpty'),
  drill: $('drilldown'),
  drillTitle: $('drillTitle'),
  drillMeta: $('drillMeta'),
  drillList: $('drillList'),
  drillClose: $('drillClose'),
};

const state = {
  preset: PRESETS.includes(readPref('summaryPreset', '6m')) ? readPref('summaryPreset', '6m') : '6m',
  from: null,
  to: null,
  data: null,
  drill: null, // { type, categoryId (number | 'none' | undefined), month (string | undefined), label }
};

let loadSeq = 0;

// ---------- months ----------

const currentMonth = () => todayIso().slice(0, 7);

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function lastDayOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

function presetRange(preset) {
  const now = currentMonth();
  const year = now.slice(0, 4);
  switch (preset) {
    case '3m': return { from: addMonths(now, -2), to: now };
    case '12m': return { from: addMonths(now, -11), to: now };
    case 'year': return { from: `${year}-01`, to: now };
    case 'prevYear': return { from: `${Number(year) - 1}-01`, to: `${Number(year) - 1}-12` };
    default: return { from: addMonths(now, -5), to: now };
  }
}

const monthShortFmt = new Intl.DateTimeFormat('uk-UA', { month: 'short', timeZone: 'UTC' });
const monthLongFmt = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthDate = (month) => isoToUtc(`${month}-01`);

// Whole hryvnias for the dense table; the exact amount is in the title tooltip.
const wholeFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const formatWhole = (minor) => wholeFmt.format(Math.round(minor / 100));

// ---------- loading ----------

function applyPreset(preset) {
  state.preset = preset;
  writePref('summaryPreset', preset);
  Object.assign(state, presetRange(preset));
  load();
}

function onRangeInput() {
  if (!els.from.value || !els.to.value) return;
  state.preset = null;
  state.from = els.from.value;
  state.to = els.to.value;
  load();
}

async function load() {
  for (const btn of els.presetButtons) btn.setAttribute('aria-pressed', String(btn.dataset.preset === state.preset));
  els.from.value = state.from;
  els.to.value = state.to;
  els.rangeError.textContent = '';

  const seq = ++loadSeq;
  try {
    const data = await api('GET', `/summary?from=${state.from}&to=${state.to}`);
    if (seq !== loadSeq) return;
    state.data = data;
    // A drill-down into a month outside the new range no longer matches the table.
    if (state.drill?.month && !data.months.includes(state.drill.month)) {
      state.drill = null;
      els.drill.hidden = true;
    }
    render(data);
    if (state.drill) loadDrill(); // keep the open drill-down in sync
  } catch (err) {
    if (seq !== loadSeq) return;
    els.rangeError.textContent = err.fields ? Object.values(err.fields).join('. ') : err.message;
  }
}

// ---------- pivot table ----------

function render(data) {
  const { months } = data;
  els.income.textContent = formatMoney(data.income.total);
  els.expense.textContent = formatMoney(data.expense.total);
  els.balance.textContent = `${data.balance.total < 0 ? '−' : ''}${formatMoney(Math.abs(data.balance.total))}`;
  els.balance.className = `stat-value ${data.balance.total < 0 ? 'expense' : data.balance.total > 0 ? 'income' : ''}`;
  els.avgExpense.textContent = formatMoney(Math.round(data.expense.total / months.length));

  const isEmpty = data.income.rows.length === 0 && data.expense.rows.length === 0;
  els.empty.hidden = !isEmpty;
  els.table.hidden = isEmpty;
  if (isEmpty) return;

  const multiYear = months[0].slice(0, 4) !== months.at(-1).slice(0, 4);
  const head = h('thead', {},
    h('tr', {},
      h('th', { class: 'pivot-cat', scope: 'col' }, 'Категорія'),
      months.map((m, i) => h('th', { scope: 'col', class: 'num' },
        monthShortFmt.format(monthDate(m)),
        (multiYear && (i === 0 || m.endsWith('-01'))) && h('span', { class: 'pivot-year' }, m.slice(0, 4)),
      )),
      h('th', { scope: 'col', class: 'num pivot-total' }, 'Разом'),
      h('th', { scope: 'col', class: 'num pivot-avg' }, 'Сер./міс'),
    ),
  );

  const colCount = months.length + 3;
  const bodies = SECTION_ORDER.map((type) => {
    const section = data[type];
    // Heat is relative to the largest single cell of this section.
    const max = Math.max(1, ...section.rows.flatMap((r) => months.map((m) => r.cells[m])));
    return h('tbody', { class: `pivot-section section-${type}` },
      h('tr', { class: 'pivot-section-head' },
        h('th', { colspan: colCount, scope: 'colgroup' }, TYPE_LABELS[type]),
      ),
      section.rows.length === 0
        ? h('tr', {}, h('td', { colspan: colCount, class: 'muted pivot-none' }, 'Немає операцій за період'))
        : section.rows.map((row) => renderRow(type, row, months, max)),
      h('tr', { class: 'pivot-subtotal' },
        h('th', { scope: 'row', class: 'pivot-cat' }, `${TYPE_LABELS[type]} разом`),
        months.map((m) => cell(section.totals[m], { type, month: m, label: `${TYPE_LABELS[type]} · ${monthLongFmt.format(monthDate(m))}` })),
        cell(section.total, { type, label: `${TYPE_LABELS[type]} · весь період` }, 'pivot-total'),
        h('td', { class: 'num pivot-avg' }, formatWhole(section.total / months.length)),
      ),
    );
  });

  const balanceRow = h('tbody', { class: 'pivot-balance' },
    h('tr', {},
      h('th', { scope: 'row', class: 'pivot-cat' }, 'Баланс'),
      months.map((m) => signedCell(data.balance.cells[m])),
      signedCell(data.balance.total, 'pivot-total'),
      signedCell(data.balance.total / months.length, 'pivot-avg'),
    ),
  );

  els.table.replaceChildren(head, ...bodies, balanceRow);
}

function renderRow(type, row, months, max) {
  const name = row.category_id === null ? 'Без категорії' : row.name;
  const categoryId = row.category_id ?? 'none';
  return h('tr', {},
    h('th', { scope: 'row', class: 'pivot-cat' },
      h('button', {
        type: 'button',
        class: `pivot-cat-btn${row.category_id === null ? ' is-none' : ''}`,
        style: { '--chip-color': row.color || 'var(--muted)' },
        title: 'Показати операції за весь період',
        onclick: () => openDrill({ type, categoryId, label: `${name} · весь період` }),
      }, name, row.archived && h('span', { class: 'muted' }, ' (архів)')),
    ),
    months.map((m) => cell(row.cells[m], {
      type, categoryId, month: m, label: `${name} · ${monthLongFmt.format(monthDate(m))}`,
    }, '', row.cells[m] / max)),
    cell(row.total, { type, categoryId, label: `${name} · весь період` }, 'pivot-total'),
    h('td', { class: 'num pivot-avg' }, formatWhole(row.total / months.length)),
  );
}

function cell(minor, drill, extraClass = '', heat = 0) {
  if (minor === 0) return h('td', { class: `num is-zero ${extraClass}` }, '·');
  const isActive = state.drill && sameDrill(state.drill, drill);
  return h('td', { class: `num ${extraClass}${isActive ? ' is-active' : ''}`, style: heat ? { '--heat': heat.toFixed(3) } : null },
    h('button', { type: 'button', class: 'cell-btn', title: `${formatMoney(minor)} — показати операції`, onclick: () => openDrill(drill) },
      formatWhole(minor)),
  );
}

function signedCell(minor, extraClass = '') {
  const rounded = Math.round(minor);
  if (rounded === 0) return h('td', { class: `num is-zero ${extraClass}` }, '0');
  return h('td', { class: `num ${rounded < 0 ? 'expense' : 'income'} ${extraClass}`, title: formatMoney(rounded) },
    `${rounded < 0 ? '−' : '+'}${formatWhole(Math.abs(rounded))}`);
}

// ---------- drill-down ----------

function sameDrill(a, b) {
  return a.type === b.type && a.categoryId === b.categoryId && a.month === b.month;
}

function openDrill(drill) {
  state.drill = drill;
  render(state.data); // highlight the active cell
  loadDrill();
  els.drill.hidden = false;
  els.drill.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeDrill() {
  state.drill = null;
  els.drill.hidden = true;
  if (state.data) render(state.data);
}

async function loadDrill() {
  const { type, categoryId, month, label } = state.drill;
  const from = month ? `${month}-01` : `${state.from}-01`;
  const to = month ? lastDayOfMonth(month) : lastDayOfMonth(state.to);
  const params = new URLSearchParams({ from, to, type });
  if (categoryId !== undefined) params.set('category_id', String(categoryId));

  els.drillTitle.textContent = label;
  try {
    const { items } = await api('GET', `/transactions?${params}`);
    const total = items.reduce((s, t) => s + t.amount_minor, 0);
    els.drillMeta.textContent = `${plural(items.length, COUNT_WORDS)} · ${formatMoney(total)}`;
    els.drillList.replaceChildren(
      items.length === 0
        ? h('p', { class: 'empty' }, 'Операцій немає.')
        : h('ul', { class: 'tx-rows' }, items.map((tx) => renderDrillRow(tx, categoryId === undefined))),
    );
  } catch (err) {
    els.drillList.replaceChildren(h('p', { class: 'empty is-error' }, `Не вдалося завантажити: ${err.message}`));
  }
}

function renderDrillRow(tx, showCategory) {
  return h('li', { class: 'tx-row drill-row' },
    h('div', { class: 'tx-main' },
      h('button', {
        type: 'button', class: 'link-btn drill-date', title: 'Відкрити цей день в «Операціях»',
        onclick: () => { goToDay(tx.occurred_on); location.hash = '#/'; },
      }, dayFmt.format(isoToUtc(tx.occurred_on))),
      showCategory && (tx.category_id
        ? h('span', { class: 'chip', style: { '--chip-color': tx.category_color || 'var(--muted)' } }, tx.category_name)
        : h('span', { class: 'chip chip-empty' }, 'без категорії')),
      tx.description && h('span', { class: 'tx-description' }, tx.description),
    ),
    h('span', { class: `tx-amount ${tx.type}` }, formatSigned(tx.type, tx.amount_minor)),
  );
}

// ---------- wiring ----------

export function initSummaryView() {
  for (const btn of els.presetButtons) btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  els.from.addEventListener('change', onRangeInput);
  els.to.addEventListener('change', onRangeInput);
  els.drillClose.addEventListener('click', closeDrill);
  Object.assign(state, presetRange(state.preset));
}

// Called when the view becomes visible: transactions may have changed elsewhere.
export function showSummaryView() {
  // A relative preset ("last 6 months") follows the calendar if the page stayed open over a month change.
  if (state.preset) Object.assign(state, presetRange(state.preset));
  load();
}
