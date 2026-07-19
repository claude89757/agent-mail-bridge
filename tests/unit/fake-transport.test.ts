import { describe, expect, it } from 'vitest';

import type { IncomingMail, OutboundMail, SendReceipt } from '../../src/transports/types.js';
import { FakeMailTransport, FAKE_MAILBOX, FAKE_UID_VALIDITY } from '../helpers/fakeTransport.js';

// Guards decision D-P2-11 (transport seam + fake): tests/helpers/fakeTransport.ts
// is what every Phase 2 test drives instead of a real IMAP/SMTP connection, and
// it must implement the real MailTransport contract faithfully so Phase 3 can
// swap in the real imap-smtp transport behind the exact same seam.

// Placeholder self address (public-repo rule: no real mailbox addresses in
// git) — matches the constant used across tests/unit/domain-identity.test.ts.
const SELF = 'bridge-user@example.com';

function incomingMail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: 'msg-1@example.com',
    headers: new Map(),
    from: [SELF],
    to: [SELF],
    cc: [],
    bodyText: null,
    internalDate: '2026-07-17T00:00:00.000Z',
    uid: 1,
    uidValidity: FAKE_UID_VALIDITY,
    mailbox: FAKE_MAILBOX,
    ...overrides,
  };
}

function outboundMail(overrides: Partial<OutboundMail> = {}): OutboundMail {
  return {
    kind: 'ACK',
    commandId: null,
    subjectRedacted: '[redacted]',
    bodyRedacted: '[redacted]',
    ...overrides,
  };
}

function noopRegisterOutbox(): void {
  // Test default: most tests don't care about the registration side effect.
}

describe('FakeMailTransport (D-P2-11 fake)', () => {
  describe('deliver + fetchSince', () => {
    it('returns nothing before anything is delivered', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });

      await expect(transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0)).resolves.toEqual([]);
    });

    it('respects sinceUid: only uids strictly greater than it come back', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const mail1 = incomingMail({ uid: 1 });
      const mail2 = incomingMail({ uid: 2 });
      const mail3 = incomingMail({ uid: 3 });
      transport.deliver(mail1);
      transport.deliver(mail2);
      transport.deliver(mail3);

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 1);

      expect(result).toEqual([mail2, mail3]);
    });

    it('only returns mail matching both mailbox and uidValidity', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const wanted = incomingMail({ uid: 5 });
      const otherMailbox = incomingMail({ uid: 5, mailbox: 'Archive' });
      const otherUidValidity = incomingMail({ uid: 5, uidValidity: 'different-uidvalidity' });
      transport.deliver(wanted);
      transport.deliver(otherMailbox);
      transport.deliver(otherUidValidity);

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);

      expect(result).toEqual([wanted]);
    });

    it('preserves delivery order rather than sorting by uid (out-of-order delivery)', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const deliveredLater = incomingMail({ uid: 9, messageId: 'later@example.com' });
      const deliveredEarlier = incomingMail({ uid: 3, messageId: 'earlier@example.com' });
      transport.deliver(deliveredLater);
      transport.deliver(deliveredEarlier);

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);

      expect(result).toEqual([deliveredLater, deliveredEarlier]);
    });

    it('preserves duplicates: at-least-once delivery is not deduped by the transport', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const mail = incomingMail({ uid: 7, messageId: 'dup@example.com' });
      transport.deliver(mail);
      transport.deliver(mail);

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);

      expect(result).toEqual([mail, mail]);
    });
  });

  describe('multi-value headers (D-P3B2-1)', () => {
    // headers is a multi-value map (ReadonlyMap<string, readonly string[]>)
    // because Authentication-Results legitimately repeats once per
    // forwarding hop; a single-value map would silently drop every instance
    // but the last. The fake transport does no header processing of its own
    // — deliver/fetchSince pass the IncomingMail through unchanged — so this
    // pins the SHAPE the seam now carries end to end through the one real
    // implementation Phase 2/3 tests drive.
    it('round-trips two same-name header instances through deliver/fetchSince, in occurrence order', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const firstHop = 'mx1.example.com; dkim=pass header.d=example.com';
      const secondHop = 'mx2.example.com; dkim=fail header.d=example.net';
      const multiHeaderMail = incomingMail({
        uid: 1,
        headers: new Map([['authentication-results', [firstHop, secondHop]]]),
      });

      transport.deliver(multiHeaderMail);

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);
      expect(result[0]?.headers.get('authentication-results')).toEqual([firstHop, secondHop]);
    });
  });

  describe('deliver uid-collision guard', () => {
    // On a real IMAP server a uid is never reused within one uidValidity, so
    // two DIFFERENT mails on the same (mailbox, uidValidity, uid) triple is
    // an impossible state — reaching it in a test always means a broken
    // fixture (e.g. hand-picking uid 1 after reflectOutbound already
    // auto-assigned it). The fake fails loudly instead of modeling it.
    it('throws when a DIFFERENT mail (different messageId) reuses an already-delivered triple', () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      transport.deliver(incomingMail({ uid: 7, messageId: 'first@example.com' }));

      expect(() =>
        transport.deliver(incomingMail({ uid: 7, messageId: 'second@example.com' })),
      ).toThrow(/uid collision/);
    });

    it('allows redelivery as a re-parsed copy: distinct object, same non-null messageId', async () => {
      // At-least-once redelivery in practice hands the caller a fresh parse
      // of the same message, not the same object reference — that must stay
      // as legal as the reference-equal case.
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      transport.deliver(incomingMail({ uid: 7, messageId: 'dup@example.com' }));

      expect(() =>
        transport.deliver(incomingMail({ uid: 7, messageId: 'dup@example.com' })),
      ).not.toThrow();

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);
      expect(result).toHaveLength(2);
    });

    it('allows redelivering the very same object even when its Message-ID is null', () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const mail = incomingMail({ uid: 7, messageId: null });
      transport.deliver(mail);

      expect(() => transport.deliver(mail)).not.toThrow();
    });

    it('throws for two DISTINCT null-Message-ID objects on the same triple', () => {
      // With no Message-ID and no shared reference there is nothing left to
      // prove they are the same logical mail — fail closed as a collision.
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      transport.deliver(incomingMail({ uid: 7, messageId: null }));

      expect(() => transport.deliver(incomingMail({ uid: 7, messageId: null }))).toThrow(
        /uid collision/,
      );
    });
  });

  describe('send', () => {
    it('invokes registerOutbox BEFORE the returned promise resolves', async () => {
      const events: string[] = [];
      const transport = new FakeMailTransport({
        registerOutbox: () => {
          events.push('registered');
        },
      });

      await transport.send(outboundMail());
      events.push('resolved');

      expect(events).toEqual(['registered', 'resolved']);
    });

    it('awaits an async registerOutbox before resolving', async () => {
      const events: string[] = [];
      const transport = new FakeMailTransport({
        registerOutbox: async () => {
          await Promise.resolve();
          events.push('registered');
        },
      });

      await transport.send(outboundMail());
      events.push('resolved');

      expect(events).toEqual(['registered', 'resolved']);
    });

    it('passes the receipt and the original mail to registerOutbox', async () => {
      let received: { receipt: SendReceipt; mail: OutboundMail } | null = null;
      const transport = new FakeMailTransport({
        registerOutbox: (receipt, mail) => {
          received = { receipt, mail };
        },
      });
      const mail = outboundMail({ kind: 'CLARIFICATION', commandId: 42 });

      const receipt = await transport.send(mail);

      expect(received).toEqual({ receipt, mail });
    });

    it('produces a deterministic synthetic Message-ID and outboxId, never random', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });

      const first = await transport.send(outboundMail());
      const second = await transport.send(outboundMail());

      expect(first.messageId).toBe('<fake-1@bridge-user.example.com>');
      expect(second.messageId).toBe('<fake-2@bridge-user.example.com>');
      expect(first.outboxId).not.toBe(second.outboxId);
    });

    it('accumulates every sent mail into the public sentMails list, in send order', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const ack = outboundMail({ kind: 'ACK' });
      const result = outboundMail({ kind: 'RESULT' });

      await transport.send(ack);
      await transport.send(result);

      expect(transport.sentMails).toEqual([ack, result]);
    });

    it('rejects with the registerOutbox error and records nothing into sentMails', async () => {
      // Mirrors the real send order's failure half: if the outbox row cannot
      // be recorded, no send happened — the error propagates, no receipt is
      // ever observable, and the mail must not appear as "sent".
      const failure = new Error('outbox row could not be recorded');
      const transport = new FakeMailTransport({
        registerOutbox: () => Promise.reject(failure),
      });

      await expect(transport.send(outboundMail())).rejects.toBe(failure);
      expect(transport.sentMails).toEqual([]);
    });
  });

  describe('reflectOutbound', () => {
    it('re-delivers the sent mail as an IncomingMail carrying the x-amb-outbox-id header', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const receipt = await transport.send(outboundMail());

      transport.reflectOutbound(receipt, '2026-07-17T12:00:00.000Z');

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);
      expect(result).toEqual([
        {
          messageId: receipt.messageId,
          headers: new Map([['x-amb-outbox-id', [receipt.outboxId]]]),
          from: [],
          to: [],
          cc: [],
          bodyText: null,
          internalDate: '2026-07-17T12:00:00.000Z',
          uid: 1,
          uidValidity: FAKE_UID_VALIDITY,
          mailbox: FAKE_MAILBOX,
        },
      ]);
    });

    it('gives the reflected mail the same Message-ID as the send receipt', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const receipt = await transport.send(outboundMail());

      transport.reflectOutbound(receipt);

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);
      expect(result.map((mail) => mail.messageId)).toEqual([receipt.messageId]);
    });

    it('gives the reflected mail a fresh uid strictly ahead of anything already delivered', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const priorMail = incomingMail({ uid: 10 });
      transport.deliver(priorMail);
      const receipt = await transport.send(outboundMail());

      transport.reflectOutbound(receipt, '2026-07-17T00:00:00.000Z');

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);
      expect(result).toEqual([
        priorMail,
        {
          messageId: receipt.messageId,
          headers: new Map([['x-amb-outbox-id', [receipt.outboxId]]]),
          from: [],
          to: [],
          cc: [],
          bodyText: null,
          internalDate: '2026-07-17T00:00:00.000Z',
          uid: 11,
          uidValidity: FAKE_UID_VALIDITY,
          mailbox: FAKE_MAILBOX,
        },
      ]);
    });

    it('defaults internalDate to a fixed, deterministic instant when the caller omits it', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const receipt = await transport.send(outboundMail());

      transport.reflectOutbound(receipt);

      const result = await transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, 0);
      expect(result.map((mail) => mail.internalDate)).toEqual(['1970-01-01T00:00:00.000Z']);
    });
  });

  describe('markProcessed', () => {
    it('records the mail into the public processedMails list', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const mail = incomingMail();

      await transport.markProcessed(mail);

      expect(transport.processedMails).toEqual([mail]);
    });

    it('accumulates every call, in order', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });
      const first = incomingMail({ uid: 1 });
      const second = incomingMail({ uid: 2 });

      await transport.markProcessed(first);
      await transport.markProcessed(second);

      expect(transport.processedMails).toEqual([first, second]);
    });
  });

  describe('close', () => {
    it('resolves', async () => {
      const transport = new FakeMailTransport({ registerOutbox: noopRegisterOutbox });

      await expect(transport.close()).resolves.toBeUndefined();
    });
  });
});
