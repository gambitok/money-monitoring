import { Router } from 'express';
import { ValidationError } from '../validate.js';

export const MAX_MONTHS = 60;

const collator = new Intl.Collator('uk', { sensitivity: 'base', numeric: true });

function isValidMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
    && Number(value.slice(0, 4)) >= 1900 && Number(value.slice(0, 4)) <= 2100;
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function monthRange(from, to) {
  const months = [];
  for (let m = from; m <= to; m = nextMonth(m)) months.push(m);
  return months;
}

// Pivot "category × month" for income and expense.
// Query: from, to as 'YYYY-MM' (inclusive). Only categories with money in the range get a row;
// archived ones included. Transactions without a category form a row with category_id null.
// Rows are sorted by total descending (the "no category" row last), totals are per month.
export function summaryRouter(db) {
  const router = Router();

  const aggregate = db.prepare(`
    SELECT t.type, t.category_id, c.name, c.color, c.archived_at,
           substr(t.occurred_on, 1, 7) AS month, sum(t.amount_minor) AS amount, count(*) AS count
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.occurred_on >= @start AND t.occurred_on < @end
    GROUP BY t.type, t.category_id, month
  `);

  router.get('/', (req, res) => {
    const { from, to } = req.query;
    const errors = {};
    if (!isValidMonth(from)) errors.from = 'Місяць має бути у форматі РРРР-ММ';
    if (!isValidMonth(to)) errors.to = 'Місяць має бути у форматі РРРР-ММ';
    if (!errors.from && !errors.to) {
      if (from > to) errors.to = 'Кінець періоду раніше за початок';
      else if (monthRange(from, to).length > MAX_MONTHS) errors.to = `Період не довший за ${MAX_MONTHS} місяців`;
    }
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);

    const months = monthRange(from, to);
    const sections = { income: newSection(months), expense: newSection(months) };
    const rowsByKey = { income: new Map(), expense: new Map() };

    for (const r of aggregate.all({ start: `${from}-01`, end: `${nextMonth(to)}-01` })) {
      const section = sections[r.type];
      const key = r.category_id ?? 'none';
      let row = rowsByKey[r.type].get(key);
      if (!row) {
        row = {
          category_id: r.category_id,
          name: r.category_id === null ? null : r.name,
          color: r.color ?? null,
          archived: Boolean(r.archived_at),
          cells: zeroCells(months),
          counts: zeroCells(months),
          total: 0,
          count: 0,
        };
        rowsByKey[r.type].set(key, row);
        section.rows.push(row);
      }
      row.cells[r.month] += r.amount;
      row.counts[r.month] += r.count;
      row.total += r.amount;
      row.count += r.count;
      section.totals[r.month] += r.amount;
      section.total += r.amount;
    }

    for (const section of Object.values(sections)) {
      section.rows.sort((a, b) => {
        if ((a.category_id === null) !== (b.category_id === null)) return a.category_id === null ? 1 : -1;
        return b.total - a.total || collator.compare(a.name ?? '', b.name ?? '');
      });
    }

    const balance = { cells: zeroCells(months), total: sections.income.total - sections.expense.total };
    for (const m of months) balance.cells[m] = sections.income.totals[m] - sections.expense.totals[m];

    res.json({ from, to, months, ...sections, balance });
  });

  return router;
}

function zeroCells(months) {
  return Object.fromEntries(months.map((m) => [m, 0]));
}

function newSection(months) {
  return { rows: [], totals: zeroCells(months), total: 0 };
}
