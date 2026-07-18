import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIngest } from '../../src/application/ingest.js';
import type { IngestConfig } from '../../src/application/ingest.js';
import { deriveIntentId, normalizeMessageId } from '../../src/domain/mail.js';
import { openDatabase } from '../../src/store/database.js';
import { CommandStore } from '../../src/store/commandStore.js';
import { IntentStore } from '../../src/store/intentStore.js';
import { MetaStore } from '../../src/store/metaStore.js';
import { OutboxStore } from '../../src/store/outboxStore.js';
import type { IncomingMail } from '../../src/transports/types.js';

// Guards the Phase 2 plan's Task 10 exit criterion
// (docs/superpowers/plans/2026-07-17-phase-2-event-core.md): ingestMail
// (D-P2-8) folds every persisted side effect (watermark advance, command
// insert, status updates, intent insert) into ONE better-sqlite3
// transaction, so a crash at any point in the chain recovers cleanly. Three
// scenarios, one per describe block below:
//   (a) mid-transaction — the transaction callback throws partway through;
//       better-sqlite3 must roll back EVERYTHING already written, not just
//       skip the failed step.
//   (b) after commit, before the transport ack — the mail is re-delivered
//       (exactly what a daemon restart's next poll cycle does after losing
//       an in-flight ack) and must collapse to `duplicate`.
//   (c) process restart — a FILE-backed db (not `:memory:`) is closed and
//       reopened, simulating a real process exit, and every persisted value
//       is read back through completely fresh store instances.
//
// Placeholder addresses only (public-repo rule) — mirrors the SELF/attacker
// convention used across tests/unit/ingest.test.ts and
// tests/integration/ingest-pipeline.test.ts.
const SELF = 'bridge-user@example.com';
const READY_AT = '2026-07-17T00:00:00.000Z';
const NOW = new Date('2026-07-17T00:00:05.000Z');
const NOW_LATER = new Date('2026-07-17T00:00:06.000Z');

type Db = ReturnType<typeof openDatabase>;

interface Deps {
  db: Db;
  commandStore: CommandStore;
  intentStore: IntentStore;
  outboxStore: OutboxStore;
  metaStore: MetaStore;
  config: IngestConfig;
}

let openDbs: Db[];

beforeEach(() => {
  openDbs = [];
});

afterEach(() => {
  // Double-closing an already-closed better-sqlite3 handle is a no-op, so
  // this blanket cleanup is safe even for tests below that also close their
  // db(s) explicitly mid-test.
  for (const db of openDbs) {
    db.close();
  }
});

/** Fresh store set on `path` (`:memory:` unless a file path is given),
 *  readyAt preset — mirrors tests/unit/ingest.test.ts's setup(). */
function setup(path = ':memory:'): Deps {
  const db = openDatabase(path);
  openDbs.push(db);

  const commandStore = new CommandStore(db);
  const intentStore = new IntentStore(db);
  const outboxStore = new OutboxStore(db);
  const metaStore = new MetaStore(db);
  metaStore.setReadyAtIfUnset(READY_AT);

  return {
    db,
    commandStore,
    intentStore,
    outboxStore,
    metaStore,
    config: { selfAddress: SELF, dryRun: false },
  };
}

/** Valid self-to-self mail, internalDate safely after READY_AT. Individual
 *  tests override only the field(s) under test (mirrors
 *  tests/unit/ingest.test.ts's mail()). */
function mail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: '<crash-1@example.com>',
    headers: new Map(),
    from: [SELF],
    to: [SELF],
    cc: [],
    internalDate: '2026-07-17T00:00:01.000Z',
    uid: 1,
    uidValidity: '1690000000',
    mailbox: 'INBOX',
    ...overrides,
  };
}

function countRows(db: Db, table: 'commands' | 'dispatch_intents'): number {
  const row = db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

describe('crash recovery at ingestMail transaction boundaries (Phase 2 Task 10)', () => {
  describe('(a) mid-transaction crash', () => {
    it(
      'intentIdFactory throwing on its first call rolls back the WHOLE transaction ' +
        '(better-sqlite3 ROLLBACK on any callback exception, not a partial write): ' +
        '0 commands, 0 intents, watermark stays at its pre-call value of 0 even though ' +
        'the watermark advance and command insert both already ran before the throw; ' +
        'retrying the same mail with the default factory then succeeds cleanly',
      () => {
        const deps = setup();
        const mail1 = mail();

        const crashingFactory = (): string => {
          throw new Error('simulated crash mid-transaction (Task 10a)');
        };
        const crashingIngest = createIngest({ ...deps, intentIdFactory: crashingFactory });

        expect(() => crashingIngest(mail1, NOW)).toThrow(
          'simulated crash mid-transaction (Task 10a)',
        );

        // better-sqlite3's Database#transaction wraps the callback in
        // BEGIN/COMMIT; an exception anywhere inside — including one thrown
        // by a dependency injected via intentIdFactory, well after the
        // watermark advance and the command insert already executed —
        // triggers ROLLBACK and discards every write the callback made.
        expect(countRows(deps.db, 'commands')).toBe(0);
        expect(countRows(deps.db, 'dispatch_intents')).toBe(0);
        expect(deps.metaStore.getWatermark(mail1.mailbox, mail1.uidValidity)).toBe(0);

        // Retry: a fresh ingest function using the DEFAULT factory (omitted
        // ⇒ deriveIntentId, unchanged from before Task 10) against the SAME
        // stores/db — proving the rollback truly left nothing behind for
        // the retry to collide with.
        const normalIngest = createIngest(deps);
        const result = normalIngest(mail1, NOW);

        const expectedIntentId = deriveIntentId(normalizeMessageId(mail1.messageId)!);
        expect(result.outcome).toBe('ready');
        expect(result.intentId).toBe(expectedIntentId);
        expect(countRows(deps.db, 'commands')).toBe(1);
        expect(countRows(deps.db, 'dispatch_intents')).toBe(1);
        expect(deps.metaStore.getWatermark(mail1.mailbox, mail1.uidValidity)).toBe(1);
      },
    );
  });

  describe('(b) crash AFTER commit, BEFORE transport ack', () => {
    it("re-ingesting the same mail (as a daemon restart's next poll would) is duplicate, still exactly 1 intent", () => {
      const deps = setup();
      const ingest = createIngest(deps);
      const mail1 = mail();

      const first = ingest(mail1, NOW);
      expect(first.outcome).toBe('ready');
      expect(countRows(deps.db, 'dispatch_intents')).toBe(1);

      // Simulates losing the in-flight transport ack: the transaction that
      // created the command+intent already committed, but the daemon
      // crashed/restarted before recording that the mail was handled, so
      // the next poll cycle redelivers and re-ingests the SAME mail.
      const second = ingest(mail1, NOW_LATER);

      expect(second.outcome).toBe('duplicate');
      expect(second.commandId).toBe(first.commandId);
      expect(second.intentId).toBe(first.intentId);
      expect(second.reason).toBeNull();
      expect(countRows(deps.db, 'commands')).toBe(1);
      expect(countRows(deps.db, 'dispatch_intents')).toBe(1);
    });
  });

  describe('(c) process-restart with a file-backed db', () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'amb-crash-recovery-test-'));
      dbPath = join(dir, 'amb.sqlite3');
    });

    afterEach(() => {
      // Removes the db file AND its -wal/-shm sidecars (same directory) in
      // one shot. Both handles opened below are explicitly closed in the
      // test body before this runs.
      rmSync(dir, { recursive: true, force: true });
    });

    it('command row, intent row, and watermark persist across a close + reopen on the same file; re-ingest on the reopened db is duplicate', () => {
      const mail1 = mail();
      const expectedIntentId = deriveIntentId(normalizeMessageId(mail1.messageId)!);

      // "process 1": open on the temp file, ingest successfully, close —
      // simulates a daemon run that commits the transaction and then exits.
      const deps1 = setup(dbPath);
      const ingest1 = createIngest(deps1);
      const firstResult = ingest1(mail1, NOW);
      expect(firstResult.outcome).toBe('ready');
      deps1.db.close();

      // "process 2": reopen the SAME file with entirely fresh store
      // instances — nothing is carried over in memory from process 1.
      const db2 = openDatabase(dbPath);
      openDbs.push(db2);
      const commandStore2 = new CommandStore(db2);
      const intentStore2 = new IntentStore(db2);
      const outboxStore2 = new OutboxStore(db2);
      const metaStore2 = new MetaStore(db2);

      const persistedCommand = commandStore2.getByMessageId(normalizeMessageId(mail1.messageId)!);
      expect(persistedCommand?.id).toBe(firstResult.commandId);
      expect(persistedCommand?.status).toBe('READY_FOR_DISPATCH');
      expect(persistedCommand?.uid).toBe(mail1.uid);

      const persistedIntent = intentStore2.getByCommandId(firstResult.commandId!);
      expect(persistedIntent).toEqual({
        id: expectedIntentId,
        status: 'PENDING',
        dryRun: false,
        statusReason: null,
        updatedAt: '2026-07-17T00:00:05.000Z',
      });

      expect(metaStore2.getWatermark(mail1.mailbox, mail1.uidValidity)).toBe(mail1.uid);
      expect(metaStore2.getReadyAt()).toBe(READY_AT);

      const ingest2 = createIngest({
        db: db2,
        commandStore: commandStore2,
        intentStore: intentStore2,
        outboxStore: outboxStore2,
        metaStore: metaStore2,
        config: { selfAddress: SELF, dryRun: false },
      });

      const secondResult = ingest2(mail1, NOW_LATER);

      expect(secondResult.outcome).toBe('duplicate');
      expect(secondResult.commandId).toBe(firstResult.commandId);
      expect(secondResult.intentId).toBe(expectedIntentId);

      db2.close();
    });
  });

  describe('(bonus) intent-id collision guard (Part 2 review follow-up #3)', () => {
    it('a second, different mail whose intentIdFactory derives the SAME intent id as an already-ready mail fails closed inside the transaction, rolling back only its own writes', () => {
      const deps = setup();
      const constantFactory = (): string => 'di-constant-collision';
      const ingest = createIngest({ ...deps, intentIdFactory: constantFactory });

      const first = ingest(mail({ messageId: '<collide-1@example.com>' }), NOW);
      expect(first.outcome).toBe('ready');
      expect(first.intentId).toBe('di-constant-collision');

      expect(() => ingest(mail({ messageId: '<collide-2@example.com>' }), NOW_LATER)).toThrow(
        /collision/,
      );

      // The guard throws INSIDE the transaction, so the second mail's own
      // command insert (and watermark advance) is rolled back along with
      // it — only the first mail's command/intent exist afterward.
      expect(countRows(deps.db, 'commands')).toBe(1);
      expect(countRows(deps.db, 'dispatch_intents')).toBe(1);
      expect(deps.commandStore.getByMessageId('collide-2@example.com')).toBeNull();
    });
  });
});
