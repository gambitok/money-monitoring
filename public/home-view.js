// "Головна": the current month at a glance — actual vs plan overall and per category — plus the
// plans editor. Data from GET /api/dashboard; plans from GET/PUT /api/budgets.
import { $, h, api, todayIso, isoToUtc, dayFmt, formatMoney, formatSigned, minorToInput, plural } from './lib.js';
import * as categories from './categories-store.js';
import { openTxModal } from './tx-modal.js';

// Owner's colour rule for spending vs plan: under → green, close (≥ 85 %) → yellow, over → red.
const WARN_SHARE = 0.85;

const els = {
  label: $('homeLabel'),
  prev: $('homePrev'),
  next: $('homeNext'),
  today: $('homeToday'),
  plansBtn: $('homePlans'),
  tiles: $('homeTiles'),
  usdRate: $('homeUsdRate'),
  error: $('homeError'),
  expenseRows: $('homeExpenseRows'),
  incomeRows: $('homeIncomeRows'),
  recent: $('homeRecent'),
};

const state = { month: todayIso().slice(0, 7), data: null };
let loadSeq = 0;

const monthTitleFmt = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthNameFmt = new Intl.DateTimeFormat('uk-UA', { month: 'long', timeZone: 'UTC' });
const usdFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const rateFmt = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const formatWhole = (minor) => `${wholeFmt.format(Math.round(minor / 100))} ₴`;

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

// 'ok' | 'warn' | 'over' for spending; for income reaching the goal is the good outcome.
function statusOf(type, actual, plan) {
  if (!plan) return 'none';
  const share = actual / plan;
  if (type === 'income') return share >= 1 ? 'ok' : 'progress';
  if (share > 1) return 'over';
  return share >= WARN_SHARE ? 'warn' : 'ok';
}

function usdLine(minor) {
  const rate = state.data?.usd?.rate;
  if (!rate) return null;
  const usd = Math.round(minor / 100 / rate);
  return h('span', { class: 'stat-usd' }, `≈ ${usd < 0 ? '−' : ''}$${usdFmt.format(Math.abs(usd))}`);
}

// ---------- loading ----------

function setMonth(month) {
  state.month = month;
  load();
}

async function load() {
  els.label.textContent = monthTitleFmt.format(isoToUtc(`${state.month}-01`));
  els.today.disabled = state.month === todayIso().slice(0, 7);
  els.error.textContent = '';
  const seq = ++loadSeq;
  try {
    const data = await api('GET', `/dashboard?month=${state.month}&today=${todayIso()}`);
    if (seq !== loadSeq) return;
    state.data = data;
    render(data);
  } catch (err) {
    if (seq !== loadSeq) return;
    els.error.textContent = `Не вдалося завантажити: ${err.message}`;
  }
}

// ---------- rendering ----------

function render(data) {
  renderTiles(data);
  const expense = data.categories.filter((c) => c.type === 'expense');
  const income = data.categories.filter((c) => c.type === 'income');
  renderRows(els.expenseRows, expense, 'expense', data);
  renderRows(els.incomeRows, income, 'income', data);
  renderRecent(data.recent);
  els.usdRate.textContent = data.usd
    ? `Курс $: ${rateFmt.format(data.usd.rate)} ₴ — ${data.usd.source === 'period' ? 'середній за місяць (за доходами з фрилансу)' : 'середній за весь час (у цьому місяці курсу немає)'}`
    : '';
}

function progressBar(type, actual, plan, paceShare = null) {
  const status = statusOf(type, actual, plan);
  const share = plan ? Math.min(actual / plan, 1) : 0;
  return h('span', { class: `plan-track plan-${status}` },
    h('span', { class: 'plan-fill', style: { width: `${share * 100}%` } }),
    // Where spending "should" be today if it were spread evenly over the month.
    paceShare !== null && plan && type === 'expense' && h('span', { class: 'plan-pace', style: { left: `${paceShare * 100}%` }, title: 'Рівномірний темп на сьогодні' }),
  );
}

function renderTiles(data) {
  const { income, expense, balance, days, day_of_month: day, previous } = data;
  const pace = day > 0 && day < days ? day / days : null;
  const prevName = monthNameFmt.format(isoToUtc(`${previous.month}-01`));

  const planLine = (type, part) => (part.plan
    ? h('span', { class: `plan-caption plan-text-${statusOf(type, part.actual, part.plan)}` },
      `${Math.round((part.actual / part.plan) * 100)}% з плану ${formatWhole(part.plan)}`)
    : h('span', { class: 'plan-caption muted' }, 'план не задано'));

  // Spending per remaining day if a plan exists; otherwise the average so far.
  let perDay;
  if (expense.plan && day > 0 && day <= days) {
    const daysLeft = days - day + 1;
    const left = expense.plan - expense.actual;
    perDay = left >= 0
      ? h('div', { class: 'stat' },
        h('span', { class: 'stat-label' }, `Можна витрачати / день (${plural(daysLeft, ['день лишився', 'дні лишилося', 'днів лишилося'])})`),
        h('span', { class: 'stat-value' }, formatMoney(Math.floor(left / daysLeft))),
        h('span', { class: 'plan-caption muted' }, `залишок плану ${formatWhole(left)}`))
      : h('div', { class: 'stat' },
        h('span', { class: 'stat-label' }, 'План витрат'),
        h('span', { class: 'stat-value expense' }, `перевищено на ${formatWhole(-left)}`),
        h('span', { class: 'plan-caption muted' }, `${plural(daysLeft, ['день', 'дні', 'днів'])} до кінця місяця`));
  } else {
    const spanDays = day > 0 ? day : days;
    perDay = h('div', { class: 'stat' },
      h('span', { class: 'stat-label' }, 'Витрати в середньому / день'),
      h('span', { class: 'stat-value' }, formatMoney(Math.round(expense.actual / Math.max(1, spanDays)))),
      h('span', { class: 'plan-caption muted' }, expense.plan ? '' : 'задайте план витрат, щоб бачити денний ліміт'));
  }

  const prevDiff = previous.expense ? Math.round(((expense.actual - previous.expense) / previous.expense) * 100) : null;
  els.tiles.replaceChildren(
    h('div', { class: 'stat' },
      h('span', { class: 'stat-label' }, 'Доходи'),
      h('span', { class: 'stat-value income' }, formatMoney(income.actual)),
      usdLine(income.actual),
      planLine('income', income),
      income.plan && progressBar('income', income.actual, income.plan)),
    h('div', { class: 'stat' },
      h('span', { class: 'stat-label' }, 'Витрати'),
      h('span', { class: 'stat-value expense' }, formatMoney(expense.actual)),
      usdLine(expense.actual),
      planLine('expense', expense),
      expense.plan && progressBar('expense', expense.actual, expense.plan, pace),
      prevDiff !== null && h('span', { class: 'plan-caption muted' },
        `${prevName}: ${formatWhole(previous.expense)} (${prevDiff > 0 ? '+' : ''}${prevDiff}%)`)),
    h('div', { class: 'stat' },
      h('span', { class: 'stat-label' }, 'Баланс'),
      h('span', { class: `stat-value ${balance < 0 ? 'expense' : balance > 0 ? 'income' : ''}` }, `${balance < 0 ? '−' : ''}${formatMoney(Math.abs(balance))}`),
      usdLine(balance),
      income.plan && expense.plan && h('span', { class: 'plan-caption muted' },
        `за планом ${income.plan < expense.plan ? '−' : ''}${formatWhole(Math.abs(income.plan - expense.plan))}`)),
    perDay,
  );
}

function renderRows(container, rows, type, data) {
  if (rows.length === 0) {
    container.replaceChildren(h('p', { class: 'empty' }, type === 'expense' ? 'Витрат за місяць немає.' : 'Доходів за місяць немає.'));
    return;
  }
  const { days, day_of_month: day } = data;
  const pace = day > 0 && day < days ? day / days : null;
  // Planned first (most used share on top), then unplanned by amount.
  const sorted = [...rows].sort((a, b) => {
    if (Boolean(a.plan) !== Boolean(b.plan)) return a.plan ? -1 : 1;
    if (a.plan && b.plan) return b.actual / b.plan - a.actual / a.plan;
    return b.actual - a.actual;
  });
  const maxUnplanned = Math.max(1, ...rows.filter((r) => !r.plan).map((r) => r.actual));

  container.replaceChildren(h('ul', { class: 'plan-rows' }, sorted.map((r) => {
    const status = statusOf(type, r.actual, r.plan);
    const name = r.category_id === null ? 'Без категорії' : r.name;
    const amount = r.plan
      ? h('span', { class: `plan-amount plan-text-${status}` }, formatWhole(r.actual), h('span', { class: 'muted' }, ` / ${formatWhole(r.plan)}`))
      : h('span', { class: 'plan-amount' }, formatWhole(r.actual));
    let caption;
    if (!r.plan) caption = 'без плану';
    else if (type === 'expense') {
      caption = r.actual > r.plan
        ? `перевищено на ${formatWhole(r.actual - r.plan)}`
        : `${Math.round((r.actual / r.plan) * 100)}% · лишилось ${formatWhole(r.plan - r.actual)}`;
    } else {
      caption = r.actual >= r.plan ? 'план виконано' : `${Math.round((r.actual / r.plan) * 100)}% · ще ${formatWhole(r.plan - r.actual)}`;
    }
    return h('li', { class: 'plan-row' },
      h('span', { class: 'chip', style: { '--chip-color': r.color || 'var(--muted)' } }, name, r.archived && ' (архів)'),
      amount,
      r.plan
        ? progressBar(type, r.actual, r.plan, pace)
        : h('span', { class: 'plan-track plan-none' }, h('span', { class: 'plan-fill', style: { width: `${(r.actual / maxUnplanned) * 100}%` } })),
      h('span', { class: `plan-caption ${r.plan ? `plan-text-${status}` : 'muted'}` }, caption, r.count ? h('span', { class: 'muted' }, ` · ${plural(r.count, ['операція', 'операції', 'операцій'])}`) : null),
    );
  })));
}

function renderRecent(items) {
  if (items.length === 0) {
    els.recent.replaceChildren(h('p', { class: 'empty' }, 'Операцій за місяць немає.'));
    return;
  }
  els.recent.replaceChildren(h('ul', { class: 'tx-rows' }, items.map((tx) => h('li', { class: 'tx-row drill-row' },
    h('div', { class: 'tx-main' },
      h('span', { class: 'muted drill-date' }, dayFmt.format(isoToUtc(tx.occurred_on))),
      tx.category_id
        ? h('span', { class: 'chip', style: { '--chip-color': tx.category_color || 'var(--muted)' } }, tx.category_name)
        : h('span', { class: 'chip chip-empty' }, 'без категорії'),
      tx.description && h('span', { class: 'tx-description' }, tx.description),
    ),
    h('span', { class: `tx-amount ${tx.type}` }, formatSigned(tx.type, tx.amount_minor)),
    h('div', { class: 'tx-actions' },
      h('button', { type: 'button', class: 'btn-icon', title: 'Редагувати', 'aria-label': 'Редагувати', onclick: () => openTxModal({ tx, onChanged: load }) }, '✎')),
  ))));
}

// ---------- plans editor ----------

let plansDialog = null;

async function openPlans() {
  let budgets;
  try {
    ({ items: budgets } = await api('GET', '/budgets'));
  } catch (err) {
    els.error.textContent = `Не вдалося завантажити плани: ${err.message}`;
    return;
  }
  const current = new Map(budgets.map((b) => [`${b.type}:${b.category_id ?? 'total'}`, b.amount_minor]));
  const inputs = [];
  const field = (type, categoryId, label, color) => {
    const value = current.get(`${type}:${categoryId ?? 'total'}`);
    const input = h('input', { inputmode: 'decimal', placeholder: '—', value: value ? minorToInput(value) : '', 'aria-label': label });
    inputs.push({ type, category_id: categoryId, input });
    return h('label', { class: 'plan-edit-row' },
      color !== undefined
        ? h('span', { class: 'chip', style: { '--chip-color': color || 'var(--muted)' } }, label)
        : h('strong', {}, label),
      h('span', { class: 'plan-edit-input' }, input, h('span', { class: 'muted' }, '₴')));
  };
  const group = (type, title) => h('section', { class: 'plan-edit-group' },
    h('h3', { class: `plan-edit-title ${type}` }, title),
    field(type, null, type === 'expense' ? 'Усі витрати за місяць' : 'Усі доходи за місяць'),
    ...categories.active(type).sort((a, b) => a.id - b.id).map((c) => field(type, c.id, c.name, c.color)),
  );
  const message = h('p', { class: 'form-message is-error', role: 'alert' });

  plansDialog ??= document.body.appendChild(h('dialog', { class: 'modal modal-wide', 'aria-labelledby': 'plansTitle' }));
  const dialog = plansDialog;
  dialog.onclick = (e) => { if (e.target === dialog) dialog.close(); };
  dialog.replaceChildren(h('form', {
    class: 'modal-body plans-form',
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      message.textContent = '';
      for (const { input } of inputs) input.removeAttribute('aria-invalid');
      const items = inputs.map(({ type, category_id, input }) => ({ type, category_id, amount: input.value }));
      try {
        await api('PUT', '/budgets', { items });
        dialog.close();
        load();
      } catch (err) {
        if (err.fields) {
          for (const [key] of Object.entries(err.fields)) {
            const i = Number(key.split('.')[1]);
            inputs[i]?.input.setAttribute('aria-invalid', 'true');
          }
          message.textContent = Object.values(err.fields)[0];
        } else message.textContent = err.message;
      }
    },
  },
    h('div', { class: 'modal-head' },
      h('h2', { id: 'plansTitle', class: 'modal-title' }, 'Плани на місяць'),
      h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Закрити', onclick: () => dialog.close() }, '✕')),
    h('p', { class: 'muted plans-hint' }, 'Діють щомісяця. Порожнє поле — без плану. Колір на головній: менше 85 % плану — зелений, 85–100 % — жовтий, понад план — червоний.'),
    h('div', { class: 'plans-groups' }, group('expense', 'Витрати'), group('income', 'Доходи')),
    message,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'submit', class: 'btn-primary' }, 'Зберегти плани'),
      h('button', { type: 'button', class: 'btn-ghost', onclick: () => dialog.close() }, 'Скасувати')),
  ));
  if (!dialog.open) dialog.showModal();
  inputs[0]?.input.focus();
}

// ---------- wiring ----------

export function initHomeView() {
  els.prev.addEventListener('click', () => setMonth(addMonths(state.month, -1)));
  els.next.addEventListener('click', () => setMonth(addMonths(state.month, 1)));
  els.today.addEventListener('click', () => setMonth(todayIso().slice(0, 7)));
  els.plansBtn.addEventListener('click', openPlans);
}

// Called when the view becomes visible: data may have changed elsewhere.
export function showHomeView() {
  load();
}
