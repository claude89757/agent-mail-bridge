/**
 * SQLite database open + migration entry point (ADR-0001, decision D-P2-9).
 *
 * This module is the only place that constructs a better-sqlite3 handle;
 * everything else in the store layer receives an already-open `Database`.
 * Only modules under `src/store/` may import `better-sqlite3` directly.
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

import { MIGRATIONS } from './migrations.js';

function applyMigrations(db: DatabaseHandle): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      // PRAGMA does not accept bound parameters; `migration.version` comes
      // from the fixed MIGRATIONS table in ./migrations.ts, never from
      // external input, so string interpolation here is safe.
      db.pragma(`user_version = ${migration.version}`);
    });
    applyMigration();
  }
}

/**
 * Opens (creating if necessary) the SQLite store at `path`, applies the
 * fixed pragma set (WAL, foreign keys, busy timeout), and runs any pending
 * schema migrations. `':memory:'` is accepted for tests.
 */
export function openDatabase(path: string): DatabaseHandle {
  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  applyMigrations(db);

  return db;
}
