// "Статистика" view: what was bought, for how much and how often — over a period, filtered by
// categories and by description text. Data from GET /api/stats.
import { $, h, api, todayIso, isoToUtc, dayFmt, formatMoney, formatSigned, plural } from './lib.js';
import * as categories from './categories-store.js';
import { goToDay } from './transactions-view.js';
import { openTxModal } from './tx-modal.js';

const COUNT_WORDS = ['операція', 'операції', 'операцій'];
const ALL_TIME = 'all';
const CUSTOM = 'custom';

const els = {
  typeButtons: [...document.querySelectorAll('#statsType [data-type]')],
  period: $('statsPeriod'),
  from: $('statsFrom'),
  to: $('statsTo'),
  query: $('statsQuery'),
  cats: $('statsCats'),
  catsAll: $('statsCatsAll'),
  sum: $('statsSum'),
  count: $('statsCount'),
  avg: $('statsAvg'),
  perMonth: $('statsPerMonth'),
  perMonthHint: $('statsPerMonthHint'),
  error: $('statsError'),
  byCat: $('statsByCat'),
  byMonth: $('statsByMonth'),
  top: $('statsTop'),
  words: $('statsWords'),
  list: $('statsList'),
};

const state = {
  type: 'expense',
  period: String(Number(todayIso().slice(0, 4))), // a year, ALL_TIME or CUSTOM
  from: '',
  to: '',
  selected: new Set(), // category ids (and 'none'); empty = all categories
  years: [],
};

let loadSeq = 0;
let queryTimer;

const monthShortFmt = new Intl.DateTimeFormat('uk-UA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const wholeFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const formatWhole = (minor) => `${wholeFmt.format(Math.round(minor / 100))} ₴`;

// ---------- period ----------

function rangeOf(period) {
  if (period === ALL_TIME) return { from: '', to: '' };
  if (/^\d{4}$/.test(period)) {
    const today = todayIso();
    return { from: `${period}-01-01`, to: period === today.slice(0, 4) ? today : `${period}-12-31` };
  }
  return { from: state.from, to: state.to };
}

// Months the period spans, for "per month": the chosen range, or first..last match for all time.
function monthsSpanned(totals) {
  const from = state.from || totals.first;
  const to = state.to || totals.last;
  if (!from || !to) return 0;
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

async function loadYears() {
  let years = [];
  try {
    ({ years } = await api('GET', '/summary/years'));
  } catch { /* keep the select usable with "all time" only */ }
  state.years = [...new Set([Number(todayIso().slice(0, 4)), ...years])].sort((a, b) => b - a);
  els.period.replaceChildren(
    h('option', { value: ALL_TIME }, 'Весь час'),
    ...state.years.map((y) => h('option', { value: String(y) }, String(y))),
    h('option', { value: CUSTOM, disabled: true }, 'Свій період'),
  );
  els.period.value = state.period;
}

// ---------- filters ----------

function setType(type) {
  state.type = type;
  state.selected.clear(); // categories are per type
  for (const btn of els.typeButtons) btn.setAttribute('aria-checked', String(btn.dataset.type === type));
  renderCategoryChips();
  load();
}

function renderCategoryChips() {
  const list = categories.all()
    .filter((c) => c.type === state.type)
    .sort((a, b) => a.id - b.id);
  const chip = (key, name, color, archived) => h('button', {
    type: 'button',
    class: `chip chip-toggle${archived ? ' is-archived' : ''}`,
    style: color ? { '--chip-color': color } : null,
    'aria-pressed': String(state.selected.has(key)),
    onclick: () => {
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
      renderCategoryChips();
      load();
    },
  }, name);
  els.cats.replaceChildren(
    ...list.map((c) => chip(c.id, c.name, c.color, Boolean(c.archived_at))),
    chip('none', 'Без категорії', null, false),
  );
  els.catsAll.hidden = state.selected.size === 0;
}

function addToQuery(text) {
  const current = els.query.value.trim();
  const parts = current ? current.split(',').map((p) => p.trim()) : [];
  if (!parts.some((p) => p.toLocaleLowerCase('uk') === text.toLocaleLowerCase('uk'))) parts.push(text);
  els.query.value = parts.join(', ');
  load();
  els.query.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- loading ----------

async function load() {
  Object.assign(state, state.period === CUSTOM ? {} : rangeOf(state.period));
  els.from.value = state.from;
  els.to.value = state.to;
  els.period.value = state.period;
  els.error.textContent = '';

  const params = new URLSearchParams({ type: state.type });
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.selected.size) params.set('category_ids', [...state.selected].join(','));
  if (els.query.value.trim()) params.set('q', els.query.value.trim());

  const seq = ++loadSeq;
  try {
    const data = await api('GET', `/stats?${params}`);
    if (seq !== loadSeq) return;
    render(data);
  } catch (err) {
    if (seq !== loadSeq) return;
    els.error.textContent = err.fields ? Object.values(err.fields).join('. ') : err.message;
  }
}

// ---------- rendering ----------

const usdFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const rateFmt = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Small "≈ $X" lines under the tiles at the period's average freelance rate, as in the summary.
function renderUsd(rate, source, values) {
  for (const [id, minor] of Object.entries(values)) {
    const usd = rate && minor !== null ? Math.round(minor / 100 / rate) : null;
    $(id).textContent = usd === null ? '' : `≈ $${usdFmt.format(usd)}`;
  }
  $('statsUsdRate').textContent = rate
    ? `Курс $: ${rateFmt.format(rate)} ₴ — ${source === 'period'
      ? 'середній за період (за доходами з фрилансу)'
      : 'середній за весь час (у цьому періоді курсу немає)'}`
    : '';
}

function render(data) {
  const { totals } = data;
  const months = monthsSpanned(totals);
  const tone = state.type === 'income' ? 'income' : 'expense';
  els.sum.textContent = formatMoney(totals.sum);
  els.sum.className = `stat-value ${tone}`;
  els.count.textContent = String(totals.count);
  els.avg.textContent = formatMoney(totals.avg);
  els.perMonth.textContent = months ? formatMoney(Math.round(totals.sum / months)) : '—';
  els.perMonthHint.textContent = months
    ? `${plural(months, ['місяць', 'місяці', 'місяців'])}, у ${plural(totals.months, ['з них була операція', 'з них були операції', 'з них були операції'])}`
    : '';
  renderUsd(data.usd?.rate, data.usd?.source, {
    statsSumUsd: totals.sum,
    statsAvgUsd: totals.avg,
    statsPerMonthUsd: months ? totals.sum / months : null,
  });

  renderBars(els.byCat, data.byCategory.map((c) => ({
    label: c.category_id === null ? 'Без категорії' : c.name,
    color: c.color,
    sum: c.sum,
    meta: plural(c.count, COUNT_WORDS),
    onclick: () => {
      state.selected = new Set([c.category_id ?? 'none']);
      renderCategoryChips();
      load();
    },
  })), totals.sum);

  renderBars(els.byMonth, data.byMonth.map((m) => ({
    label: monthShortFmt.format(isoToUtc(`${m.month}-01`)),
    sum: m.sum,
    meta: plural(m.count, COUNT_WORDS),
  })), Math.max(0, ...data.byMonth.map((m) => m.sum)), true);

  renderTop(data.topDescriptions);
  renderWords(data.words);
  renderList(data);
}

// share=false: bar length relative to the largest value (months); true: share of the total.
function renderBars(container, rows, base, relativeToMax = false) {
  if (rows.length === 0) {
    container.replaceChildren(h('p', { class: 'empty' }, 'Нічого не знайдено.'));
    return;
  }
  const max = relativeToMax ? base : Math.max(...rows.map((r) => r.sum));
  container.replaceChildren(h('ul', { class: 'bars' }, rows.map((r) => {
    const share = base ? Math.round((r.sum / base) * 100) : 0;
    const label = r.onclick
      ? h('button', { type: 'button', class: 'link-btn bar-label', title: 'Показати лише цю категорію', onclick: r.onclick }, r.label)
      : h('span', { class: 'bar-label' }, r.label);
    return h('li', { class: 'bar-row' },
      label,
      h('span', { class: 'bar-value' }, formatWhole(r.sum), !relativeToMax && h('span', { class: 'muted' }, ` · ${share}%`)),
      h('span', { class: 'bar-track' },
        h('span', { class: 'bar-fill', style: { width: `${max ? (r.sum / max) * 100 : 0}%`, '--chip-color': r.color || 'var(--accent)' } })),
      h('span', { class: 'bar-meta muted' }, r.meta),
    );
  })));
}

function renderTop(rows) {
  if (rows.length === 0) {
    els.top.replaceChildren(h('p', { class: 'empty' }, 'Описів немає.'));
    return;
  }
  els.top.replaceChildren(h('div', { class: 'pivot-wrap' }, h('table', { class: 'pivot stats-table' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Опис'),
      h('th', { scope: 'col', class: 'num', title: 'Скільки різних днів зустрічався цей опис' }, 'Днів'),
      h('th', { scope: 'col', class: 'num' }, 'Сума'),
      h('th', { scope: 'col', class: 'num' }, 'Середня'),
      h('th', { scope: 'col', class: 'num' }, 'Остання'),
    )),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', {}, h('button', { type: 'button', class: 'link-btn', title: 'Шукати цей опис', onclick: () => addToQuery(r.description) }, r.description)),
      h('td', { class: 'num' }, String(r.count)),
      h('td', { class: 'num' }, formatWhole(r.sum)),
      h('td', { class: 'num muted', title: 'Середня сума за день' }, formatWhole(r.avg)),
      h('td', { class: 'num muted' }, `${r.last.slice(8)}.${r.last.slice(5, 7)}.${r.last.slice(2, 4)}`),
    ))),
  )));
}

function renderWords(rows) {
  if (rows.length === 0) {
    els.words.replaceChildren(h('p', { class: 'empty' }, 'Слів немає.'));
    return;
  }
  els.words.replaceChildren(...rows.map((w) => h('button', {
    type: 'button',
    class: 'word-chip',
    title: `${plural(w.count, ['день', 'дні', 'днів'])}, разом ${formatMoney(w.sum)}`,
    onclick: () => addToQuery(w.word),
  }, w.word, h('span', { class: 'muted' }, ` ${w.count} · ${formatWhole(w.sum)}`))));
}

function renderList({ items, totals, truncated }) {
  if (items.length === 0) {
    els.list.replaceChildren(h('p', { class: 'empty' }, 'Операцій за цими фільтрами немає.'));
    return;
  }
  els.list.replaceChildren(
    truncated && h('p', { class: 'muted stats-note' }, `Показано останні ${items.length} з ${totals.count}. Звузьте період або пошук.`),
    h('ul', { class: 'tx-rows' }, items.map((tx) => h('li', { class: 'tx-row drill-row' },
      h('div', { class: 'tx-main' },
        h('button', {
          type: 'button', class: 'link-btn drill-date', title: 'Відкрити цей день в «Операціях»',
          onclick: () => { goToDay(tx.occurred_on); location.hash = '#/ops'; },
        }, `${dayFmt.format(isoToUtc(tx.occurred_on))} ${tx.occurred_on.slice(0, 4)}`),
        tx.category_id
          ? h('span', { class: 'chip', style: { '--chip-color': tx.category_color || 'var(--muted)' } }, tx.category_name)
          : h('span', { class: 'chip chip-empty' }, 'без категорії'),
        tx.description && h('span', { class: 'tx-description' }, tx.description),
      ),
      h('span', { class: `tx-amount ${tx.type}` }, formatSigned(tx.type, tx.amount_minor)),
      h('div', { class: 'tx-actions' },
      h('button', { type: 'button', class: 'btn-icon', title: 'Редагувати', 'aria-label': 'Редагувати', onclick: () => openTxModal({ tx, onChanged: load }) }, '✎'),
    ),
    ))),
  );
}

// ---------- wiring ----------

export function initStatsView() {
  for (const btn of els.typeButtons) btn.addEventListener('click', () => setType(btn.dataset.type));
  els.period.addEventListener('change', () => {
    state.period = els.period.value;
    load();
  });
  for (const input of [els.from, els.to]) {
    input.addEventListener('change', () => {
      state.period = CUSTOM;
      state.from = els.from.value;
      state.to = els.to.value;
      load();
    });
  }
  els.query.addEventListener('input', () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(load, 250);
  });
  els.catsAll.addEventListener('click', () => {
    state.selected.clear();
    renderCategoryChips();
    load();
  });
  categories.subscribe(renderCategoryChips);
}

// Called when the view becomes visible: data and years may have changed elsewhere.
export async function showStatsView() {
  renderCategoryChips();
  await loadYears();
  load();
}
