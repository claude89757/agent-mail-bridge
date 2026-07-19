import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIngest } from '../../src/application/ingest.js';
import type { IngestConfig } from '../../src/application/ingest.js';
import { deriveIntentId, normalizeMessageId, syntheticMessageKey } from '../../src/domain/mail.js';
import type { TimeWindowConfig } from '../../src/domain/timeWindow.js';
import { openDatabase } from '../../src/store/database.js';
import { CommandStore } from '../../src/store/commandStore.js';
import { IntentStore } from '../../src/store/intentStore.js';
import { MetaStore } from '../../src/store/metaStore.js';
import { OutboxStore } from '../../src/store/outboxStore.js';
import type { IncomingMail } from '../../src/transports/types.js';

// Guards decision D-P2-8: ingestMail turns one inbound mail into exactly one
// of five outcomes, with every persisted side effect landing inside ONE
// SQLite transaction. Fresh in-memory db per test (never shared state).
//
// Placeholder addresses only (public-repo rule) — mirrors
// tests/unit/domain-identity.test.ts's SELF/attacker convention.
const SELF = 'bridge-user@example.com';
const READY_AT = '2026-07-17T00:00:00.000Z';

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
  for (const db of openDbs) {
    db.close();
  }
});

/**
 * Fresh in-memory store set. `presetReadyAt: false` skips the readyAt
 * fixture entirely, for the NO_READY_AT fail-closed test — every other test
 * gets readyAt preset to `READY_AT` via `setReadyAtIfUnset` per the task.
 */
function setup(
  options: { config?: Partial<IngestConfig>; presetReadyAt?: boolean } = {},
): Deps {
  const db = openDatabase(':memory:');
  openDbs.push(db);

  const commandStore = new CommandStore(db);
  const intentStore = new IntentStore(db);
  const outboxStore = new OutboxStore(db);
  const metaStore = new MetaStore(db);

  if (options.presetReadyAt ?? true) {
    metaStore.setReadyAtIfUnset(READY_AT);
  }

  return {
    db,
    commandStore,
    intentStore,
    outboxStore,
    metaStore,
    config: { selfAddress: SELF, dryRun: false, ...options.config },
  };
}

/** Valid self-to-self mail, internalDate safely after READY_AT. Individual
 *  tests override only the field(s) under test. */
function mail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: '<msg-1@example.com>',
    headers: new Map(),
    from: [SELF],
    to: [SELF],
    cc: [],
    bodyText: null,
    internalDate: '2026-07-17T00:00:01.000Z',
    uid: 1,
    uidValidity: '1690000000',
    mailbox: 'INBOX',
    ...overrides,
  };
}

describe('createIngest / ingestMail (D-P2-8)', () => {
  it('valid mail is ready: command READY_FOR_DISPATCH, exactly one intent with the derived id', () => {
    const deps = setup();
    const ingest = createIngest(deps);

    const result = ingest(mail(), new Date('2026-07-17T00:00:05.000Z'));

    const expectedIntentId = deriveIntentId(normalizeMessageId('<msg-1@example.com>')!);
    expect(result.outcome).toBe('ready');
    expect(result.reason).toBeNull();
    expect(result.commandId).not.toBeNull();
    expect(result.intentId).toBe(expectedIntentId);
    expect(deps.commandStore.getByMessageId('msg-1@example.com')?.status).toBe(
      'READY_FOR_DISPATCH',
    );
    expect(deps.intentStore.countAll()).toBe(1);
    expect(deps.intentStore.getByCommandId(result.commandId!)).toEqual({
      id: expectedIntentId,
      status: 'PENDING',
      dryRun: false,
      statusReason: null,
      updatedAt: '2026-07-17T00:00:05.000Z',
    });
  });

  it('re-ingesting the same mail is duplicate: same command row, still exactly one intent', () => {
    const deps = setup();
    const ingest = createIngest(deps);
    const first = ingest(mail(), new Date('2026-07-17T00:00:05.000Z'));

    const second = ingest(mail(), new Date('2026-07-17T00:00:06.000Z'));

    expect(second.outcome).toBe('duplicate');
    expect(second.commandId).toBe(first.commandId);
    expect(second.intentId).toBe(first.intentId);
    expect(second.reason).toBeNull();
    expect(deps.intentStore.countAll()).toBe(1);
  });

  describe('echo gate (D-P2-4, control C3)', () => {
    it('classifies mail carrying a known x-amb-outbox-id header as echo, even with empty from/to/cc', () => {
      const deps = setup();
      deps.outboxStore.create({
        id: 'outbox-1',
        messageId: 'reply-1@example.com',
        commandId: null,
        kind: 'ACK',
        now: '2026-07-17T00:00:01.000Z',
      });
      const ingest = createIngest(deps);

      // Empty from/to/cc would otherwise fail C1 (IDENTITY_MULTI_RECIPIENT)
      // — this proves the echo gate really runs BEFORE identity, matching
      // how tests/helpers/fakeTransport.ts's reflectOutbound behaves.
      const result = ingest(
        mail({
          messageId: '<incoming-echo-1@example.com>',
          headers: new Map([['x-amb-outbox-id', ['outbox-1']]]),
          from: [],
          to: [],
          cc: [],
        }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('echo');
      expect(result.intentId).toBeNull();
      expect(deps.intentStore.countAll()).toBe(0);
      expect(deps.commandStore.getByMessageId('incoming-echo-1@example.com')?.status).toBe(
        'SYSTEM_ECHO',
      );
    });

    it('classifies mail whose Message-ID matches a known outbox message_id as echo, with no header', () => {
      const deps = setup();
      deps.outboxStore.create({
        id: 'outbox-2',
        messageId: 'reply-2@example.com',
        commandId: null,
        kind: 'ACK',
        now: '2026-07-17T00:00:01.000Z',
      });
      const ingest = createIngest(deps);

      const result = ingest(
        mail({ messageId: '<reply-2@example.com>', from: [], to: [], cc: [] }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('echo');
      expect(result.intentId).toBeNull();
      expect(deps.intentStore.countAll()).toBe(0);
    });

    it('reads x-amb-outbox-id from the FIRST instance only: a real recorded outbox id sitting in a SECOND instance does not make the mail an echo', () => {
      // Pins D-P3B2-1's first-instance-read semantics unambiguously. If the
      // gate instead treated ANY instance as sufficient (checking every
      // element rather than only headers.get(k)?.[0]), this mail — first
      // instance bogus, second instance a genuinely recorded outbox id —
      // would misclassify as `echo`. The bridge itself only ever writes ONE
      // x-amb-outbox-id instance on its own outbound mail (see
      // tests/helpers/fakeTransport.ts's reflectOutbound), so a second
      // instance can only come from someone else re-injecting the header;
      // reading just the first means that injected value is ignored and
      // this otherwise-valid self-to-self mail proceeds all the way to
      // `ready`, not `echo`.
      const deps = setup();
      deps.outboxStore.create({
        id: 'outbox-1',
        messageId: 'reply-1@example.com',
        commandId: null,
        kind: 'ACK',
        now: '2026-07-17T00:00:01.000Z',
      });
      const ingest = createIngest(deps);

      const result = ingest(
        mail({
          messageId: '<incoming-first-instance-pin@example.com>',
          headers: new Map([['x-amb-outbox-id', ['not-a-recorded-outbox-id', 'outbox-1']]]),
        }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('ready');
      expect(
        deps.commandStore.getByMessageId('incoming-first-instance-pin@example.com')?.status,
      ).toBe('READY_FOR_DISPATCH');
    });
  });

  it('rejects BEFORE_READY when internalDate is before the readyAt fence', () => {
    const deps = setup();
    const ingest = createIngest(deps);

    const result = ingest(
      mail({ internalDate: '2026-07-16T23:59:59.000Z' }),
      new Date('2026-07-17T00:00:05.000Z'),
    );

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('BEFORE_READY');
    expect(deps.commandStore.getByMessageId('msg-1@example.com')?.status).toBe('REJECTED');
    expect(deps.intentStore.countAll()).toBe(0);
  });

  it('rejects NO_READY_AT when getReadyAt() is null (fail closed, readyAt never set)', () => {
    const deps = setup({ presetReadyAt: false });
    const ingest = createIngest(deps);

    const result = ingest(mail(), new Date('2026-07-17T00:00:05.000Z'));

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('NO_READY_AT');
    expect(deps.commandStore.getByMessageId('msg-1@example.com')?.status).toBe('REJECTED');
    expect(deps.intentStore.countAll()).toBe(0);
  });

  it('locks the D-P2-8 chain order: readyAt fence wins over a C1 violation when both apply', () => {
    // Mail that is BOTH before readyAt AND identity-invalid (From != self).
    // The chain order is normative (D-P2-8): readyAt fence runs before C1,
    // so BEFORE_READY must win, never an IDENTITY_* reason.
    const deps = setup();
    const ingest = createIngest(deps);

    const result = ingest(
      mail({ internalDate: '2026-07-16T23:59:59.000Z', from: ['attacker@example.net'] }),
      new Date('2026-07-17T00:00:05.000Z'),
    );

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('BEFORE_READY');
  });

  it('missing Message-ID is rejected NO_MESSAGE_ID keyed by the synthetic uid key; re-ingest is duplicate', () => {
    const deps = setup();
    const ingest = createIngest(deps);
    const noIdMail = mail({ messageId: null });

    const first = ingest(noIdMail, new Date('2026-07-17T00:00:05.000Z'));

    expect(first.outcome).toBe('rejected');
    expect(first.reason).toBe('NO_MESSAGE_ID');
    const syntheticKey = syntheticMessageKey('1690000000', 1);
    expect(deps.commandStore.getByMessageId(syntheticKey)?.status).toBe('REJECTED');
    expect(deps.intentStore.countAll()).toBe(0);

    const second = ingest(noIdMail, new Date('2026-07-17T00:00:06.000Z'));

    expect(second.outcome).toBe('duplicate');
    expect(second.commandId).toBe(first.commandId);
    expect(second.intentId).toBeNull();
    expect(second.reason).toBeNull();
  });

  describe('C1 identity gate (D-P2-5): reason forwarded verbatim from checkIdentityC1', () => {
    it('rejects IDENTITY_MULTI_RECIPIENT for two From addresses', () => {
      const deps = setup();
      const ingest = createIngest(deps);

      const result = ingest(
        mail({ from: [SELF, 'attacker@example.net'] }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toBe('IDENTITY_MULTI_RECIPIENT');
      expect(deps.intentStore.countAll()).toBe(0);
    });

    it('rejects IDENTITY_CC when Cc is present', () => {
      const deps = setup();
      const ingest = createIngest(deps);

      const result = ingest(
        mail({ cc: ['observer@example.net'] }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toBe('IDENTITY_CC');
      expect(deps.intentStore.countAll()).toBe(0);
    });

    it('rejects IDENTITY_PLUS_TAG for a plus-tagged From', () => {
      const deps = setup();
      const ingest = createIngest(deps);

      const result = ingest(
        mail({ from: ['bridge-user+tag@example.com'] }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toBe('IDENTITY_PLUS_TAG');
      expect(deps.intentStore.countAll()).toBe(0);
    });

    it('rejects IDENTITY_FROM when From does not match self', () => {
      const deps = setup();
      const ingest = createIngest(deps);

      const result = ingest(
        mail({ from: ['attacker@example.net'] }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toBe('IDENTITY_FROM');
      expect(deps.commandStore.getByMessageId('msg-1@example.com')?.status).toBe('REJECTED');
      expect(deps.intentStore.countAll()).toBe(0);
    });

    it('rejects IDENTITY_TO when To does not match self', () => {
      const deps = setup();
      const ingest = createIngest(deps);

      const result = ingest(
        mail({ to: ['attacker@example.net'] }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toBe('IDENTITY_TO');
      expect(deps.intentStore.countAll()).toBe(0);
    });

    it('applies the D-P2-5 priority order end-to-end: MULTI_RECIPIENT wins over CC', () => {
      const deps = setup();
      const ingest = createIngest(deps);

      const result = ingest(
        mail({ from: [SELF, 'attacker@example.net'], cc: ['observer@example.net'] }),
        new Date('2026-07-17T00:00:05.000Z'),
      );

      expect(result.outcome).toBe('rejected');
      expect(result.reason).toBe('IDENTITY_MULTI_RECIPIENT');
    });
  });

  describe('time window (D-P2-6)', () => {
    const window: TimeWindowConfig = {
      timezone: 'Asia/Shanghai',
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '09:00',
      end: '18:00',
      excludeDates: [],
    };

    it('outside the configured window is queued-window with 0 intents', () => {
      const deps = setup({ config: { timeWindow: window } });
      const ingest = createIngest(deps);
      // 2026-07-17T00:00:00Z = Shanghai 08:00 (Fri) — before the 09:00 open.
      const outsideNow = new Date('2026-07-17T00:00:00Z');

      const result = ingest(mail(), outsideNow);

      expect(result.outcome).toBe('queued-window');
      expect(result.intentId).toBeNull();
      expect(result.reason).toBe('outside-hours');
      expect(deps.commandStore.getByMessageId('msg-1@example.com')?.status).toBe(
        'QUEUED_WINDOW',
      );
      expect(deps.intentStore.countAll()).toBe(0);
    });

    it('the same mail with no timeWindow configured is ready regardless of now', () => {
      const deps = setup();
      const ingest = createIngest(deps);
      const outsideNow = new Date('2026-07-17T00:00:00Z');

      const result = ingest(mail(), outsideNow);

      expect(result.outcome).toBe('ready');
    });
  });

  it('dryRun: true marks the created intent dryRun (via intentStore.getByCommandId)', () => {
    const deps = setup({ config: { dryRun: true } });
    const ingest = createIngest(deps);

    const result = ingest(mail(), new Date('2026-07-17T00:00:05.000Z'));

    expect(result.outcome).toBe('ready');
    expect(deps.intentStore.getByCommandId(result.commandId!)?.dryRun).toBe(true);
  });

  it('advances the uid watermark regardless of outcome (asserted on a rejected mail)', () => {
    const deps = setup();
    const ingest = createIngest(deps);

    const result = ingest(
      mail({ from: ['attacker@example.net'] }),
      new Date('2026-07-17T00:00:05.000Z'),
    );

    expect(result.outcome).toBe('rejected');
    expect(deps.metaStore.getWatermark('INBOX', '1690000000')).toBe(1);
  });
});
