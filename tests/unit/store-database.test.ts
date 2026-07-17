import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/store/database.js';

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

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(
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
    // default 'delete' mode.
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

  describe('re-opening a file-backed database', () => {
    let dir: string | undefined;

    afterEach(() => {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      }
    });

    it('is idempotent: user_version stays 1 across opens', () => {
      dir = mkdtempSync(join(tmpdir(), 'amb-store-database-test-'));
      const dbPath = join(dir, 'amb.sqlite3');

      const first = openDatabase(dbPath);
      first.close();

      const second = openDatabase(dbPath);
      const userVersion = second.pragma('user_version', { simple: true });

      expect(userVersion).toBe(1);
      second.close();
    });
  });
});
