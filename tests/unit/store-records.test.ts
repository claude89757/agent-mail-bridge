import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IllegalTransitionError } from '../../src/domain/errors.js';
import { openDatabase } from '../../src/store/database.js';
import { ClarificationStore } from '../../src/store/clarificationStore.js';
import type { ClarificationCreateInput } from '../../src/store/clarificationStore.js';
import { CommandStore } from '../../src/store/commandStore.js';
import type { CommandRecordInput } from '../../src/store/commandStore.js';
import { IntentStore } from '../../src/store/intentStore.js';
import { MetaStore } from '../../src/store/metaStore.js';
import { OutboxStore } from '../../src/store/outboxStore.js';

// Guards decision D-P2-10 (store API shapes) over the D-P2-9 schema: each
// store is a thin synchronous wrapper, and `commandStore`/`outboxStore`
// re-enforce the D-P2-2/D-P2-3 transition guards from src/domain/ just
// before persisting a status change. Every test opens its own fresh
// in-memory database (`openDatabase(':memory:')`) so tests never share
// state.

type Db = ReturnType<typeof openDatabase>;

function commandInput(overrides: Partial<CommandRecordInput> = {}): CommandRecordInput {
  return {
    messageId: 'msg-1@example.com',
    status: 'RECEIVED',
    statusReason: null,
    internalDate: '2026-07-17T00:00:00.000Z',
    uid: 1,
    uidValidity: '1690000000',
    now: '2026-07-17T00:00:01.000Z',
    ...overrides,
  };
}

describe('CommandStore (D-P2-10)', () => {
  let db: Db;
  let store: CommandStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new CommandStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('insertIfAbsent inserts a fresh row and returns inserted: true', () => {
    const { inserted, record } = store.insertIfAbsent(commandInput());

    expect(inserted).toBe(true);
    expect(record.messageId).toBe('msg-1@example.com');
    expect(record.status).toBe('RECEIVED');
    expect(record.receivedAt).toBe('2026-07-17T00:00:01.000Z');
    expect(record.updatedAt).toBe('2026-07-17T00:00:01.000Z');
  });

  it('insertIfAbsent twice with the same messageId returns inserted: false and the same record id', () => {
    const first = store.insertIfAbsent(commandInput());

    const second = store.insertIfAbsent(
      commandInput({ status: 'REJECTED', statusReason: 'NO_MESSAGE_ID' }),
    );

    expect(second.inserted).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    // Conflict path must return the EXISTING row, not the second call's
    // (ignored) attempted values.
    expect(second.record.status).toBe('RECEIVED');
    expect(second.record.statusReason).toBeNull();
  });

  it('getByMessageId returns null for an unknown messageId', () => {
    expect(store.getByMessageId('unknown@example.com')).toBeNull();
  });

  it('getByMessageId round-trips a stored record', () => {
    const { record } = store.insertIfAbsent(commandInput());

    expect(store.getByMessageId('msg-1@example.com')).toEqual(record);
  });

  it('updateStatus persists a legal D-P2-2 transition', () => {
    const { record } = store.insertIfAbsent(commandInput());

    const updated = store.updateStatus(
      record.id,
      'READY_FOR_DISPATCH',
      null,
      '2026-07-17T00:00:02.000Z',
    );

    expect(updated.status).toBe('READY_FOR_DISPATCH');
    expect(updated.updatedAt).toBe('2026-07-17T00:00:02.000Z');
    expect(updated.now).toBe(updated.updatedAt);
    expect(store.getByMessageId('msg-1@example.com')?.status).toBe('READY_FOR_DISPATCH');
  });

  it('updateStatus throws IllegalTransitionError on an illegal transition and does NOT persist', () => {
    const { record } = store.insertIfAbsent(commandInput({ status: 'SYSTEM_ECHO' }));

    expect(() =>
      store.updateStatus(record.id, 'READY_FOR_DISPATCH', null, '2026-07-17T00:00:02.000Z'),
    ).toThrow(IllegalTransitionError);

    const untouched = store.getByMessageId('msg-1@example.com');
    expect(untouched?.status).toBe('SYSTEM_ECHO');
    expect(untouched?.updatedAt).toBe(record.updatedAt);
  });
});

describe('IntentStore (D-P2-10 / D-P3P-4)', () => {
  let db: Db;
  let commandStore: CommandStore;
  let store: IntentStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    commandStore = new CommandStore(db);
    store = new IntentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertCommand(messageId: string): number {
    return commandStore.insertIfAbsent(commandInput({ messageId })).record.id;
  }

  it('createForCommand creates a fresh intent (status PENDING) and countAll reflects it', () => {
    const commandId = insertCommand('msg-1@example.com');

    const result = store.createForCommand('di-1', commandId, false, '2026-07-17T00:00:01.000Z');

    expect(result).toEqual({ created: true });
    expect(store.countAll()).toBe(1);
    expect(store.getByCommandId(commandId)).toEqual({
      id: 'di-1',
      status: 'PENDING',
      dryRun: false,
      statusReason: null,
      updatedAt: '2026-07-17T00:00:01.000Z',
    });
  });

  it('createForCommand records the dryRun flag', () => {
    const commandId = insertCommand('msg-1@example.com');

    store.createForCommand('di-1', commandId, true, '2026-07-17T00:00:01.000Z');

    expect(store.getByCommandId(commandId)?.dryRun).toBe(true);
  });

  it('createForCommand twice with the same intent id returns created: false and countAll stays 1', () => {
    const commandId = insertCommand('msg-1@example.com');
    store.createForCommand('di-1', commandId, false, '2026-07-17T00:00:01.000Z');

    const second = store.createForCommand('di-1', commandId, false, '2026-07-17T00:00:01.000Z');

    expect(second).toEqual({ created: false });
    expect(store.countAll()).toBe(1);
  });

  it('a second, different intent id for the same command is impossible (UNIQUE command_id)', () => {
    const commandId = insertCommand('msg-1@example.com');
    store.createForCommand('di-1', commandId, false, '2026-07-17T00:00:01.000Z');

    const second = store.createForCommand('di-2', commandId, false, '2026-07-17T00:00:02.000Z');

    expect(second).toEqual({ created: false });
    expect(store.countAll()).toBe(1);
  });

  it('getByCommandId returns null when no intent exists for that command', () => {
    const commandId = insertCommand('msg-1@example.com');

    expect(store.getByCommandId(commandId)).toBeNull();
  });

  describe('transition (D-P3P-4)', () => {
    it('PENDING -> RUNNING persists status/statusReason/updatedAt (updatedAt is the transition now, not the creation now)', () => {
      const commandId = insertCommand('msg-1@example.com');
      store.createForCommand('di-1', commandId, false, '2026-07-17T00:00:01.000Z');

      store.transition('di-1', 'RUNNING', null, '2026-07-17T00:05:00.000Z');

      expect(store.getById('di-1')).toEqual({
        id: 'di-1',
        status: 'RUNNING',
        dryRun: false,
        statusReason: null,
        updatedAt: '2026-07-17T00:05:00.000Z',
      });
    });

    it('an illegal transition (PENDING -> COMPLETED) throws IllegalTransitionError and leaves the row unchanged', () => {
      const commandId = insertCommand('msg-1@example.com');
      store.createForCommand('di-1', commandId, false, '2026-07-17T00:00:01.000Z');

      expect(() =>
        store.transition('di-1', 'COMPLETED', 'oops', '2026-07-17T00:05:00.000Z'),
      ).toThrow(IllegalTransitionError);

      // Full-row assert: the row must be untouched, not just "status
      // unchanged" — this also kills a mutant that writes statusReason/
      // updatedAt before the assert check runs.
      expect(store.getById('di-1')).toEqual({
        id: 'di-1',
        status: 'PENDING',
        dryRun: false,
        statusReason: null,
        updatedAt: '2026-07-17T00:00:01.000Z',
      });
    });

    it('throws an explicit error for an unknown id', () => {
      expect(() =>
        store.transition('no-such-intent', 'RUNNING', null, '2026-07-17T00:05:00.000Z'),
      ).toThrow(/no intent with id no-such-intent/);
    });

    it('full chain PENDING -> RUNNING -> COMPLETED persists the end state with a null reason', () => {
      const commandId = insertCommand('msg-1@example.com');
      store.createForCommand('di-1', commandId, false, '2026-07-17T00:00:01.000Z');

      store.transition('di-1', 'RUNNING', null, '2026-07-17T00:01:00.000Z');
      store.transition('di-1', 'COMPLETED', null, '2026-07-17T00:02:00.000Z');

      expect(store.getById('di-1')).toEqual({
        id: 'di-1',
        status: 'COMPLETED',
        dryRun: false,
        statusReason: null,
        updatedAt: '2026-07-17T00:02:00.000Z',
      });
    });

    it('full chain PENDING -> RUNNING -> FAILED persists the end state with a non-null reason', () => {
      const commandId = insertCommand('msg-1@example.com');
      store.createForCommand('di-1', commandId, false, '2026-07-17T00:00:01.000Z');

      store.transition('di-1', 'RUNNING', null, '2026-07-17T00:01:00.000Z');
      store.transition('di-1', 'FAILED', 'AGENT_TASK_ERROR', '2026-07-17T00:02:00.000Z');

      expect(store.getById('di-1')).toEqual({
        id: 'di-1',
        status: 'FAILED',
        dryRun: false,
        statusReason: 'AGENT_TASK_ERROR',
        updatedAt: '2026-07-17T00:02:00.000Z',
      });
    });

    it('PENDING -> SKIPPED_DRY_RUN persists the end state directly (no RUNNING step)', () => {
      const commandId = insertCommand('msg-1@example.com');
      store.createForCommand('di-1', commandId, true, '2026-07-17T00:00:01.000Z');

      store.transition('di-1', 'SKIPPED_DRY_RUN', null, '2026-07-17T00:01:00.000Z');

      expect(store.getById('di-1')).toEqual({
        id: 'di-1',
        status: 'SKIPPED_DRY_RUN',
        dryRun: true,
        statusReason: null,
        updatedAt: '2026-07-17T00:01:00.000Z',
      });
    });
  });

  describe('findByStatus / getById (D-P3P-4)', () => {
    it('findByStatus filters among mixed statuses', () => {
      const commandA = insertCommand('msg-a@example.com');
      const commandB = insertCommand('msg-b@example.com');
      const commandC = insertCommand('msg-c@example.com');
      store.createForCommand('di-a', commandA, false, '2026-07-17T00:00:01.000Z');
      store.createForCommand('di-b', commandB, false, '2026-07-17T00:00:01.000Z');
      store.createForCommand('di-c', commandC, false, '2026-07-17T00:00:01.000Z');
      store.transition('di-b', 'RUNNING', null, '2026-07-17T00:01:00.000Z');
      store.transition('di-c', 'RUNNING', null, '2026-07-17T00:01:00.000Z');
      store.transition('di-c', 'COMPLETED', null, '2026-07-17T00:02:00.000Z');

      expect(store.findByStatus('PENDING').map((intent) => intent.id)).toEqual(['di-a']);
      expect(store.findByStatus('RUNNING').map((intent) => intent.id)).toEqual(['di-b']);
      expect(store.findByStatus('COMPLETED').map((intent) => intent.id)).toEqual(['di-c']);
      expect(store.findByStatus('FAILED')).toEqual([]);
    });

    it('getById round-trips a stored intent and returns undefined for a missing one', () => {
      const commandId = insertCommand('msg-1@example.com');
      store.createForCommand('di-1', commandId, true, '2026-07-17T00:00:01.000Z');

      expect(store.getById('di-1')).toEqual({
        id: 'di-1',
        status: 'PENDING',
        dryRun: true,
        statusReason: null,
        updatedAt: '2026-07-17T00:00:01.000Z',
      });
      expect(store.getById('no-such-intent')).toBeUndefined();
    });
  });
});

describe('OutboxStore (D-P2-10 / D-P2-3)', () => {
  let db: Db;
  let store: OutboxStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new OutboxStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('create then isKnownOutboxId/isKnownOutboxMessageId report true for the created entry', () => {
    store.create({
      id: 'outbox-1',
      messageId: 'reply-1@example.com',
      commandId: null,
      kind: 'ACK',
      now: '2026-07-17T00:00:01.000Z',
    });

    expect(store.isKnownOutboxId('outbox-1')).toBe(true);
    expect(store.isKnownOutboxMessageId('reply-1@example.com')).toBe(true);
  });

  it('isKnownOutboxId/isKnownOutboxMessageId report false for unknown values', () => {
    expect(store.isKnownOutboxId('unknown')).toBe(false);
    expect(store.isKnownOutboxMessageId('unknown@example.com')).toBe(false);
  });

  /** Reads the persisted status straight off the row, bypassing the store. */
  function persistedStatus(id: string): string | undefined {
    return db
      .prepare<[string], { status: string }>(`SELECT status FROM outbox WHERE id = ?`)
      .get(id)?.status;
  }

  it('transition follows the legal D-P2-3 chain PENDING -> SENDING -> SENT', () => {
    store.create({
      id: 'outbox-1',
      messageId: 'reply-1@example.com',
      commandId: null,
      kind: 'ACK',
      now: '2026-07-17T00:00:01.000Z',
    });

    expect(() => store.transition('outbox-1', 'SENDING', '2026-07-17T00:00:02.000Z')).not.toThrow();
    expect(() => store.transition('outbox-1', 'SENT', '2026-07-17T00:00:03.000Z')).not.toThrow();
  });

  it('transition walks the D-P2-3 reconciliation branch PENDING -> SENDING -> UNCERTAIN -> SENT, persisting each step', () => {
    store.create({
      id: 'outbox-1',
      messageId: 'reply-1@example.com',
      commandId: null,
      kind: 'RESULT',
      now: '2026-07-17T00:00:01.000Z',
    });
    expect(persistedStatus('outbox-1')).toBe('PENDING');

    store.transition('outbox-1', 'SENDING', '2026-07-17T00:00:02.000Z');
    expect(persistedStatus('outbox-1')).toBe('SENDING');

    // Send outcome unknown — the only legal way into UNCERTAIN.
    store.transition('outbox-1', 'UNCERTAIN', '2026-07-17T00:00:03.000Z');
    expect(persistedStatus('outbox-1')).toBe('UNCERTAIN');

    // Reconciliation confirms the send — the only legal way out of UNCERTAIN.
    store.transition('outbox-1', 'SENT', '2026-07-17T00:00:04.000Z');
    expect(persistedStatus('outbox-1')).toBe('SENT');
  });

  it('transition throws IllegalTransitionError on PENDING -> UNCERTAIN (no SENDING step) and does NOT persist', () => {
    store.create({
      id: 'outbox-1',
      messageId: 'reply-1@example.com',
      commandId: null,
      kind: 'ACK',
      now: '2026-07-17T00:00:01.000Z',
    });

    expect(() => store.transition('outbox-1', 'UNCERTAIN', '2026-07-17T00:00:02.000Z')).toThrow(
      IllegalTransitionError,
    );
    // Still PENDING, so the legal next step still succeeds.
    expect(() => store.transition('outbox-1', 'SENDING', '2026-07-17T00:00:03.000Z')).not.toThrow();
  });

  it('transition throws IllegalTransitionError from the terminal SENT state', () => {
    store.create({
      id: 'outbox-1',
      messageId: 'reply-1@example.com',
      commandId: null,
      kind: 'ACK',
      now: '2026-07-17T00:00:01.000Z',
    });
    store.transition('outbox-1', 'SENDING', '2026-07-17T00:00:02.000Z');
    store.transition('outbox-1', 'SENT', '2026-07-17T00:00:03.000Z');

    expect(() => store.transition('outbox-1', 'PENDING', '2026-07-17T00:00:04.000Z')).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('MetaStore (D-P2-10)', () => {
  let db: Db;
  let store: MetaStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new MetaStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('getReadyAt is null before it is ever set', () => {
    expect(store.getReadyAt()).toBeNull();
  });

  it('setReadyAtIfUnset stores and returns the first value', () => {
    const effective = store.setReadyAtIfUnset('2026-07-17T00:00:00.000Z');

    expect(effective).toBe('2026-07-17T00:00:00.000Z');
    expect(store.getReadyAt()).toBe('2026-07-17T00:00:00.000Z');
  });

  it('setReadyAtIfUnset called a second time keeps the first value (first-install fence)', () => {
    store.setReadyAtIfUnset('2026-07-17T00:00:00.000Z');

    const second = store.setReadyAtIfUnset('2099-01-01T00:00:00.000Z');

    expect(second).toBe('2026-07-17T00:00:00.000Z');
    expect(store.getReadyAt()).toBe('2026-07-17T00:00:00.000Z');
  });

  it('getWatermark returns 0 for an unknown (mailbox, uidValidity) pair', () => {
    expect(store.getWatermark('INBOX', '1690000000')).toBe(0);
  });

  it('advanceWatermark advances the stored value', () => {
    store.advanceWatermark('INBOX', '1690000000', 100);

    expect(store.getWatermark('INBOX', '1690000000')).toBe(100);
  });

  it('advanceWatermark with a smaller uid is a no-op (watermark never retreats)', () => {
    store.advanceWatermark('INBOX', '1690000000', 100);

    store.advanceWatermark('INBOX', '1690000000', 50);

    expect(store.getWatermark('INBOX', '1690000000')).toBe(100);
  });

  it('advanceWatermark with a larger uid advances further', () => {
    store.advanceWatermark('INBOX', '1690000000', 100);

    store.advanceWatermark('INBOX', '1690000000', 150);

    expect(store.getWatermark('INBOX', '1690000000')).toBe(150);
  });

  it('watermark is scoped per uidValidity (new uidValidity starts at 0 — bounded-rescan hook)', () => {
    store.advanceWatermark('INBOX', '1690000000', 100);

    expect(store.getWatermark('INBOX', '1690000001')).toBe(0);
    expect(store.getWatermark('INBOX', '1690000000')).toBe(100);
  });
});

// Guards decision D-P4B4-3 (clarification binding persistence, Phase 4
// batch 4 plan) over the migration 003 schema: `create` re-enforces the
// D-P4B4-1 SUPERSEDED-before-insert invariant (never two PENDING rows for
// one command_id) INSIDE one transaction, and `transition` re-enforces the
// D-P4B4-1 state machine (src/domain/clarificationState.ts) just before
// persisting a status change — same read-assert-write shape as
// IntentStore.transition above.
describe('ClarificationStore (D-P4B4-3)', () => {
  let db: Db;
  let commandStore: CommandStore;
  let store: ClarificationStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    commandStore = new CommandStore(db);
    store = new ClarificationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertCommand(messageId: string): number {
    return commandStore.insertIfAbsent(commandInput({ messageId })).record.id;
  }

  function clarificationInput(
    commandId: number,
    overrides: Partial<Omit<ClarificationCreateInput, 'commandId'>> = {},
  ): ClarificationCreateInput {
    return {
      commandId,
      token: 'amb-tok-0001',
      threadKey: 'thread-0001',
      candidateSetJson: '{"candidates":[]}',
      candidateSetVersion: 1,
      expiresAt: '2026-07-19T01:00:00.000Z',
      now: '2026-07-19T00:00:00.000Z',
      ...overrides,
    };
  }

  it('create then findByThreadKey round-trips the full summary (token stored verbatim, no normalization)', () => {
    const commandId = insertCommand('msg-1@example.com');

    const created = store.create(
      clarificationInput(commandId, {
        token: 'Aa-Aa-Tok-0001',
        threadKey: 'thread-abc',
        candidateSetJson: '{"candidates":["a","b"]}',
        candidateSetVersion: 3,
        expiresAt: '2026-07-19T01:00:00.000Z',
        now: '2026-07-19T00:00:00.000Z',
      }),
    );

    expect(created).toEqual({
      id: 1,
      commandId,
      token: 'Aa-Aa-Tok-0001',
      threadKey: 'thread-abc',
      candidateSetJson: '{"candidates":["a","b"]}',
      candidateSetVersion: 3,
      expiresAt: '2026-07-19T01:00:00.000Z',
      status: 'PENDING',
      statusReason: null,
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    expect(store.findByThreadKey('thread-abc')).toEqual(created);
    expect(store.findByThreadKey('no-such-thread')).toBeUndefined();
  });

  it('the SUPERSEDED-before-insert invariant (D-P4B4-1): re-issuing for the same command supersedes the old PENDING row before the new one exists', () => {
    const commandId = insertCommand('msg-1@example.com');
    const a = store.create(
      clarificationInput(commandId, { threadKey: 'thread-a', now: '2026-07-19T00:00:00.000Z' }),
    );

    const b = store.create(
      clarificationInput(commandId, { threadKey: 'thread-b', now: '2026-07-19T00:05:00.000Z' }),
    );

    // A: superseded, reason REISSUED, updated_at is B's now (the transition
    // that superseded it), NOT A's own creation time.
    expect(store.findByThreadKey('thread-a')).toEqual({
      ...a,
      status: 'SUPERSEDED',
      statusReason: 'REISSUED',
      updatedAt: '2026-07-19T00:05:00.000Z',
    });
    // B: fresh PENDING row, untouched reason.
    expect(b.status).toBe('PENDING');
    expect(b.statusReason).toBeNull();
    expect(store.findPendingByCommandId(commandId)).toEqual([b]);
  });

  it('create is atomic: a thread_key collision during re-issue rolls back the superseding update too (A stays PENDING, nothing new persists)', () => {
    const commandId = insertCommand('msg-1@example.com');
    const a = store.create(
      clarificationInput(commandId, { threadKey: 'thread-a', now: '2026-07-19T00:00:00.000Z' }),
    );

    // Re-issuing for the SAME command with A's own thread_key: the
    // supersede-UPDATE runs first (would flip A to SUPERSEDED), then the
    // INSERT collides with A's still-occupied thread_key and throws. The
    // whole transaction — including the UPDATE that ran before the failing
    // INSERT — must roll back.
    expect(() =>
      store.create(
        clarificationInput(commandId, { threadKey: 'thread-a', now: '2026-07-19T00:05:00.000Z' }),
      ),
    ).toThrow();

    expect(store.findByThreadKey('thread-a')).toEqual(a);
    expect(store.findPendingByCommandId(commandId)).toEqual([a]);
  });

  it('thread_key UNIQUE: colliding with a DIFFERENT command’s thread_key throws and rolls back that command’s own superseding', () => {
    const commandA = insertCommand('msg-a@example.com');
    const commandB = insertCommand('msg-b@example.com');
    const a = store.create(
      clarificationInput(commandA, { threadKey: 'thread-a', now: '2026-07-19T00:00:00.000Z' }),
    );
    const c = store.create(
      clarificationInput(commandB, { threadKey: 'thread-c', now: '2026-07-19T00:01:00.000Z' }),
    );

    // commandB re-issues but supplies commandA's thread_key by mistake: the
    // supersede-UPDATE for commandB's own PENDING row (C) runs first, then
    // the INSERT collides with A's thread_key (a DIFFERENT command) and
    // throws — commandB's own superseding must roll back too.
    expect(() =>
      store.create(
        clarificationInput(commandB, { threadKey: 'thread-a', now: '2026-07-19T00:05:00.000Z' }),
      ),
    ).toThrow();

    expect(store.findByThreadKey('thread-c')).toEqual(c);
    expect(store.findPendingByCommandId(commandB)).toEqual([c]);
    expect(store.findByThreadKey('thread-a')).toEqual(a);
  });

  it('create with a nonexistent command_id throws (foreign key enforced — foreign_keys pragma is ON per database.ts)', () => {
    expect(() => store.create(clarificationInput(999999))).toThrow();
  });

  describe('transition (D-P4B4-1)', () => {
    it('PENDING -> CONSUMED persists status/statusReason/updatedAt (updatedAt is the transition now, not the creation now)', () => {
      const commandId = insertCommand('msg-1@example.com');
      const created = store.create(
        clarificationInput(commandId, { now: '2026-07-19T00:00:00.000Z' }),
      );

      store.transition(created.id, 'CONSUMED', null, '2026-07-19T00:10:00.000Z');

      expect(store.findByThreadKey(created.threadKey)).toEqual({
        ...created,
        status: 'CONSUMED',
        statusReason: null,
        updatedAt: '2026-07-19T00:10:00.000Z',
      });
    });

    it('an illegal transition (CONSUMED -> EXPIRED) throws IllegalTransitionError machine clarification and leaves the row byte-identical', () => {
      const commandId = insertCommand('msg-1@example.com');
      const created = store.create(
        clarificationInput(commandId, { now: '2026-07-19T00:00:00.000Z' }),
      );
      store.transition(created.id, 'CONSUMED', null, '2026-07-19T00:10:00.000Z');
      const beforeIllegalAttempt = store.findByThreadKey(created.threadKey);

      let caught: unknown;
      try {
        store.transition(created.id, 'EXPIRED', 'TTL_SWEEP', '2026-07-19T00:20:00.000Z');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(IllegalTransitionError);
      expect((caught as IllegalTransitionError).machine).toBe('clarification');
      // Full-row assert (not just "status unchanged"): also kills a mutant
      // that writes statusReason/updatedAt before the assert check runs.
      expect(store.findByThreadKey(created.threadKey)).toEqual(beforeIllegalAttempt);
    });

    it('throws an explicit error for an unknown id', () => {
      expect(() =>
        store.transition(999999, 'CONSUMED', null, '2026-07-19T00:10:00.000Z'),
      ).toThrow(/no clarification request with id 999999/);
    });

    it('full chain PENDING -> CONSUMED persists the end state with a null reason', () => {
      const commandId = insertCommand('msg-1@example.com');
      const created = store.create(
        clarificationInput(commandId, { now: '2026-07-19T00:00:00.000Z' }),
      );

      store.transition(created.id, 'CONSUMED', null, '2026-07-19T00:10:00.000Z');

      const row = store.findByThreadKey(created.threadKey);
      expect(row?.status).toBe('CONSUMED');
      expect(row?.statusReason).toBeNull();
    });

    it('full chain PENDING -> EXPIRED persists the end state with a non-null reason', () => {
      const commandId = insertCommand('msg-1@example.com');
      const created = store.create(
        clarificationInput(commandId, { now: '2026-07-19T00:00:00.000Z' }),
      );

      store.transition(created.id, 'EXPIRED', 'TTL_SWEEP', '2026-07-19T00:10:00.000Z');

      const row = store.findByThreadKey(created.threadKey);
      expect(row?.status).toBe('EXPIRED');
      expect(row?.statusReason).toBe('TTL_SWEEP');
    });

    // PENDING -> SUPERSEDED is already covered above (the create-reissue
    // invariant test): that is the only PRODUCTION path to SUPERSEDED —
    // D-P4B4-1's invariant is enforced inside create(). A direct
    // transition(id, 'SUPERSEDED', ...) from PENDING is nonetheless legal in
    // the domain map and this store would persist it; the invariant lives in
    // create()'s supersede-then-insert transaction, not in an extra edge
    // restriction here.
  });
});
