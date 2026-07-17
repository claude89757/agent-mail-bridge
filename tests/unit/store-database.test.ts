import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, openDatabase } from '../../src/store/database.js';
import type { Migration } from '../../src/store/migrations.js';

// Tests must not import better-sqlite3 directly (only src/store/** may);
// derive the handle type from the public API instead.
type Db = ReturnType<typeof openDatabase>;

function listTables(db: Db): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

// Guards decision D-P2-9 (SQLite schema v1) and the pragma/migration contract
// that the rest of the store layer depends on.
describe('openDatabase (D-P2-9 schema v1)', () => {
  it('bumps user_version to 1 on a fresh in-memory database', () => {
    const db = openDatabase(':memory:');

    const userVersion = db.pragma('user_version', { simple: true });

    expect(userVersion).toBe(1);
    db.close();
  });

  it('creates the meta/uid_watermark/commands/dispatch_intents/outbox tables', () => {
    const db = openDatabase(':memory:');

    expect(listTables(db)).toEqual(
      expect.arrayContaining([
        'meta',
        'uid_watermark',
        'commands',
        'dispatch_intents',
        'outbox',
      ]),
    );
    db.close();
  });

  it('does not leave the journal mode at the default delete mode', () => {
    const db = openDatabase(':memory:');

    // better-sqlite3 reports 'memory' for :memory: databases even though WAL
    // was requested (in-memory databases cannot use WAL); the contract that
    // matters here is that we asked for WAL and did not silently stay on the
    // default 'delete' mode. The file-backed test below asserts real 'wal'.
    const journalMode = db.pragma('journal_mode', { simple: true });

    expect(journalMode).not.toBe('delete');
    db.close();
  });

  it('enables foreign key enforcement', () => {
    const db = openDatabase(':memory:');

    const foreignKeys = db.pragma('foreign_keys', { simple: true });

    expect(foreignKeys).toBe(1);
    db.close();
  });

  it('applies the 5000ms busy timeout', () => {
    const db = openDatabase(':memory:');

    const busyTimeout = db.pragma('busy_timeout', { simple: true });

    expect(busyTimeout).toBe(5000);
    db.close();
  });

  describe('file-backed databases', () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'amb-store-database-test-'));
      dbPath = join(dir, 'amb.sqlite3');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('re-opening is idempotent (user_version stays 1) and journaling is really WAL', () => {
      const first = openDatabase(dbPath);
      first.close();

      const second = openDatabase(dbPath);

      expect(second.pragma('user_version', { simple: true })).toBe(1);
      expect(second.pragma('journal_mode', { simple: true })).toBe('wal');
      second.close();
    });

    it('fails closed when user_version is ahead of the newest known migration', () => {
      const db = openDatabase(dbPath);
      db.pragma('user_version = 99');
      db.close();

      // A database written by a newer bridge version must not be opened (and
      // possibly corrupted) by an older one — project red line: fail closed.
      expect(() => openDatabase(dbPath)).toThrow(
        /ahead of the newest known migration/,
      );
    });

    it('rolls back a failed migration completely (no version bump, no partial tables)', () => {
      const failing: Migration[] = [
        {
          version: 1,
          sql: 'CREATE TABLE half_done (id INTEGER) STRICT;\nTHIS IS NOT VALID SQL;',
        },
      ];

      expect(() => openDatabase(dbPath, failing)).toThrow();

      // Re-open with no migrations to inspect the raw persisted state.
      const db = openDatabase(dbPath, []);
      expect(db.pragma('user_version', { simple: true })).toBe(0);
      expect(listTables(db)).not.toContain('half_done');
      db.close();
    });
  });
});

describe('applyMigrations', () => {
  // Deterministic stand-in for the two-process first-open race: the version
  // re-check runs INSIDE the immediate (write-locking) transaction, so a
  // migration whose version is already applied must be skipped — its SQL is
  // deliberately invalid here, so any attempt to execute it would throw.
  it('skips already-applied versions via the in-transaction re-check', () => {
    const db = openDatabase(':memory:'); // schema v1 already applied
    const migrations: Migration[] = [
      {
        version: 1,
        sql: 'CREATE TABLE should_never_exist (id INTEGER) STRICT;\nTHIS IS NOT VALID SQL;',
      },
      { version: 2, sql: 'CREATE TABLE v2_marker (id INTEGER) STRICT;' },
    ];

    applyMigrations(db, migrations);

    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(listTables(db)).toContain('v2_marker');
    expect(listTables(db)).not.toContain('should_never_exist');
    db.close();
  });

  it('rejects migration lists whose versions are not strictly increasing', () => {
    const db = openDatabase(':memory:');

    expect(() =>
      applyMigrations(db, [
        { version: 2, sql: '' },
        { version: 1, sql: '' },
      ]),
    ).toThrow(/strictly increasing/);
    expect(() =>
      applyMigrations(db, [
        { version: 1, sql: '' },
        { version: 1, sql: '' },
      ]),
    ).toThrow(/strictly increasing/);
    db.close();
  });
});
