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
import type { Migration } from './migrations.js';

function assertStrictlyIncreasingVersions(migrations: readonly Migration[]): void {
  let previousVersion = Number.NEGATIVE_INFINITY;
  for (const migration of migrations) {
    if (migration.version <= previousVersion) {
      throw new Error(
        `migrations must be ordered by strictly increasing version ` +
          `(found ${migration.version} after ${previousVersion})`,
      );
    }
    previousVersion = migration.version;
  }
}

/**
 * Applies pending migrations to an open handle, tracked via
 * `PRAGMA user_version`. Exported for tests and store-internal use;
 * production callers should go through `openDatabase`.
 *
 * Fails closed if the database reports a schema version newer than the
 * newest known migration (i.e. it was written by a newer bridge version).
 */
export function applyMigrations(
  db: DatabaseHandle,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  assertStrictlyIncreasingVersions(migrations);

  const maxVersion = migrations.at(-1)?.version ?? 0;
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion > maxVersion) {
    throw new Error(
      `database user_version ${currentVersion} is ahead of the newest known migration ` +
        `(${maxVersion}); refusing to touch a database written by a newer version (fail closed)`,
    );
  }
  if (currentVersion === maxVersion) {
    return; // fully migrated — do not take a write lock on every open
  }

  for (const migration of migrations) {
    // The version re-check runs INSIDE an immediate (write-locking)
    // transaction: when two fresh processes race on first open, both may see
    // a stale user_version out here, but only the first to take the write
    // lock applies the migration; the loser re-reads the bumped version and
    // skips instead of failing on "table already exists".
    const applyMigration = db.transaction(() => {
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version >= migration.version) {
        return;
      }
      db.exec(migration.sql);
      // PRAGMA does not accept bound parameters; `migration.version` comes
      // from the fixed migrations list validated above, never from external
      // input, so string interpolation here is safe.
      db.pragma(`user_version = ${migration.version}`);
    });
    applyMigration.immediate();
  }
}

const WAL_CONVERSION_DEADLINE_MS = 5000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Database.SqliteError && error.code.startsWith('SQLITE_BUSY');
}

/**
 * Converting a fresh (delete-journal) database into WAL needs an exclusive
 * lock, and when several fresh processes race the conversion SQLite's
 * deadlock avoidance returns SQLITE_BUSY immediately WITHOUT consulting the
 * busy handler — busy_timeout alone does not cover this (observed in a
 * multi-process first-open smoke run). Bounded retry: the winner converts
 * the file, after which the losers' `journal_mode = WAL` is a cheap no-op.
 */
function enableWalJournalMode(db: DatabaseHandle): void {
  const deadline = Date.now() + WAL_CONVERSION_DEADLINE_MS;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) {
        throw error; // fail closed: not a contention error, or out of time
      }
      sleepSync(5 + Math.random() * 10);
    }
  }
}

/**
 * Opens (creating if necessary) the SQLite store at `path`, applies the
 * fixed pragma set (WAL, foreign keys, busy timeout), and runs any pending
 * schema migrations. `':memory:'` is accepted for tests.
 */
export function openDatabase(
  path: string,
  migrations: readonly Migration[] = MIGRATIONS,
): DatabaseHandle {
  const db = new Database(path);

  try {
    // busy_timeout first: it protects every later lock acquisition that DOES
    // consult the busy handler (reads, BEGIN IMMEDIATE in migrations).
    db.pragma('busy_timeout = 5000');
    enableWalJournalMode(db);
    db.pragma('foreign_keys = ON');

    applyMigrations(db, migrations);

    return db;
  } catch (error) {
    // better-sqlite3 handles are not closed by GC; do not leak the file
    // descriptor / lock when open fails partway.
    db.close();
    throw error;
  }
}
