import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Append-only: the array index + 1 is the schema version stored in PRAGMA user_version.
// Never edit or reorder a migration that has already been applied; add a new one instead.
export const migrations = [];

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
