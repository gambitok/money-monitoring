import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Append-only: the array index + 1 is the schema version stored in PRAGMA user_version.
// Never edit or reorder a migration that has already been applied; add a new one instead.
export const migrations = [
  // 1: categories and transactions
  (db) => db.exec(`
    CREATE TABLE categories (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
      type        TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      color       TEXT,
      archived_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (name, type)
    );

    CREATE TABLE transactions (
      id           INTEGER PRIMARY KEY,
      type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
      currency     TEXT NOT NULL DEFAULT 'UAH' CHECK (length(currency) = 3),
      occurred_on  TEXT NOT NULL CHECK (date(occurred_on) IS occurred_on),
      category_id  INTEGER REFERENCES categories (id) ON DELETE RESTRICT,
      description  TEXT,
      source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
      import_hash  TEXT UNIQUE,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      -- No category means the description is the only hint of what the money was for.
      CHECK (category_id IS NOT NULL OR length(trim(coalesce(description, ''))) > 0)
    );

    CREATE INDEX transactions_occurred_on ON transactions (occurred_on);
    CREATE INDEX transactions_category_id ON transactions (category_id);

    -- A transaction may only use a category of the same type (income/expense).
    CREATE TRIGGER transactions_category_type_insert
    BEFORE INSERT ON transactions
    WHEN NEW.category_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND type IS NOT NEW.type)
    BEGIN
      SELECT RAISE(ABORT, 'category type does not match transaction type');
    END;

    CREATE TRIGGER transactions_category_type_update
    BEFORE UPDATE OF type, category_id ON transactions
    WHEN NEW.category_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND type IS NOT NEW.type)
    BEGIN
      SELECT RAISE(ABORT, 'category type does not match transaction type');
    END;

    -- Changing a category's type would silently break every transaction already using it.
    CREATE TRIGGER categories_type_locked
    BEFORE UPDATE OF type ON categories
    WHEN NEW.type IS NOT OLD.type
     AND EXISTS (SELECT 1 FROM transactions WHERE category_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'cannot change type of a category that has transactions');
    END;
  `),

  // 2: the owner's starter categories. Runs once: categories deleted later do not come back.
  (db) => seedCategories(db, DEFAULT_CATEGORIES_V2),
];

// Frozen snapshot used by migration 2. Do not edit: a changed list would not reach databases
// that already ran it. Add a new migration for new defaults instead.
export const DEFAULT_CATEGORIES_V2 = Object.freeze([
  ['expense', 'Продукти', '#16a34a'],
  ['expense', 'Цигарки', '#78716c'],
  ['expense', 'Алкоголь', '#9333ea'],
  ['expense', 'Кафе, ресторани, доставка', '#ea580c'],
  ['expense', 'Транспорт', '#2563eb'],
  ['expense', 'Товари для дому', '#ca8a04'],
  ['expense', 'Одяг', '#db2777'],
  ['expense', 'Комунальні платежі', '#0891b2'],
  ['expense', 'Підписки', '#4f46e5'],
  ['expense', "Здоров'я", '#e11d48'],
  ['expense', 'Інше', '#6b7280'],
  ['income', 'Зарплата (державна)', '#2563eb'],
  ['income', 'Зарплата (IT-компанія)', '#16a34a'],
  ['income', 'Фриланс', '#ca8a04'],
  ['income', 'Виведення криптовалюти', '#9333ea'],
  ['income', 'Інші доходи', '#6b7280'],
]);

// Skips names that already exist in the same type, case-insensitively (Cyrillic included).
function seedCategories(db, list) {
  const existing = new Set(
    db.prepare('SELECT type, name FROM categories').all()
      .map((c) => `${c.type}:${c.name.toLocaleLowerCase('uk')}`),
  );
  const insert = db.prepare('INSERT INTO categories (type, name, color) VALUES (?, ?, ?)');
  for (const [type, name, color] of list) {
    if (!existing.has(`${type}:${name.toLocaleLowerCase('uk')}`)) insert.run(type, name, color);
  }
}

export function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

export function migrate(db, list = migrations) {
  const current = db.pragma('user_version', { simple: true });

  if (current > list.length) {
    throw new Error(
      `Database schema version ${current} is newer than this code supports (${list.length}).`,
    );
  }

  for (let version = current + 1; version <= list.length; version++) {
    db.transaction(() => {
      list[version - 1](db);
      db.pragma(`user_version = ${version}`);
    })();
  }
}
