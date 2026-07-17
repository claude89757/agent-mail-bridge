import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IllegalTransitionError } from '../../src/domain/errors.js';
import { openDatabase } from '../../src/store/database.js';
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

describe('IntentStore (D-P2-10)', () => {
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
