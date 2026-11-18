import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let ctx;
let food;
let salary;
let archived;

before(async () => { ctx = await startTestServer(); });
after(async () => { await ctx.close(); });

beforeEach(() => {
  ctx.db.exec('DELETE FROM transactions; DELETE FROM categories;');
  const add = ctx.db.prepare('INSERT INTO categories (name, type, color, archived_at) VALUES (?, ?, ?, ?)');
  food = Number(add.run('Їжа', 'expense', '#ff0000', null).lastInsertRowid);
  salary = Number(add.run('Зарплата', 'income', null, null).lastInsertRowid);
  archived = Number(add.run('Старе', 'expense', null, '2026-01-01T00:00:00.000Z').lastInsertRowid);
});

async function api(method, path, body) {
  const res = await fetch(`${ctx.baseUrl}/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const create = (body) => api('POST', '/transactions', {
  type: 'expense', amount: '100', occurred_on: '2026-11-18', category_id: food, ...body,
});

test('POST creates a transaction and returns it with category data', async () => {
  const res = await create({ amount: '1 234,50', description: ' кава ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.amount_minor, 123450);
  assert.equal(res.body.description, 'кава');
  assert.equal(res.body.category_name, 'Їжа');
  assert.equal(res.body.category_color, '#ff0000');
  assert.equal(res.body.source, 'manual');
  assert.equal(res.body.currency, 'UAH');
});

test('POST without category requires a description', async () => {
  const res = await create({ category_id: null });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.body.fields), ['description']);

  const ok = await create({ category_id: null, description: 'подарунок' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.category_name, null);
});

test('POST rejects unknown, mismatched and archived categories', async () => {
  for (const [category_id, message] of [[9999, /не знайдено/], [salary, /доходів/], [archived, /архіві/]]) {
    const res = await create({ category_id });
    assert.equal(res.status, 400, String(category_id));
    assert.match(res.body.fields.category_id, message);
  }
});

test('POST ignores fields that are not editable', async () => {
  const res = await create({ source: 'import', import_hash: 'x', id: 777, currency: 'USD' });
  assert.equal(res.status, 201);
  assert.notEqual(res.body.id, 777);
  assert.equal(res.body.source, 'manual');
  assert.equal(res.body.currency, 'UAH');
});

test('POST with malformed JSON returns 400', async () => {
  const res = await fetch(`${ctx.baseUrl}/api/transactions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  });
  assert.equal(res.status, 400);
});

test('GET lists by period with totals, newest first', async () => {
  await create({ amount: '100', occurred_on: '2026-11-16' });
  await create({ amount: '50,25', occurred_on: '2026-11-18' });
  await create({ type: 'income', amount: '1000', occurred_on: '2026-11-17', category_id: salary });
  await create({ amount: '999', occurred_on: '2026-11-25' });

  const res = await api('GET', '/transactions?from=2026-11-16&to=2026-11-22');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((t) => t.occurred_on), ['2026-11-18', '2026-11-17', '2026-11-16']);
  assert.deepEqual(res.body.totals, { income: 100000, expense: 15025, balance: 84975 });
});

test('GET filters by type and category, including uncategorized', async () => {
  await create({});
  await create({ category_id: null, description: 'без категорії' });
  await create({ type: 'income', category_id: salary });

  assert.equal((await api('GET', '/transactions?type=income')).body.items.length, 1);
  assert.equal((await api('GET', `/transactions?category_id=${food}`)).body.items.length, 1);
  const none = await api('GET', '/transactions?category_id=none');
  assert.deepEqual(none.body.items.map((t) => t.description), ['без категорії']);
});

test('GET returns zero totals for an empty period', async () => {
  const res = await api('GET', '/transactions?from=2020-01-01&to=2020-01-31');
  assert.deepEqual(res.body, { items: [], totals: { income: 0, expense: 0, balance: 0 } });
});

test('GET rejects invalid filters', async () => {
  const res = await api('GET', '/transactions?from=2026-02-30&type=x&category_id=abc');
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.body.fields).sort(), ['category_id', 'from', 'type']);
});

test('PATCH merges with the stored row', async () => {
  const { body: created } = await create({ amount: '100', description: 'обід' });

  const res = await api('PATCH', `/transactions/${created.id}`, { amount: '120,5' });
  assert.equal(res.status, 200);
  assert.equal(res.body.amount_minor, 12050);
  assert.equal(res.body.description, 'обід');
  assert.equal(res.body.category_id, food);
  assert.ok(res.body.updated_at >= created.updated_at);

  const dateOnly = await api('PATCH', `/transactions/${created.id}`, { occurred_on: '2026-11-01' });
  assert.equal(dateOnly.body.amount_minor, 12050);
});

test('PATCH applies the description rule to the merged result', async () => {
  const { body: created } = await create({});
  const res = await api('PATCH', `/transactions/${created.id}`, { category_id: null });
  assert.equal(res.status, 400);
  assert.ok(res.body.fields.description);

  const ok = await api('PATCH', `/transactions/${created.id}`, { category_id: null, description: 'щось' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.category_id, null);
});

test('PATCH changing type must also fit the category', async () => {
  const { body: created } = await create({});
  const bad = await api('PATCH', `/transactions/${created.id}`, { type: 'income' });
  assert.equal(bad.status, 400);
  const ok = await api('PATCH', `/transactions/${created.id}`, { type: 'income', category_id: salary });
  assert.equal(ok.status, 200);
});

test('PATCH keeps an already assigned archived category', async () => {
  const id = Number(ctx.db.prepare(`
    INSERT INTO transactions (type, amount_minor, occurred_on, category_id) VALUES ('expense', 100, '2025-12-01', ?)
  `).run(archived).lastInsertRowid);

  const res = await api('PATCH', `/transactions/${id}`, { amount: '200' });
  assert.equal(res.status, 200);
  assert.equal(res.body.category_id, archived);
});

test('DELETE removes the transaction', async () => {
  const { body: created } = await create({});
  assert.equal((await api('DELETE', `/transactions/${created.id}`)).status, 204);
  assert.equal((await api('GET', `/transactions/${created.id}`)).status, 404);
  assert.equal((await api('DELETE', `/transactions/${created.id}`)).status, 404);
});

test('unknown or malformed ids return 404', async () => {
  for (const id of ['9999', 'abc', '0', '-1', '1.5']) {
    assert.equal((await api('GET', `/transactions/${id}`)).status, 404, id);
    assert.equal((await api('PATCH', `/transactions/${id}`, { amount: '1' })).status, 404, id);
  }
});

test('GET /api/categories lists active categories, optionally by type', async () => {
  const all = await api('GET', '/categories');
  assert.deepEqual(all.body.items.map((c) => c.name), ['Їжа', 'Зарплата']); // expense < income

  const expense = await api('GET', '/categories?type=expense');
  assert.deepEqual(expense.body.items.map((c) => c.name), ['Їжа']);

  const withArchived = await api('GET', '/categories?type=expense&include_archived=1');
  assert.equal(withArchived.body.items.length, 2);

  assert.equal((await api('GET', '/categories?type=x')).status, 400);
});

test('GET /api/categories sorts names in Ukrainian alphabetical order', async () => {
  const add = ctx.db.prepare("INSERT INTO categories (name, type) VALUES (?, 'expense')");
  for (const name of ['Ґудзики', 'Аптека', 'Єда', 'Іграшки', 'яблука', 'Бензин']) add.run(name);
  const res = await api('GET', '/categories?type=expense');
  assert.deepEqual(res.body.items.map((c) => c.name),
    ['Аптека', 'Бензин', 'Ґудзики', 'Єда', 'Іграшки', 'Їжа', 'яблука']);
});
