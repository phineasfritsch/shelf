// SQLite via node:sqlite. One file, WAL, synchronous=FULL. Schema created at boot.
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ua TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip, at);
CREATE TABLE IF NOT EXISTS link_tokens (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS doc_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  len INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  has_thumb INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_expires ON files(expires_at);
`;

export class SchemaError extends Error {}

// Returns { db, meta: { get(key), set(key, value), del(key) }, transaction(fn), close() }.
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=FULL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(DDL);

  const getStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setStmt = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const delStmt = db.prepare('DELETE FROM meta WHERE key = ?');
  const meta = {
    get: (key) => getStmt.get(key)?.value ?? null,
    set: (key, value) => { setStmt.run(key, String(value)); },
    del: (key) => { delStmt.run(key); },
  };

  const existing = meta.get('schema_version');
  if (existing === null) meta.set('schema_version', String(SCHEMA_VERSION));
  else if (Number(existing) > SCHEMA_VERSION) {
    db.close();
    throw new SchemaError(`data directory was written by a newer version (schema ${existing}, this build understands ${SCHEMA_VERSION}); refusing to start`);
  }

  // Runs fn inside BEGIN IMMEDIATE / COMMIT; rolls back on throw. Not re-entrant.
  let inTx = false;
  function transaction(fn) {
    if (inTx) return fn();
    db.exec('BEGIN IMMEDIATE');
    inTx = true;
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    finally { inTx = false; }
  }

  return {
    db,
    meta,
    transaction,
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {} db.close(); },
  };
}
