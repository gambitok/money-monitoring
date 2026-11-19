import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let ctx;
let food;
let fun;
let salary;
let unused;

before(async () => { ctx = await startTestServer(); });
after(async () => { await ctx.close(); });

beforeEach(() => {
  ctx.db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories;');
  const add = ctx.db.prepare('INSERT INTO categories (name, type, color) VALUES (?, ?, ?)');
  food = Number(add.run('Продукти', 'expense', '#16a34a').lastInsertRowid);
  fun = Number(add.run('Інше', 'expense', null).lastInsertRowid);
  unused = Number(add.run('Одяг', 'expense', null).lastInsertRowid);
  salary = Number(add.run('Зарплата', 'income', null).lastInsertRowid);
  const tx = ctx.db.prepare('INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description) VALUES (?, ?, ?, ?, ?)');
  tx.run('expense', 300000, '2026-11-02', food, null);
  tx.run('expense', 120000, '2026-11-10', food, null);
  tx.run('expense', 50000, '2026-11-11', fun, 'кіно');
  tx.run('expense', 7000, '2026-11-12', null, 'подарунок');
  tx.run('income', 1500000, '2026-11-05', salary, null);
  tx.run('expense', 999900, '2026-10-31', food, null); // previous month
});

async function api(method, path, body) {
  const res = await fetch(`${ctx.baseUrl}/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('PUT /api/budgets replaces the whole set; empty amounts are skipped', async () => {
  const put = await api('PUT', '/budgets', { items: [
    { type: 'expense', category_id: null, amount: '30 000' },
    { type: 'income', category_id: null, amount: 20000 },
    { type: 'expense', category_id: food, amount: '5000' },
    { type: 'expense', category_id: fun, amount: '' },
  ] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.items.map((b) => [b.type, b.category_name, b.amount_minor]), [
    ['expense', null, 3000000],
    ['expense', 'Продукти', 500000],
    ['income', null, 2000000],
  ]);

  const again = await api('PUT', '/budgets', { items: [{ type: 'expense', category_id: fun, amount: '100' }] });
  assert.deepEqual(again.body.items.map((b) => b.category_id), [fun]);
  assert.deepEqual((await api('GET', '/budgets')).body, again.body);
});

test('PUT /api/budgets validates every item and saves nothing on error', async () => {
  await api('PUT', '/budgets', { items: [{ type: 'expense', category_id: null, amount: '100' }] });
  const res = await api('PUT', '/budgets', { items: [
    { type: 'expense', category_id: salary, amount: '10' },
    { type: 'x', category_id: null, amount: '10' },
    { type: 'expense', category_id: food, amount: '-5' },
    { type: 'expense', category_id: 9999, amount: '5' },
    { type: 'income', category_id: null, amount: '1' },
    { type: 'income', category_id: null, amount: '2' },
  ] });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.body.fields).sort(), ['items.0', 'items.1', 'items.2', 'items.3', 'items.5']);
  assert.equal((await api('GET', '/budgets')).body.items.length, 1, 'old plans kept');

  assert.equal((await api('PUT', '/budgets', { nope: 1 })).status, 400);
});

test('DB rejects a budget whose category type differs, and duplicates', () => {
  assert.throws(() => ctx.db.prepare("INSERT INTO budgets (type, category_id, amount_minor) VALUES ('income', ?, 100)").run(food), /does not match/);
  ctx.db.prepare("INSERT INTO budgets (type, category_id, amount_minor) VALUES ('expense', NULL, 100)").run();
  assert.throws(() => ctx.db.prepare("INSERT INTO budgets (type, category_id, amount_minor) VALUES ('expense', NULL, 200)").run(), /UNIQUE/);
});

test('changing a category type drops its plan', async () => {
  await api('PUT', '/budgets', { items: [{ type: 'expense', category_id: unused, amount: '100' }] });
  const res = await api('PATCH', `/categories/${unused}`, { type: 'income' });
  assert.equal(res.status, 200);
  assert.deepEqual((await api('GET', '/budgets')).body.items, []);
});

test('GET /api/dashboard: actual vs plan, categories with plan or money, pace info', async () => {
  await api('PUT', '/budgets', { items: [
    { type: 'expense', category_id: null, amount: '10000' },
    { type: 'income', category_id: null, amount: '20000' },
    { type: 'expense', category_id: food, amount: '4000' },
    { type: 'expense', category_id: unused, amount: '1000' },
  ] });
  const { status, body } = await api('GET', '/dashboard?month=2026-11&today=2026-11-19');
  assert.equal(status, 200);
  assert.equal(body.days, 30);
  assert.equal(body.day_of_month, 19);
  assert.deepEqual(body.expense, { actual: 477000, plan: 1000000 });
  assert.deepEqual(body.income, { actual: 1500000, plan: 2000000 });
  assert.equal(body.balance, 1500000 - 477000);
  assert.deepEqual(body.previous, { month: '2026-10', income: 0, expense: 999900 });

  const rows = body.categories.map((c) => [c.type, c.name, c.actual, c.plan]);
  assert.deepEqual(rows, [
    ['expense', 'Продукти', 420000, 400000],
    ['expense', 'Інше', 50000, null],
    ['expense', 'Одяг', 0, 100000],
    ['income', 'Зарплата', 1500000, null],
    ['expense', null, 7000, null],
  ]);
  assert.equal(body.recent.length, 5);
  assert.equal(body.recent[0].occurred_on, '2026-11-12');
});

test('GET /api/dashboard: day_of_month for past/future months and validation', async () => {
  assert.equal((await api('GET', '/dashboard?month=2026-10&today=2026-11-19')).body.day_of_month, 31);
  assert.equal((await api('GET', '/dashboard?month=2026-12&today=2026-11-19')).body.day_of_month, 0);
  assert.equal((await api('GET', '/dashboard?month=2026-13')).status, 400);
});
