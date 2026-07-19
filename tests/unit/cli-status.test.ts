import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPause, runResume, runStatus } from '../../src/cli/statusCmd.js';
import type { StatusIo } from '../../src/cli/statusCmd.js';
import { resolveConfigPath } from '../../src/cli/paths.js';
import { openDatabase } from '../../src/store/database.js';
import { ClarificationStore } from '../../src/store/clarificationStore.js';
import { CommandStore } from '../../src/store/commandStore.js';
import { IntentStore } from '../../src/store/intentStore.js';
import { MetaStore } from '../../src/store/metaStore.js';
import { OutboxStore } from '../../src/store/outboxStore.js';

// Guards D-P5B12-5's status/pause/resume half: `amb status` reports the
// DATABASE's view honestly (it never probes whether a daemon process is
// alive — there is no IPC), never echoes selfAddress (red line 2's display
// surface), and pause/resume write the D-P5B12-2 meta flag with an explicit
// effect-delay note. Real mkdtemp tree + real SQLite files, mirroring
// tests/unit/cli-setup.test.ts's stance; the config file is written
// directly as JSON (placeholder values only — public repo).

const SELF = 'bridge-user@example.com';
const NOW = new Date('2026-07-19T08:00:00.000Z');

let dir: string;
let home: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amb-cli-status-test-'));
  home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  dbPath = join(dir, 'data', 'bridge.db');
  mkdirSync(join(dir, 'data'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(overrides: Record<string, unknown> = {}): void {
  const configPath = resolveConfigPath({}, home);
  mkdirSync(join(home, '.config', 'agent-mail-bridge'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      selfAddress: SELF,
      credentialsEnvFile: join(dir, 'secrets', 'amb-test.env'),
      dbPath,
      worktreesRoot: join(dir, 'worktrees'),
      pollIntervalSeconds: 45,
      ...overrides,
    }),
    'utf8',
  );
}

function makeIo(): StatusIo {
  return {
    env: {},
    homedir: home,
    // Thin real-fs read matching LoadConfigIo's contract.
    readFileSync: (path) => readFileSync(path, 'utf8'),
    openDatabase,
  };
}

/** Opens the real db file, seeds via the production stores, closes. */
function seed(fn: (db: ReturnType<typeof openDatabase>) => void): void {
  const db = openDatabase(dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe('runStatus (D-P5B12-5)', () => {
  it('reports the DB view — readyAt, paused, per-table counts, UNCERTAIN outbox, PENDING clarifications, watermarks — with the honesty note and WITHOUT selfAddress', () => {
    writeConfig();
    seed((db) => {
      const metaStore = new MetaStore(db);
      metaStore.setReadyAtIfUnset('2026-07-17T00:00:00.000Z');
      metaStore.advanceWatermark('INBOX', '1690000000', 42);

      const commandStore = new CommandStore(db);
      const ready = commandStore.insertIfAbsent({
        messageId: 's-1@example.com',
        status: 'READY_FOR_DISPATCH',
        statusReason: null,
        internalDate: '2026-07-18T00:00:00.000Z',
        uid: 1,
        uidValidity: '1690000000',
        now: '2026-07-18T00:00:01.000Z',
      });
      commandStore.insertIfAbsent({
        messageId: 's-2@example.com',
        status: 'REJECTED',
        statusReason: 'IDENTITY_FROM',
        internalDate: '2026-07-18T00:00:00.000Z',
        uid: 2,
        uidValidity: '1690000000',
        now: '2026-07-18T00:00:01.000Z',
      });

      new IntentStore(db).createForCommand('di-status-1', ready.record.id, false, '2026-07-18T00:00:02.000Z');

      const outboxStore = new OutboxStore(db);
      outboxStore.create({
        id: 'ob-unc',
        messageId: 'unc-1@example.com',
        commandId: ready.record.id,
        kind: 'RESULT',
        now: '2026-07-18T00:00:03.000Z',
      });
      outboxStore.transition('ob-unc', 'SENDING', '2026-07-18T00:00:04.000Z');
      outboxStore.transition('ob-unc', 'UNCERTAIN', '2026-07-18T00:00:05.000Z');

      new ClarificationStore(db).create({
        commandId: ready.record.id,
        token: 'Aa-Aa-Tok-0001',
        threadKey: 'thread-status',
        candidateSetJson: '[]',
        candidateSetVersion: 1,
        expiresAt: '2026-07-20T00:00:00.000Z',
        now: '2026-07-18T00:00:06.000Z',
      });
    });

    const result = runStatus(makeIo());

    expect(result.exitCode).toBe(0);
    const text = result.messages.join('\n');
    expect(text).toContain('readyAt: 2026-07-17T00:00:00.000Z');
    expect(text).toContain('paused: no');
    expect(text).toContain('READY_FOR_DISPATCH=1');
    expect(text).toContain('REJECTED=1');
    expect(text).toContain('PENDING=1'); // the seeded intent
    expect(text).toContain('outbox UNCERTAIN');
    expect(text).toMatch(/outbox UNCERTAIN[^:]*: 1/);
    expect(text).toMatch(/clarifications PENDING: 1/);
    expect(text).toContain('watermark: INBOX uidValidity=1690000000 lastUid=42');
    // Honest positioning: DB view only, no process probing.
    expect(text.toLowerCase()).toContain('does not');
    expect(text.toLowerCase()).toContain('daemon process');
    // RED LINE 2 display surface: selfAddress is never echoed.
    expect(text).not.toContain(SELF);
  });

  it('reports an unset readyAt and empty watermarks honestly on a fresh database', () => {
    writeConfig();
    seed(() => {
      /* open once so the file and schema exist, seed nothing */
    });

    const result = runStatus(makeIo());

    expect(result.exitCode).toBe(0);
    const text = result.messages.join('\n');
    expect(text).toContain('readyAt: not set');
    expect(text).toContain('watermark: none recorded yet');
  });

  it('shows paused: yes after runPause flipped the flag', () => {
    writeConfig();
    seed(() => {
      /* schema only */
    });
    expect(runPause(makeIo(), NOW).exitCode).toBe(0);

    const result = runStatus(makeIo());

    expect(result.messages.join('\n')).toContain('paused: yes');
  });

  it('fails closed with exit 1 (config errors listed) when the config cannot load', () => {
    // No config file written at all.
    const result = runStatus(makeIo());

    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('config');
  });
});

describe('runPause / runResume (D-P5B12-5, D-P5B12-2)', () => {
  it('runPause writes the flag (round-trips through a fresh MetaStore) and explains the poll-interval effect delay using the config value', () => {
    writeConfig();
    seed(() => {
      /* schema only */
    });

    const result = runPause(makeIo(), NOW);

    expect(result.exitCode).toBe(0);
    const text = result.messages.join('\n');
    expect(text).toContain('paused');
    expect(text).toContain('45'); // pollIntervalSeconds from config
    expect(text.toLowerCase()).toContain('poll');

    const db = openDatabase(dbPath);
    try {
      expect(new MetaStore(db).getPaused()).toBe(true);
    } finally {
      db.close();
    }
  });

  it('runResume clears the flag and carries the same effect-delay note', () => {
    writeConfig();
    seed((db) => {
      new MetaStore(db).setPaused(true, '2026-07-19T00:00:00.000Z');
    });

    const result = runResume(makeIo(), NOW);

    expect(result.exitCode).toBe(0);
    expect(result.messages.join('\n').toLowerCase()).toContain('resume');
    expect(result.messages.join('\n')).toContain('45');

    const db = openDatabase(dbPath);
    try {
      expect(new MetaStore(db).getPaused()).toBe(false);
    } finally {
      db.close();
    }
  });

  it('runPause fails closed with exit 1 when the config cannot load, touching nothing', () => {
    const result = runPause(makeIo(), NOW);

    expect(result.exitCode).toBe(1);
  });
});
