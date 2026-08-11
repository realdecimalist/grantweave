import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const txDepth = new WeakMap<DatabaseSync, number>();

export function transact<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT sp_${depth}`);
  txDepth.set(db, depth + 1);
  try {
    const out = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE sp_${depth}`);
    return out;
  } catch (err) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO sp_${depth}; RELEASE sp_${depth}`);
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

export function lastId(result: { lastInsertRowid: number | bigint }): number {
  return Number(result.lastInsertRowid);
}
