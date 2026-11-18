import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await ctx.close(); });
beforeEach(() => ctx.db.exec('DELETE FROM transactions; DELETE FROM categories;'));

async function api(method, path, body) {
  const res = await fetch(`${ctx.baseUrl}/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const createCategory = (body) => api('POST', '/categories', { type: 'expense', ...body });

function addTransaction(categoryId, type = 'expense') {
  ctx.db.prepare(`
    INSERT INTO transactions (type, amount_minor, occurred_on, category_id) VALUES (?, 100, '2026-11-18', ?)
  `).run(type, categoryId);
}

test('POST creates a category', async () => {
  const res = await createCategory({ name: '  Їжа ', color: '#E11D48' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Їжа');
  assert.equal(res.body.color, '#e11d48');
  assert.equal(res.body.archived_at, null);
  assert.equal(res.body.transaction_count, 0);
});

test('POST validates input', async () => {
  const res = await api('POST', '/categories', { name: '', type: 'x', color: 'red' });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.body.fields).sort(), ['color', 'name', 'type']);
});

test('POST rejects a duplicate name within a type, case-insensitively (Cyrillic too)', async () => {
  const { body: food } = await createCategory({ name: 'Їжа' });
  const dup = await createCategory({ name: 'їжа' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.fields.name, /вже є/);
  assert.equal(dup.body.conflict_id, food.id);

  assert.equal((await createCategory({ name: 'Їжа', type: 'income' })).status, 201);
});

test('POST duplicate of an archived category says so', async () => {
  const { body: old } = await createCategory({ name: 'Спорт' });
  await api('PATCH', `/categories/${old.id}`, { archived: true });
  const dup = await createCategory({ name: 'спорт' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.fields.name, /архіві/);
  assert.equal(dup.body.conflict_id, old.id);
});

test('PATCH renames and recolors', async () => {
  const { body: cat } = await createCategory({ name: 'Їжа' });
  const res = await api('PATCH', `/categories/${cat.id}`, { name: 'Продукти', color: '#00ff00' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Продукти');
  assert.equal(res.body.color, '#00ff00');
  assert.equal(res.body.type, 'expense');

  const cleared = await api('PATCH', `/categories/${cat.id}`, { color: null });
  assert.equal(cleared.body.color, null);
  assert.equal(cleared.body.name, 'Продукти');
});

test('PATCH can change only the letter case of its own name', async () => {
  const { body: cat } = await createCategory({ name: 'кава' });
  const res = await api('PATCH', `/categories/${cat.id}`, { name: 'Кава' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Кава');
});

test('PATCH rejects renaming onto another category', async () => {
  await createCategory({ name: 'Їжа' });
  const { body: other } = await createCategory({ name: 'Кафе' });
  assert.equal((await api('PATCH', `/categories/${other.id}`, { name: 'ЇЖА' })).status, 409);
});

test('PATCH type change is allowed only while unused', async () => {
  const { body: cat } = await createCategory({ name: 'Подарунки' });
  const ok = await api('PATCH', `/categories/${cat.id}`, { type: 'income' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.type, 'income');

  addTransaction(cat.id, 'income');
  const bad = await api('PATCH', `/categories/${cat.id}`, { type: 'expense' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.fields.type, /використовується/);
});

test('PATCH archives and restores', async () => {
  const { body: cat } = await createCategory({ name: 'Старе' });
  const archived = await api('PATCH', `/categories/${cat.id}`, { archived: true });
  assert.ok(archived.body.archived_at);
  assert.equal((await api('GET', '/categories')).body.items.length, 0);
  assert.equal((await api('GET', '/categories?include_archived=1')).body.items.length, 1);

  const again = await api('PATCH', `/categories/${cat.id}`, { archived: true });
  assert.equal(again.body.archived_at, archived.body.archived_at, 'archiving twice keeps the first timestamp');

  const restored = await api('PATCH', `/categories/${cat.id}`, { archived: false });
  assert.equal(restored.body.archived_at, null);

  assert.equal((await api('PATCH', `/categories/${cat.id}`, { archived: 'yes' })).status, 400);
});

test('PATCH ignores non-editable fields', async () => {
  const { body: cat } = await createCategory({ name: 'Їжа' });
  const res = await api('PATCH', `/categories/${cat.id}`, { id: 999, created_at: 'x', transaction_count: 5 });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, cat.id);
  assert.equal(res.body.created_at, cat.created_at);
});

test('DELETE removes an unused category', async () => {
  const { body: cat } = await createCategory({ name: 'Тимчасова' });
  const res = await api('DELETE', `/categories/${cat.id}`);
  assert.deepEqual(res.body, { deleted: true, archived: false });
  assert.equal((await api('GET', `/categories/${cat.id}`)).status, 404);
});

test('DELETE archives a used category instead of deleting it', async () => {
  const { body: cat } = await createCategory({ name: 'Їжа' });
  addTransaction(cat.id);
  const res = await api('DELETE', `/categories/${cat.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, false);
  assert.equal(res.body.archived, true);
  assert.ok(res.body.category.archived_at);
  assert.equal(res.body.category.transaction_count, 1);
});

test('GET returns transaction_count', async () => {
  const { body: cat } = await createCategory({ name: 'Їжа' });
  addTransaction(cat.id);
  addTransaction(cat.id);
  const { body } = await api('GET', '/categories');
  assert.equal(body.items[0].transaction_count, 2);
});

test('unknown or malformed ids return 404', async () => {
  for (const id of ['9999', 'abc', '0']) {
    assert.equal((await api('GET', `/categories/${id}`)).status, 404, id);
    assert.equal((await api('PATCH', `/categories/${id}`, { name: 'x' })).status, 404, id);
    assert.equal((await api('DELETE', `/categories/${id}`)).status, 404, id);
  }
});
