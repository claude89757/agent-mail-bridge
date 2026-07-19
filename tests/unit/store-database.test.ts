import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, openDatabase } from '../../src/store/database.js';
import { MIGRATIONS, type Migration } from '../../src/store/migrations.js';

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
  it('bumps user_version to the latest known migration (4, D-P4B7-2) on a fresh in-memory database', () => {
    const db = openDatabase(':memory:');

    const userVersion = db.pragma('user_version', { simple: true });

    expect(userVersion).toBe(4);
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

    it('re-opening is idempotent (user_version stays 4) and journaling is really WAL', () => {
      const first = openDatabase(dbPath);
      first.close();

      const second = openDatabase(dbPath);

      expect(second.pragma('user_version', { simple: true })).toBe(4);
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
    // Pinned to v1-only (D-P3P-4 added a real migration 2, so the default
    // ladder no longer stops at 1) — this test's own synthetic 2-entry list
    // below is independent of the real MIGRATIONS and still needs to start
    // from a genuinely v1 database for "version 1 is already applied,
    // therefore skipped" to hold.
    const db = openDatabase(
      ':memory:',
      MIGRATIONS.filter((migration) => migration.version === 1),
    ); // schema v1 already applied
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

  // Task 1 review nit: a version-0 migration would pass "strictly
  // increasing" trivially (0 is greater than the initial -Infinity
  // sentinel) but would then silently never apply — the in-transaction
  // guard in applyMigrations skips whenever `user_version >= migration.
  // version`, and PRAGMA user_version starts at 0 on a fresh database, so
  // `0 >= 0` would skip it forever. Reject it up front instead.
  it('rejects a migration version below 1 (would never apply since user_version starts at 0)', () => {
    const db = openDatabase(':memory:');

    expect(() => applyMigrations(db, [{ version: 0, sql: '' }])).toThrow(
      /version must be >= 1/,
    );
    db.close();
  });
});

// Guards decision D-P3P-4 (intent lifecycle, Phase 3 prework plan batch 1):
// migration 002 adds two nullable columns to dispatch_intents and backfills
// updated_at for rows that existed before the column did.
describe('migration 002 (D-P3P-4 dispatch_intents status_reason/updated_at)', () => {
  it('a fresh database goes straight to user_version 2 with both new columns present', () => {
    // Pinned to migrations 001+002 only (D-P4B4-3 added a real migration 3,
    // so the default/full ladder no longer stops at 2) — this test's intent
    // is specifically "migration 002's own effect", not "wherever the ladder
    // currently ends", so it must not silently start asserting a bigger
    // number every time a later migration lands. Same fix already applied
    // once before to the "skips already-applied versions" test below when
    // migration 002 itself was added.
    const db = openDatabase(
      ':memory:',
      MIGRATIONS.filter((migration) => migration.version <= 2),
    );

    expect(db.pragma('user_version', { simple: true })).toBe(2);
    const columns = db
      .prepare<[], { name: string }>('PRAGMA table_info(dispatch_intents)')
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(['status_reason', 'updated_at']));
    db.close();
  });

  it('a v1 database migrates to v2, backfilling updated_at = created_at and leaving status_reason NULL', () => {
    // Build the v1 fixture by running ONLY migration 001 through the real
    // applyMigrations runner — openDatabase already accepts a custom
    // migrations list (exercised by other tests in this file for different
    // reasons), so this needs no new seam and no second, hand-rolled schema
    // string that could drift from SCHEMA_V1: the smallest honest way to pin
    // "a database that predates migration 002".
    const v1Migration = MIGRATIONS.find((migration) => migration.version === 1);
    if (!v1Migration) {
      throw new Error('test setup: migration version 1 not found in MIGRATIONS');
    }
    const db = openDatabase(':memory:', [v1Migration]);
    expect(db.pragma('user_version', { simple: true })).toBe(1);

    // v1 dispatch_intents has no status_reason/updated_at columns yet, and
    // command_id is NOT NULL REFERENCES commands(id) with foreign_keys=ON
    // (set by openDatabase), so a parent commands row is required first.
    const createdAt = '2026-07-17T00:00:00.000Z';
    db.prepare<{ messageId: string; now: string }>(
      `INSERT INTO commands (message_id, status, internal_date, received_at, updated_at)
       VALUES (@messageId, 'READY_FOR_DISPATCH', @now, @now, @now)`,
    ).run({ messageId: 'msg-1@example.com', now: createdAt });
    const commandRow = db
      .prepare<[string], { id: number }>(`SELECT id FROM commands WHERE message_id = ?`)
      .get('msg-1@example.com');
    if (!commandRow) {
      throw new Error('test setup: command row not found after insert');
    }
    db.prepare<{ commandId: number; now: string }>(
      `INSERT INTO dispatch_intents (id, command_id, status, dry_run, created_at)
       VALUES ('di-1', @commandId, 'PENDING', 0, @now)`,
    ).run({ commandId: commandRow.id, now: createdAt });

    // Pinned to migrations 001+002 only for the same reason as the fixture
    // above (D-P4B4-3's migration 3 exists now): this call's job is "apply
    // exactly migration 002 on top of the v1 fixture," not "run the whole
    // current ladder," so it must stay independent of how many more
    // migrations land after 002.
    applyMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 2),
    );

    expect(db.pragma('user_version', { simple: true })).toBe(2);
    const row = db
      .prepare<[], { status_reason: string | null; updated_at: string }>(
        `SELECT status_reason, updated_at FROM dispatch_intents WHERE id = 'di-1'`,
      )
      .get();
    expect(row?.status_reason).toBeNull();
    expect(row?.updated_at).toBe(createdAt);
    db.close();
  });
});

// Guards decision D-P4B4-3 (clarification binding persistence, Phase 4
// batch 4 plan docs/superpowers/plans/2026-07-19-phase-4-batch4-clarification-binding.md):
// migration 003 adds the clarification_requests table backing
// src/store/clarificationStore.ts — the persistence half of threat-model
// control C8. The table is entirely new (no prior column to add/backfill),
// unlike migration 002 — so this migration is CREATE-only.
describe('migration 003 (D-P4B4-3 clarification_requests)', () => {
  const CLARIFICATION_COLUMNS = [
    'id',
    'command_id',
    'token',
    'thread_key',
    'candidate_set_json',
    'candidate_set_version',
    'expires_at',
    'status',
    'status_reason',
    'created_at',
    'updated_at',
  ];

  it('a fresh database goes straight to user_version 3 with clarification_requests present (STRICT) and its index', () => {
    // Pinned to migrations 001..003 only (D-P4B7-2 added a real migration 4,
    // so the default/full ladder no longer stops at 3) — this test's intent
    // is specifically "migration 003's own effect", not "wherever the ladder
    // currently ends". Same fix already applied to the migration 002 block
    // above when migration 003 itself landed.
    const db = openDatabase(
      ':memory:',
      MIGRATIONS.filter((migration) => migration.version <= 3),
    );

    expect(db.pragma('user_version', { simple: true })).toBe(3);

    const columns = db
      .prepare<[], { name: string }>('PRAGMA table_info(clarification_requests)')
      .all()
      .map((row) => row.name);
    expect(columns.sort()).toEqual([...CLARIFICATION_COLUMNS].sort());

    // STRICT mode: pragma_table_list's `strict` column — same table-valued
    // pragma style already used above/in the migration 002 block for
    // table_info, applied here to confirm the `) STRICT;` table qualifier
    // actually took effect rather than just being present in the SQL text.
    const tableList = db
      .prepare<[], { strict: number }>('PRAGMA table_list(clarification_requests)')
      .all();
    expect(tableList).toEqual([expect.objectContaining({ strict: 1 })]);

    expect(listTables(db)).toContain('clarification_requests');
    const indexNames = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'clarification_requests'",
      )
      .all()
      .map((row) => row.name);
    expect(indexNames).toContain('idx_clarification_command');
    db.close();
  });

  it('a v2 database (migrations 001+002 only) migrates to v3, adding clarification_requests', () => {
    const v2Migrations = MIGRATIONS.filter((migration) => migration.version <= 2);
    const db = openDatabase(':memory:', v2Migrations);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(listTables(db)).not.toContain('clarification_requests');

    // Pinned to migrations 001..003 for the same reason as the fresh-database
    // test above (D-P4B7-2's migration 4 exists now): this call's job is
    // "apply exactly migration 003 on top of the v2 fixture," not "run the
    // whole current ladder."
    applyMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 3),
    );

    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const columns = db
      .prepare<[], { name: string }>('PRAGMA table_info(clarification_requests)')
      .all()
      .map((row) => row.name);
    expect(columns.sort()).toEqual([...CLARIFICATION_COLUMNS].sort());
    db.close();
  });
});

// Guards decision D-P4B7-2 (thread↔session mapping persistence, Phase 4
// batch 7 plan docs/superpowers/plans/2026-07-19-phase-4-batch7-router-core.md):
// migration 004 adds the agent_sessions table backing
// src/store/sessionStore.ts. The table is entirely new — CREATE-only, like
// 003 and unlike 002. Deliberately NO foreign key to commands: one session
// spans MANY commands over its thread's lifetime (every reply on the thread
// is its own commands row), so there is no single owning command to
// reference — unlike clarification_requests, which binds to exactly one.
describe('migration 004 (D-P4B7-2 agent_sessions)', () => {
  const SESSION_COLUMNS = [
    'id',
    'thread_key',
    'project_path',
    'driver_session_id',
    'created_at',
    'updated_at',
  ];

  it('a fresh database goes straight to user_version 4 with agent_sessions present (STRICT) and its project index', () => {
    const db = openDatabase(':memory:');

    expect(db.pragma('user_version', { simple: true })).toBe(4);

    const columns = db
      .prepare<[], { name: string }>('PRAGMA table_info(agent_sessions)')
      .all()
      .map((row) => row.name);
    expect(columns.sort()).toEqual([...SESSION_COLUMNS].sort());

    // STRICT mode really took effect (same pragma_table_list technique as
    // the migration 003 block above).
    const tableList = db
      .prepare<[], { strict: number }>('PRAGMA table_list(agent_sessions)')
      .all();
    expect(tableList).toEqual([expect.objectContaining({ strict: 1 })]);

    expect(listTables(db)).toContain('agent_sessions');
    const indexNames = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_sessions'",
      )
      .all()
      .map((row) => row.name);
    expect(indexNames).toContain('idx_agent_sessions_project');
    db.close();
  });

  it('a v3 database (migrations 001..003 only) migrates to v4, adding agent_sessions', () => {
    const v3Migrations = MIGRATIONS.filter((migration) => migration.version <= 3);
    const db = openDatabase(':memory:', v3Migrations);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(listTables(db)).not.toContain('agent_sessions');

    applyMigrations(db, MIGRATIONS);

    expect(db.pragma('user_version', { simple: true })).toBe(4);
    const columns = db
      .prepare<[], { name: string }>('PRAGMA table_info(agent_sessions)')
      .all()
      .map((row) => row.name);
    expect(columns.sort()).toEqual([...SESSION_COLUMNS].sort());
    db.close();
  });
});
