import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { matchesQuery, parseQuery } from '../src/routes/stats.js';

let ctx;
let food;
let fun;
let salary;

before(async () => { ctx = await startTestServer(); });
after(async () => { await ctx.close(); });

beforeEach(() => {
  ctx.db.exec('DELETE FROM transactions; DELETE FROM categories;');
  const add = ctx.db.prepare('INSERT INTO categories (name, type, color) VALUES (?, ?, ?)');
  food = Number(add.run('Продукти', 'expense', '#16a34a').lastInsertRowid);
  fun = Number(add.run('Інше', 'expense', '#6b7280').lastInsertRowid);
  salary = Number(add.run('Зарплата', 'income', null).lastInsertRowid);

  const tx = ctx.db.prepare('INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description) VALUES (?, ?, ?, ?, ?)');
  tx.run('expense', 40000, '2026-01-06', fun, 'steam');
  tx.run('expense', 32300, '2026-03-14', fun, 'Steam');
  tx.run('expense', 25000, '2026-02-10', fun, 'lifecell');
  tx.run('expense', 120000, '2026-02-11', food, 'Кава АТБ сільпо');
  tx.run('expense', 5000, '2026-02-12', food, 'кава');
  tx.run('expense', 9900, '2025-12-31', food, 'кава стіки');
  tx.run('expense', 7000, '2026-02-20', null, 'подарунок');
  tx.run('income', 1000000, '2026-02-01', salary, 'аванс');
});

async function stats(query = '') {
  const res = await fetch(`${ctx.baseUrl}/api/stats?${query}`);
  return { status: res.status, body: await res.json() };
}

test('parseQuery / matchesQuery: commas are OR, spaces are AND, case-insensitive Cyrillic', () => {
  assert.deepEqual(parseQuery('Steam, кава АТБ'), [['steam'], ['кава', 'атб']]);
  assert.deepEqual(parseQuery('  ,  '), []);
  assert.equal(matchesQuery('КАВА атб сільпо', parseQuery('кава атб')), true);
  assert.equal(matchesQuery('кава сільпо', parseQuery('кава атб')), false);
  assert.equal(matchesQuery('lifecell', parseQuery('steam, lifecell')), true);
  assert.equal(matchesQuery(null, parseQuery('x')), false);
  assert.equal(matchesQuery(null, []), true);
});

test('defaults to expenses over all time with totals', async () => {
  const { status, body } = await stats();
  assert.equal(status, 200);
  assert.equal(body.totals.count, 7);
  assert.equal(body.totals.sum, 40000 + 32300 + 25000 + 120000 + 5000 + 9900 + 7000);
  assert.equal(body.totals.max, 120000);
  assert.equal(body.totals.first, '2025-12-31');
  assert.equal(body.totals.last, '2026-03-14');
  assert.equal(body.totals.months, 4);
  assert.equal(body.truncated, false);
});

test('filters by period, category (incl. none) and description', async () => {
  const feb = await stats('from=2026-02-01&to=2026-02-28');
  assert.equal(feb.body.totals.count, 4);

  const onlyFood = await stats(`category_ids=${food}`);
  assert.deepEqual(onlyFood.body.byCategory.map((c) => c.name), ['Продукти']);

  const foodAndNone = await stats(`category_ids=${food},none`);
  assert.equal(foodAndNone.body.totals.count, 4);

  const steam = await stats('q=STEAM');
  assert.equal(steam.body.totals.count, 2);
  assert.equal(steam.body.totals.sum, 72300);
  assert.equal(steam.body.totals.avg, 36150);

  const coffeeAtb = await stats('q=кава атб');
  assert.deepEqual(coffeeAtb.body.items.map((t) => t.description), ['Кава АТБ сільпо']);

  const either = await stats(`q=${encodeURIComponent('steam, lifecell')}`);
  assert.equal(either.body.totals.count, 3);

  const income = await stats('type=income');
  assert.deepEqual(income.body.items.map((t) => t.description), ['аванс']);
});

test('groups: by category, by month, identical descriptions, words', async () => {
  const { body } = await stats();
  assert.deepEqual(body.byCategory.map((c) => [c.name, c.count]), [['Продукти', 3], ['Інше', 3], [null, 1]]);
  assert.deepEqual(body.byMonth.map((m) => m.month), ['2025-12', '2026-01', '2026-02', '2026-03']);

  const steam = body.topDescriptions.find((d) => d.description.toLowerCase() === 'steam');
  assert.deepEqual({ count: steam.count, sum: steam.sum, avg: steam.avg, last: steam.last }, { count: 2, sum: 72300, avg: 36150, last: '2026-03-14' });
  assert.equal(body.topDescriptions[0].count, 2);

  const coffee = body.words.find((w) => w.word === 'кава');
  assert.deepEqual({ count: coffee.count, sum: coffee.sum }, { count: 3, sum: 120000 + 5000 + 9900 });
});

test('descriptions and words count distinct days, not split amounts', async () => {
  const tx = ctx.db.prepare('INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description) VALUES (?, ?, ?, ?, ?)');
  tx.run('expense', 60000, '2026-01-17', fun, 'кіно піца стрижка');
  tx.run('expense', 30000, '2026-01-17', food, 'кіно піца стрижка');
  const { body } = await stats('q=піца');
  const row = body.topDescriptions.find((d) => d.description === 'кіно піца стрижка');
  assert.deepEqual({ count: row.count, sum: row.sum, avg: row.avg }, { count: 1, sum: 90000, avg: 90000 });
  assert.equal(body.words.find((w) => w.word === 'кіно').count, 1);
  assert.equal(body.totals.count, 2, 'totals still count transactions');
});

test('words skip the searched words themselves', async () => {
  const { body } = await stats('q=кава');
  assert.ok(!body.words.some((w) => w.word === 'кава'));
  assert.ok(body.words.some((w) => w.word === 'атб'));
});

test('usd rate for the period, all-time fallback', async () => {
  assert.equal((await stats()).body.usd, null);
  const tx = ctx.db.prepare('INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description) VALUES (?, ?, ?, ?, ?)');
  tx.run('income', 4300000, '2026-02-01', salary, '$1000 за курсом 43');
  assert.deepEqual((await stats('from=2026-02-01&to=2026-02-28')).body.usd, { rate: 43, source: 'period' });
  assert.deepEqual((await stats('from=2025-01-01&to=2025-12-31')).body.usd, { rate: 43, source: 'all' });
  assert.deepEqual((await stats()).body.usd, { rate: 43, source: 'period' });
});

test('validates parameters', async () => {
  const res = await stats('from=2026-02-30&type=x&category_ids=abc');
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.body.fields).sort(), ['category_ids', 'from', 'type']);
});
