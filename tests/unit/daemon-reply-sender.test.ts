import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRegisterOutbox, sendReply } from '../../src/daemon/replySender.js';
import type { ReplySenderDeps } from '../../src/daemon/replySender.js';
import { openDatabase } from '../../src/store/database.js';
import { CommandStore } from '../../src/store/commandStore.js';
import { OutboxStore } from '../../src/store/outboxStore.js';
import type { MailTransport, OutboundMail, SendReceipt } from '../../src/transports/types.js';
import { FakeMailTransport } from '../helpers/fakeTransport.js';

// Guards D-P4B11-2 (src/daemon/replySender.ts — the outbox lifecycle glue
// around every daemon send, the C3 send-order invariant's daemon-side
// closure). Test style follows dispatch.test.ts / ingest.test.ts: REAL
// in-memory stores (the D-P2-3 outbox state machine stays armed — reaching
// SENT at all proves the PENDING→SENDING→SENT chain ran), FakeMailTransport
// for the happy path, and hand-rolled MailTransport stubs where the fake
// deliberately cannot model a behavior (an SMTP rejection AFTER the outbox
// row registered — the fake's send never fails post-register).
//
// Fixture discipline (public repo): placeholder addresses, low-entropy ids.

type Db = ReturnType<typeof openDatabase>;

const SEED_NOW = '2026-07-18T00:00:00.000Z';

let openDbs: Db[];

beforeEach(() => {
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
});

interface Harness {
  db: Db;
  commandStore: CommandStore;
  outboxStore: OutboxStore;
  /** Deps sans transport — tests wire their own transport per scenario. */
  base: Omit<ReplySenderDeps, 'transport'>;
  commandId: number;
}

function setup(): Harness {
  const db = openDatabase(':memory:');
  openDbs.push(db);
  const commandStore = new CommandStore(db);
  const outboxStore = new OutboxStore(db);
  const commandId = commandStore.insertIfAbsent({
    messageId: 'cmd-1@example.com',
    status: 'RECEIVED',
    statusReason: null,
    internalDate: SEED_NOW,
    uid: 1,
    uidValidity: '1690000000',
    now: SEED_NOW,
  }).record.id;

  let tick = 0;
  return {
    db,
    commandStore,
    outboxStore,
    base: {
      db,
      outboxStore,
      clock: () => new Date(Date.UTC(2026, 6, 19, 0, 0, tick++)).toISOString(),
    },
    commandId,
  };
}

function outboundMail(overrides: Partial<OutboundMail> = {}): OutboundMail {
  return {
    kind: 'RESULT',
    commandId: 1,
    subjectRedacted: 'Re: proj-a run tests',
    bodyRedacted: 'all done',
    ...overrides,
  };
}

/** A hand-rolled transport whose `send` runs `registerOutbox` with a fixed
 *  receipt and then rejects — the "SMTP failed after the row registered"
 *  path FakeMailTransport cannot model. Counts send calls so the
 *  no-blind-resend assertion is directly observable. */
function rejectingAfterRegisterTransport(
  registerOutbox: (receipt: SendReceipt, mail: OutboundMail) => Promise<void>,
  receipt: SendReceipt,
): { transport: MailTransport; sendCalls: () => number } {
  let calls = 0;
  const transport: MailTransport = {
    fetchSince: () => Promise.resolve([]),
    async send(mail: OutboundMail): Promise<SendReceipt> {
      calls += 1;
      await registerOutbox(receipt, mail);
      throw new Error('smtp: 421 service not available');
    },
    markProcessed: () => Promise.resolve(),
    mailboxStatus: () => Promise.resolve({ uidValidity: '1690000000', uidNext: 1 }),
    close: () => Promise.resolve(),
  };
  return { transport, sendCalls: () => calls };
}

/** A transport that rejects BEFORE ever reaching registerOutbox — the
 *  "nothing happened at all" path. */
function rejectingBeforeRegisterTransport(): MailTransport {
  return {
    fetchSince: () => Promise.resolve([]),
    send: () => Promise.reject(new Error('smtp: connect ECONNREFUSED')),
    markProcessed: () => Promise.resolve(),
    mailboxStatus: () => Promise.resolve({ uidValidity: '1690000000', uidNext: 1 }),
    close: () => Promise.resolve(),
  };
}

describe('buildRegisterOutbox (D-P4B11-2)', () => {
  it('creates the row and moves it PENDING→SENDING in one transaction, storing the NORMALIZED Message-ID (the echo-gate/reconciliation key)', async () => {
    const harness = setup();
    const register = buildRegisterOutbox(harness.base);

    await register(
      { outboxId: 'Aa-Aa-Out-0001', messageId: '<amb-Aa-Aa-Out-0001@agent-mail-bridge.invalid>' },
      outboundMail({ commandId: harness.commandId }),
    );

    expect(harness.outboxStore.findByCommandId(harness.commandId)).toEqual([
      {
        id: 'Aa-Aa-Out-0001',
        // Bracket-stripped: ingest's echo gate and the daemon's
        // UNCERTAIN→SENT reconciliation both look this row up by the
        // NORMALIZED inbound Message-ID.
        messageId: 'amb-Aa-Aa-Out-0001@agent-mail-bridge.invalid',
        commandId: harness.commandId,
        kind: 'RESULT',
        status: 'SENDING',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      },
    ]);
  });

  it('fails closed on a receipt Message-ID that cannot normalize: rejects, zero rows persisted', async () => {
    const harness = setup();
    const register = buildRegisterOutbox(harness.base);

    await expect(
      register(
        { outboxId: 'Aa-Aa-Out-0001', messageId: '<no-at-sign>' },
        outboundMail({ commandId: harness.commandId }),
      ),
    ).rejects.toThrow(/cannot normalize/);
    expect(harness.outboxStore.findByCommandId(harness.commandId)).toEqual([]);
    expect(harness.outboxStore.isKnownOutboxId('Aa-Aa-Out-0001')).toBe(false);
  });
});

describe('sendReply (D-P4B11-2)', () => {
  it('happy path over FakeMailTransport: SENT, row terminal-SENT (the store-enforced PENDING→SENDING→SENT chain ran)', async () => {
    const harness = setup();
    const transport = new FakeMailTransport({
      registerOutbox: buildRegisterOutbox(harness.base),
    });
    const mail = outboundMail({ commandId: harness.commandId });

    const result = await sendReply({ ...harness.base, transport }, mail);

    expect(result).toEqual({ outboxId: 'fake-outbox-1', status: 'SENT' });
    expect(transport.sentMails).toEqual([mail]);
    const row = harness.outboxStore.findByCommandId(harness.commandId)[0];
    expect(row?.id).toBe('fake-outbox-1');
    expect(row?.status).toBe('SENT');
    // Normalized form of the fake's minted '<fake-1@bridge-user.example.com>'.
    expect(row?.messageId).toBe('fake-1@bridge-user.example.com');
  });

  it('SMTP rejection after registration: UNCERTAIN on the registered row, and NEVER a second transport.send call', async () => {
    const harness = setup();
    const register = buildRegisterOutbox(harness.base);
    const { transport, sendCalls } = rejectingAfterRegisterTransport(register, {
      outboxId: 'Aa-Aa-Out-0001',
      messageId: '<amb-Aa-Aa-Out-0001@agent-mail-bridge.invalid>',
    });

    const result = await sendReply(
      { ...harness.base, transport },
      outboundMail({ commandId: harness.commandId }),
    );

    expect(result).toEqual({ outboxId: 'Aa-Aa-Out-0001', status: 'UNCERTAIN' });
    expect(harness.outboxStore.findByCommandId(harness.commandId)[0]?.status).toBe('UNCERTAIN');
    // Effectively-once red line: reconciliation owns UNCERTAIN, never a resend.
    expect(sendCalls()).toBe(1);
  });

  it('locates the rejected send by the id-order LAST SENDING row, leaving earlier SENT and stale SENDING rows untouched', async () => {
    const harness = setup();
    // An earlier reply for the same command that completed normally...
    harness.outboxStore.create({
      id: 'outbox-1-sent',
      messageId: 'earlier@example.com',
      commandId: harness.commandId,
      kind: 'ACK',
      now: SEED_NOW,
    });
    harness.outboxStore.transition('outbox-1-sent', 'SENDING', SEED_NOW);
    harness.outboxStore.transition('outbox-1-sent', 'SENT', SEED_NOW);
    // ...and a stale SENDING row (crash residue between register and outcome).
    harness.outboxStore.create({
      id: 'outbox-2-stale',
      messageId: 'stale@example.com',
      commandId: harness.commandId,
      kind: 'ERROR',
      now: SEED_NOW,
    });
    harness.outboxStore.transition('outbox-2-stale', 'SENDING', SEED_NOW);

    const register = buildRegisterOutbox(harness.base);
    const { transport } = rejectingAfterRegisterTransport(register, {
      outboxId: 'outbox-3-new',
      messageId: '<amb-outbox-3-new@agent-mail-bridge.invalid>',
    });

    const result = await sendReply(
      { ...harness.base, transport },
      outboundMail({ commandId: harness.commandId }),
    );

    expect(result).toEqual({ outboxId: 'outbox-3-new', status: 'UNCERTAIN' });
    const byId = new Map(
      harness.outboxStore.findByCommandId(harness.commandId).map((row) => [row.id, row.status]),
    );
    expect(byId.get('outbox-3-new')).toBe('UNCERTAIN');
    expect(byId.get('outbox-1-sent')).toBe('SENT');
    expect(byId.get('outbox-2-stale')).toBe('SENDING');
  });

  it('rejection before registration: REGISTER_FAILED with zero rows (nothing happened — safe to retry later)', async () => {
    const harness = setup();

    const result = await sendReply(
      { ...harness.base, transport: rejectingBeforeRegisterTransport() },
      outboundMail({ commandId: harness.commandId }),
    );

    expect(result).toEqual({ outboxId: null, status: 'REGISTER_FAILED' });
    expect(harness.outboxStore.findByCommandId(harness.commandId)).toEqual([]);
  });

  it('commandId-null mail whose send rejects cannot be located: REGISTER_FAILED semantics (doc-noted unreachable combination)', async () => {
    const harness = setup();
    const register = buildRegisterOutbox(harness.base);
    const { transport } = rejectingAfterRegisterTransport(register, {
      outboxId: 'Aa-Aa-Out-0002',
      messageId: '<amb-Aa-Aa-Out-0002@agent-mail-bridge.invalid>',
    });

    const result = await sendReply({ ...harness.base, transport }, outboundMail({ commandId: null }));

    // The registered row (commandId NULL) is stranded in SENDING — honest
    // about the limitation; every real reply carries a commandId.
    expect(result).toEqual({ outboxId: null, status: 'REGISTER_FAILED' });
    expect(harness.outboxStore.isKnownOutboxId('Aa-Aa-Out-0002')).toBe(true);
  });
});
