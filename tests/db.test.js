import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../src/db.js';

const version = (db) => db.pragma('user_version', { simple: true });

test('openDb enables foreign keys', () => {
  const db = openDb(':memory:');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('migrate applies pending migrations in order and is idempotent', () => {
  const db = new Database(':memory:');
  const list = [
    (d) => d.exec('CREATE TABLE a (id INTEGER PRIMARY KEY)'),
    (d) => d.exec('ALTER TABLE a ADD COLUMN name TEXT'),
  ];

  migrate(db, list.slice(0, 1));
  assert.equal(version(db), 1);

  migrate(db, list);
  assert.equal(version(db), 2);
  db.prepare('INSERT INTO a (name) VALUES (?)').run('x');

  migrate(db, list);
  assert.equal(version(db), 2);
  db.close();
});

test('a failing migration rolls back and keeps the previous version', () => {
  const db = new Database(':memory:');
  const list = [
    (d) => d.exec('CREATE TABLE a (id INTEGER PRIMARY KEY)'),
    (d) => {
      d.exec('CREATE TABLE b (id INTEGER PRIMARY KEY)');
      throw new Error('boom');
    },
  ];

  assert.throws(() => migrate(db, list), /boom/);
  assert.equal(version(db), 1);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
  assert.deepEqual(tables, ['a']);
  db.close();
});

test('refuses a database newer than the code', () => {
  const db = new Database(':memory:');
  db.pragma('user_version = 5');
  assert.throws(() => migrate(db, []), /newer than this code supports/);
  db.close();
});
