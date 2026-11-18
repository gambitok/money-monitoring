import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let ctx;
let food;
let transport;
let salary;
let old;

before(async () => { ctx = await startTestServer(); });
after(async () => { await ctx.close(); });

beforeEach(() => {
  ctx.db.exec('DELETE FROM transactions; DELETE FROM categories;');
  const add = ctx.db.prepare('INSERT INTO categories (name, type, color, archived_at) VALUES (?, ?, ?, ?)');
  food = Number(add.run('Продукти', 'expense', '#16a34a', null).lastInsertRowid);
  transport = Number(add.run('Транспорт', 'expense', '#2563eb', null).lastInsertRowid);
  salary = Number(add.run('Зарплата', 'income', null, null).lastInsertRowid);
  old = Number(add.run('Старе', 'expense', null, '2026-01-01T00:00:00.000Z').lastInsertRowid);
  add.run('Порожня', 'expense', null, null); // no transactions: must not get a row
});

function tx(type, amount_minor, occurred_on, category_id = null, description = category_id ? null : 'щось') {
  ctx.db.prepare(`
    INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description) VALUES (?, ?, ?, ?, ?)
  `).run(type, amount_minor, occurred_on, category_id, description);
}

async function summary(query) {
  const res = await fetch(`${ctx.baseUrl}/api/summary?${query}`);
  return { status: res.status, body: await res.json() };
}

test('pivots expenses and income by category and month', async () => {
  tx('expense', 1000, '2026-09-01', food);
  tx('expense', 2500, '2026-09-30', food);
  tx('expense', 700, '2026-10-15', food);
  tx('expense', 400, '2026-10-02', transport);
  tx('income', 50000, '2026-10-05', salary);
  tx('expense', 999, '2026-08-31', food); // before range
  tx('expense', 999, '2026-12-01', food); // after range

  const { status, body } = await summary('from=2026-09&to=2026-11');
  assert.equal(status, 200);
  assert.deepEqual(body.months, ['2026-09', '2026-10', '2026-11']);

  const [foodRow, transportRow] = body.expense.rows;
  assert.equal(foodRow.name, 'Продукти');
  assert.equal(foodRow.color, '#16a34a');
  assert.deepEqual(foodRow.cells, { '2026-09': 3500, '2026-10': 700, '2026-11': 0 });
  assert.deepEqual(foodRow.counts, { '2026-09': 2, '2026-10': 1, '2026-11': 0 });
  assert.equal(foodRow.total, 4200);
  assert.equal(foodRow.count, 3);
  assert.equal(transportRow.total, 400);
  assert.equal(body.expense.rows.length, 2, 'categories without money in range get no row');

  assert.deepEqual(body.expense.totals, { '2026-09': 3500, '2026-10': 1100, '2026-11': 0 });
  assert.equal(body.expense.total, 4600);
  assert.deepEqual(body.income.totals, { '2026-09': 0, '2026-10': 50000, '2026-11': 0 });
  assert.deepEqual(body.balance, {
    cells: { '2026-09': -3500, '2026-10': 48900, '2026-11': 0 },
    total: 45400,
  });
});

test('rows are sorted by total, uncategorized last, archived included', async () => {
  tx('expense', 100, '2026-10-01', food);
  tx('expense', 5000, '2026-10-01', null, 'подарунок');
  tx('expense', 300, '2026-10-01', old);
  tx('expense', 200, '2026-10-01', transport);

  const { body } = await summary('from=2026-10&to=2026-10');
  assert.deepEqual(body.expense.rows.map((r) => r.name), ['Старе', 'Транспорт', 'Продукти', null]);
  assert.equal(body.expense.rows.at(-1).category_id, null);
  assert.equal(body.expense.rows[0].archived, true);
  assert.equal(body.expense.rows[1].archived, false);
});

test('spans years', async () => {
  tx('expense', 100, '2025-12-31', food);
  tx('expense', 200, '2026-01-01', food);
  const { body } = await summary('from=2025-11&to=2026-02');
  assert.deepEqual(body.months, ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(body.expense.rows[0].cells, { '2025-11': 0, '2025-12': 100, '2026-01': 200, '2026-02': 0 });
});

test('empty range returns zero totals and no rows', async () => {
  const { body } = await summary('from=2020-01&to=2020-02');
  assert.deepEqual(body.expense, { rows: [], totals: { '2020-01': 0, '2020-02': 0 }, total: 0 });
  assert.equal(body.balance.total, 0);
});

test('GET /api/summary/years lists years with transactions, newest first', async () => {
  const empty = await fetch(`${ctx.baseUrl}/api/summary/years`).then((r) => r.json());
  assert.deepEqual(empty, { years: [] });

  tx('expense', 100, '2024-04-13', food);
  tx('expense', 100, '2026-01-01', food);
  tx('income', 100, '2025-12-31', salary);
  const { years } = await fetch(`${ctx.baseUrl}/api/summary/years`).then((r) => r.json());
  assert.deepEqual(years, [2026, 2025, 2024]);
});

test('usd rate: weighted average of the period, all-time fallback, null without data', async () => {
  assert.equal((await summary('from=2025-01&to=2025-12')).body.usd, null);

  tx('income', 8899200, '2025-02-01', salary, '$2160 за курсом 41,2'); // 88 992 UAH
  tx('income', 2869600, '2025-12-01', salary, '$680 за курсом 42,2'); // 28 696 UAH
  tx('income', 1000000, '2025-03-01', salary, 'без курсу');

  const year = (await summary('from=2025-01&to=2025-12')).body.usd;
  assert.deepEqual(year, { rate: Math.round(((88992 + 28696) / (2160 + 680)) * 100) / 100, source: 'period' });

  const dec = (await summary('from=2025-12&to=2025-12')).body.usd;
  assert.deepEqual(dec, { rate: 42.2, source: 'period' });

  const before = (await summary('from=2024-01&to=2024-12')).body.usd;
  assert.equal(before.source, 'all');
  assert.equal(before.rate, year.rate);
});

test('validates the range', async () => {
  for (const [query, field] of [
    ['from=2026-13&to=2026-12', 'from'],
    ['from=2026-01', 'to'],
    ['from=2026-1&to=2026-02', 'from'],
    ['from=2026-05&to=2026-04', 'to'],
    ['from=2020-01&to=2025-01', 'to'], // 61 months
  ]) {
    const { status, body } = await summary(query);
    assert.equal(status, 400, query);
    assert.ok(body.fields[field], `${query} → ${field}`);
  }
  assert.equal((await summary('from=2021-01&to=2025-12')).status, 200, '60 months is allowed');
});
