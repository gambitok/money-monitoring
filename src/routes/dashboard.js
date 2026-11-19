import { Router } from 'express';
import { createUsdRate } from '../usd.js';
import { ValidationError } from '../validate.js';

const RECENT_LIMIT = 8;

function daysIn(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// Home page data for one month: actual vs plan overall and per category.
// GET /api/dashboard?month=YYYY-MM&today=YYYY-MM-DD
//   today (the client's local date) tells how far into the month we are, for pace and
//   "per day left"; omitted or outside the month = the month is over (or not started).
export function dashboardRouter(db) {
  const router = Router();
  const usdRate = createUsdRate(db);

  const totals = db.prepare(`
    SELECT type, coalesce(sum(amount_minor), 0) AS amount, count(*) AS count
    FROM transactions WHERE occurred_on >= @from AND occurred_on <= @to GROUP BY type
  `);
  const byCategory = db.prepare(`
    SELECT type, category_id, sum(amount_minor) AS amount, count(*) AS count
    FROM transactions WHERE occurred_on >= @from AND occurred_on <= @to GROUP BY type, category_id
  `);
  const categories = db.prepare('SELECT id, name, type, color, archived_at FROM categories ORDER BY id');
  const budgets = db.prepare('SELECT type, category_id, amount_minor FROM budgets');
  const recent = db.prepare(`
    SELECT t.id, t.type, t.amount_minor, t.occurred_on, t.category_id, t.description,
           c.name AS category_name, c.color AS category_color
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.occurred_on >= @from AND t.occurred_on <= @to
    ORDER BY t.occurred_on DESC, t.id DESC LIMIT ${RECENT_LIMIT}
  `);

  function totalsFor(from, to) {
    const out = { income: 0, expense: 0 };
    for (const r of totals.all({ from, to })) out[r.type] = r.amount;
    return out;
  }

  router.get('/', (req, res) => {
    const { month, today } = req.query;
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new ValidationError({ month: 'Місяць має бути у форматі РРРР-ММ' });
    }
    const days = daysIn(month);
    const from = `${month}-01`;
    const to = `${month}-${String(days).padStart(2, '0')}`;

    // How far into the month: day number (1..days) if today is inside it, otherwise all/none.
    let dayOfMonth = days;
    if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
      if (today < from) dayOfMonth = 0;
      else if (today <= to) dayOfMonth = Number(today.slice(8));
    }

    const plans = { income: null, expense: null };
    const categoryPlans = new Map();
    for (const b of budgets.all()) {
      if (b.category_id === null) plans[b.type] = b.amount_minor;
      else categoryPlans.set(b.category_id, b.amount_minor);
    }

    const actual = totalsFor(from, to);
    const actualByCategory = new Map(byCategory.all({ from, to }).map((r) => [`${r.type}:${r.category_id ?? 'none'}`, r]));

    // Every category that has a plan or money this month (archived ones only with money).
    const rows = [];
    for (const c of categories.all()) {
      const got = actualByCategory.get(`${c.type}:${c.id}`);
      const plan = categoryPlans.get(c.id) ?? null;
      if (!got && plan === null) continue;
      if (c.archived_at && !got) continue;
      rows.push({
        category_id: c.id, name: c.name, color: c.color, type: c.type, archived: Boolean(c.archived_at),
        actual: got?.amount ?? 0, count: got?.count ?? 0, plan,
      });
    }
    for (const type of ['expense', 'income']) {
      const none = actualByCategory.get(`${type}:none`);
      if (none) rows.push({ category_id: null, name: null, color: null, type, archived: false, actual: none.amount, count: none.count, plan: null });
    }

    const prev = prevMonth(month);
    res.json({
      month,
      days,
      day_of_month: dayOfMonth,
      income: { actual: actual.income, plan: plans.income },
      expense: { actual: actual.expense, plan: plans.expense },
      balance: actual.income - actual.expense,
      categories: rows,
      previous: { month: prev, ...totalsFor(`${prev}-01`, `${prev}-${String(daysIn(prev)).padStart(2, '0')}`) },
      recent: recent.all({ from, to }),
      usd: usdRate({ from, to }),
    });
  });

  return router;
}
