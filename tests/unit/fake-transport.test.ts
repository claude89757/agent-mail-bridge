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
          headers: new Map([['x-amb-outbox-id', receipt.outboxId]]),
          from: [],
          to: [],
          cc: [],
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
          headers: new Map([['x-amb-outbox-id', receipt.outboxId]]),
          from: [],
          to: [],
          cc: [],
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
