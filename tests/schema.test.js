import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrations, openDb } from '../src/db.js';

let db;
let food;
let salary;

beforeEach(() => {
  db = openDb(':memory:');
  const addCategory = db.prepare('INSERT INTO categories (name, type) VALUES (?, ?)');
  food = addCategory.run('Їжа', 'expense').lastInsertRowid;
  salary = addCategory.run('Зарплата', 'income').lastInsertRowid;
});

afterEach(() => db.close());

function insert(row) {
  const full = { type: 'expense', amount_minor: 100, occurred_on: '2026-11-18', category_id: food, description: null, import_hash: null, ...row };
  return db.prepare(`
    INSERT INTO transactions (type, amount_minor, occurred_on, category_id, description, import_hash)
    VALUES (@type, @amount_minor, @occurred_on, @category_id, @description, @import_hash)
  `).run(full).lastInsertRowid;
}

test('schema is at the latest version', () => {
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
});

test('defaults are filled in', () => {
  const id = insert({});
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  assert.equal(row.currency, 'UAH');
  assert.equal(row.source, 'manual');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(row.updated_at, row.created_at);
});

test('without category a description is required', () => {
  assert.throws(() => insert({ category_id: null }), /CHECK constraint failed/);
  assert.throws(() => insert({ category_id: null, description: '  ' }), /CHECK constraint failed/);
  assert.ok(insert({ category_id: null, description: 'подарунок' }));
});

test('amount must be a positive integer', () => {
  // A numeric string like '100' is coerced to INTEGER by column affinity, so it is not listed here.
  for (const amount_minor of [0, -100, 1.5, 'abc']) {
    assert.throws(() => insert({ amount_minor }), /CHECK constraint failed/, String(amount_minor));
  }
});

test('occurred_on must be a real YYYY-MM-DD date', () => {
  for (const occurred_on of ['2026-02-30', '2026-1-01', '18.11.2026', '2026-11-18 10:00']) {
    assert.throws(() => insert({ occurred_on }), /CHECK constraint failed/, occurred_on);
  }
});

test('category type must match transaction type', () => {
  assert.throws(() => insert({ type: 'income', category_id: food }), /category type does not match/);
  const id = insert({ type: 'income', category_id: salary });
  assert.throws(
    () => db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(food, id),
    /category type does not match/,
  );
  assert.throws(
    () => db.prepare("UPDATE transactions SET type = 'expense' WHERE id = ?").run(id),
    /category type does not match/,
  );
});

test('unknown category fails the foreign key', () => {
  assert.throws(() => insert({ category_id: 9999 }), /FOREIGN KEY constraint failed/);
});

test('a used category cannot be deleted or change type', () => {
  insert({});
  assert.throws(() => db.prepare('DELETE FROM categories WHERE id = ?').run(food), /FOREIGN KEY constraint failed/);
  assert.throws(
    () => db.prepare("UPDATE categories SET type = 'income' WHERE id = ?").run(food),
    /cannot change type/,
  );
  db.prepare("UPDATE categories SET name = 'Продукти' WHERE id = ?").run(food);
});

test('an unused category can change type', () => {
  db.prepare("UPDATE categories SET type = 'income' WHERE id = ?").run(food);
});

test('category name is unique per type', () => {
  assert.throws(() => db.prepare("INSERT INTO categories (name, type) VALUES ('Їжа', 'expense')").run(), /UNIQUE/);
  db.prepare("INSERT INTO categories (name, type) VALUES ('Їжа', 'income')").run();
});

test('import_hash is unique, NULLs are not', () => {
  insert({ import_hash: 'abc' });
  assert.throws(() => insert({ import_hash: 'abc' }), /UNIQUE/);
  insert({});
  insert({});
});
