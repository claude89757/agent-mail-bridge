import { describe, expect, it } from 'vitest';

import {
  createImapReadTransport,
  parseHeaderBlock,
} from '../../src/transports/imapRead.js';
import type {
  FetchedMessage,
  ImapClientFactory,
  ImapClientLike,
  SmtpMessage,
} from '../../src/transports/imapRead.js';
import { UidValidityChangedError } from '../../src/transports/errors.js';
import type {
  IncomingMail,
  MailTransport,
  OutboundMail,
  SendReceipt,
} from '../../src/transports/types.js';

// Guards D-P3B2-2/D-P3B2-3 (docs/superpowers/plans/2026-07-19-phase-3-batch2-imap-read-path.md):
// the first real MailTransport implementation, driven entirely through a
// scripted fake ImapClientLike + factory (never a real IMAP connection —
// that is the concurrent Task 3 live-read-only test's job).
//
// Placeholder addresses only (public-repo rule): bridge-user@example.com /
// example.net, matching the convention already used across
// tests/helpers/fakeTransport.ts and tests/unit/domain-auth-results.test.ts.

const MAILBOX = 'INBOX';
const UIDVALIDITY = '1690000000';
const UIDVALIDITY_BIGINT = 1690000000n;

/** The bridge's own address for send-half tests (placeholder, public-repo
 *  rule). */
const SELF_ADDRESS = 'bridge-user@example.com';

/** Fixed outbox id injected via `mintOutboxId` for deterministic receipts.
 *  Deliberately LOW-entropy (`Aa-…-0001` style, never a real UUID): a
 *  high-entropy fixture string would trip the CI gitleaks scan (AGENTS.md
 *  test-credential discipline). */
const FIXED_OUTBOX_ID = 'Aa-Aa-Out-0001';

/** The Message-ID `send` must mint for {@link FIXED_OUTBOX_ID}:
 *  `<amb-<outboxId>@agent-mail-bridge.invalid>` (D-P3B5-2 clause 3). */
const FIXED_MESSAGE_ID = '<amb-Aa-Aa-Out-0001@agent-mail-bridge.invalid>';

/** One entry in a scripted fake's call log, in call order. Distinguishing
 *  `messageFlagsAdd`'s IMAP-uid-vs-flags-vs-opts fields by name (`uidOpt`
 *  rather than a second `uid`) keeps every logged call a flat, directly
 *  `toEqual`-able object. */
type LoggedCall =
  | { op: 'connect' }
  | { op: 'getMailboxLock'; path: string; readOnly: boolean }
  | { op: 'release' }
  | { op: 'logout' }
  | { op: 'search'; query: string }
  | { op: 'fetchOne'; uid: string | number }
  | { op: 'messageFlagsAdd'; uid: string | number; flags: string[]; uidOpt: boolean };

interface ClientScript {
  mailbox: { uidValidity: bigint; uidNext: number } | false;
  search?: number[] | false;
  fetch?: ReadonlyMap<number, FetchedMessage | false>;
}

/** Builds a scripted `ImapClientLike` that records every call into `log`,
 *  in call order, and answers from `script`. Unused method parameters
 *  (e.g. `fetchOne`'s query/opts, which this module always calls the exact
 *  same hardcoded way — see the "search/fetchOne opts" note in
 *  imapRead.ts) are simply omitted rather than named-and-ignored: a fake
 *  method may declare FEWER parameters than the interface it implements
 *  (TypeScript's standard "callback ignores trailing args" leniency), which
 *  sidesteps this repo's no-unused-vars lint rule without a disable
 *  comment. */
function createScriptedClient(log: LoggedCall[], script: ClientScript): ImapClientLike {
  return {
    mailbox: script.mailbox,
    async getMailboxLock(path: string, opts: { readOnly: boolean }) {
      log.push({ op: 'getMailboxLock', path, readOnly: opts.readOnly });
      return {
        release() {
          log.push({ op: 'release' });
        },
      };
    },
    async search(query: { uid: string }) {
      log.push({ op: 'search', query: query.uid });
      return script.search ?? [];
    },
    async fetchOne(uid: string | number) {
      log.push({ op: 'fetchOne', uid });
      const result = script.fetch?.get(Number(uid));
      return result ?? false;
    },
    async messageFlagsAdd(uid: string | number, flags: string[], opts: { uid: true }) {
      log.push({ op: 'messageFlagsAdd', uid, flags, uidOpt: opts.uid });
      return true;
    },
    async logout() {
      log.push({ op: 'logout' });
    },
  };
}

function createScriptedFactory(log: LoggedCall[], script: ClientScript): ImapClientFactory {
  return {
    async connect() {
      log.push({ op: 'connect' });
      return createScriptedClient(log, script);
    },
  };
}

/** A factory that throws if `connect` is ever called — used to prove a
 *  transport method touches zero client/network state (`send`, `close`). */
function createExplodingFactory(): ImapClientFactory {
  return {
    connect(): Promise<ImapClientLike> {
      throw new Error('factory.connect() should not have been called');
    },
  };
}

function fetchedMessageFixture(overrides: Partial<FetchedMessage> = {}): FetchedMessage {
  return {
    envelope: {
      messageId: '<fixture@example.com>',
      from: [{ address: 'sender@example.com' }],
      to: [{ address: 'bridge-user@example.com' }],
      cc: [],
    },
    internalDate: new Date('2026-07-18T00:00:00.000Z'),
    headers: Buffer.from('Subject: Fixture\r\n', 'utf-8'),
    ...overrides,
  };
}

function incomingMailFixture(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: '<processed@example.com>',
    headers: new Map(),
    from: [],
    to: [],
    cc: [],
    internalDate: '2026-07-18T00:00:00.000Z',
    uid: 1,
    uidValidity: UIDVALIDITY,
    mailbox: MAILBOX,
    ...overrides,
  };
}

function outboundMailFixture(): OutboundMail {
  return { kind: 'ACK', commandId: null, subjectRedacted: '[redacted]', bodyRedacted: '[redacted]' };
}

/** What `createSendHarness` captures from one send-configured transport. */
interface SendHarness {
  transport: MailTransport;
  /** `'register'` / `'smtp'` entries in actual call order — the C3 order
   *  invariant (D-P3B5-2 clause 1) is asserted against this log. */
  events: Array<'register' | 'smtp'>;
  /** Every `SmtpMessage` the fake smtpSend captured, in call order. */
  smtpMessages: SmtpMessage[];
  /** Every (receipt, mail) pair registerOutbox captured, in call order. */
  registrations: Array<{ receipt: SendReceipt; mail: OutboundMail }>;
}

/** Builds a send-configured transport over an exploding IMAP factory
 *  (proving `send` touches zero IMAP client state), with capturing fakes
 *  and a fixed `mintOutboxId`. Failure-path tests (a dep that throws)
 *  build their own logging fakes inline instead of taking overrides here,
 *  so each test's event log provably comes from the exact fakes it wired. */
function createSendHarness(): SendHarness {
  const events: Array<'register' | 'smtp'> = [];
  const smtpMessages: SmtpMessage[] = [];
  const registrations: Array<{ receipt: SendReceipt; mail: OutboundMail }> = [];
  const transport = createImapReadTransport({
    factory: createExplodingFactory(),
    send: {
      selfAddress: SELF_ADDRESS,
      smtpSend: async (message) => {
        events.push('smtp');
        smtpMessages.push(message);
      },
      registerOutbox: async (receipt, mail) => {
        events.push('register');
        registrations.push({ receipt, mail });
      },
      mintOutboxId: () => FIXED_OUTBOX_ID,
    },
  });
  return { transport, events, smtpMessages, registrations };
}

describe('createImapReadTransport (D-P3B2-2/3)', () => {
  describe('fetchSince', () => {
    it('maps a full happy path: folded headers, duplicate Authentication-Results, addr-specs, ISO internalDate, raw messageId, ascending uid order', async () => {
      const log: LoggedCall[] = [];
      const messageTen = fetchedMessageFixture({
        envelope: {
          messageId: '<msg-10@example.com>',
          from: [{ name: 'Sender Name', address: 'sender@example.com' }],
          to: [{ name: 'Bridge User', address: 'bridge-user@example.com' }],
          cc: [],
        },
        internalDate: new Date('2026-07-18T10:00:00.000Z'),
        headers: Buffer.from(
          'Subject: Hello\r\n' +
            ' World\r\n' +
            'Authentication-Results: mx1.example.com; dkim=pass header.d=example.com\r\n' +
            'Authentication-Results: mx2.example.com; dkim=fail header.d=example.net\r\n',
          'utf-8',
        ),
      });
      const messageFive = fetchedMessageFixture({
        envelope: {
          messageId: '<msg-5@example.net>',
          from: [{ address: 'other@example.net' }],
          to: [{ address: 'bridge-user@example.com' }],
          cc: [{ address: 'cc@example.net' }],
        },
        internalDate: new Date('2026-07-18T09:00:00.000Z'),
        headers: Buffer.from('Subject: Second\r\n', 'utf-8'),
      });
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 11 },
        // Deliberately out of ascending order: fetchSince must sort, not
        // trust search/fetch order (D-P3B2-3 step 5).
        search: [10, 5],
        fetch: new Map([
          [10, messageTen],
          [5, messageFive],
        ]),
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, 4);

      expect(result).toEqual([
        {
          messageId: '<msg-5@example.net>',
          headers: new Map([['subject', ['Second']]]),
          from: ['other@example.net'],
          to: ['bridge-user@example.com'],
          cc: ['cc@example.net'],
          internalDate: '2026-07-18T09:00:00.000Z',
          uid: 5,
          uidValidity: UIDVALIDITY,
          mailbox: MAILBOX,
        },
        {
          messageId: '<msg-10@example.com>',
          headers: new Map([
            ['subject', ['Hello World']],
            [
              'authentication-results',
              [
                'mx1.example.com; dkim=pass header.d=example.com',
                'mx2.example.com; dkim=fail header.d=example.net',
              ],
            ],
          ]),
          from: ['sender@example.com'],
          to: ['bridge-user@example.com'],
          cc: [],
          internalDate: '2026-07-18T10:00:00.000Z',
          uid: 10,
          uidValidity: UIDVALIDITY,
          mailbox: MAILBOX,
        },
      ]);
      expect(log.find((c) => c.op === 'search')).toEqual({ op: 'search', query: '5:*' });
    });

    it('opens the mailbox lock read-only', async () => {
      const log: LoggedCall[] = [];
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 1 },
        search: [],
      });
      const transport = createImapReadTransport({ factory });

      await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(log).toContainEqual({ op: 'getMailboxLock', path: MAILBOX, readOnly: true });
    });

    it('throws UidValidityChangedError with expected/actual and releases the lock without ever searching or fetching', async () => {
      const log: LoggedCall[] = [];
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: 999n, uidNext: 1 },
      });
      const transport = createImapReadTransport({ factory });

      let caught: unknown;
      try {
        await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UidValidityChangedError);
      expect(caught).toMatchObject({ expected: UIDVALIDITY, actual: '999' });
      expect(log).toEqual([
        { op: 'connect' },
        { op: 'getMailboxLock', path: MAILBOX, readOnly: true },
        { op: 'release' },
        { op: 'logout' },
      ]);
    });

    it('throws a clean error and still releases/logs out when mailbox is false', async () => {
      const log: LoggedCall[] = [];
      const factory = createScriptedFactory(log, { mailbox: false });
      const transport = createImapReadTransport({ factory });

      let caught: unknown;
      try {
        await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(UidValidityChangedError);
      expect(log).toEqual([
        { op: 'connect' },
        { op: 'getMailboxLock', path: MAILBOX, readOnly: true },
        { op: 'release' },
        { op: 'logout' },
      ]);
    });

    it('returns [] with zero fetchOne calls when search only echoes back the n:* range-inversion artifact (P0-1 measured quirk)', async () => {
      const log: LoggedCall[] = [];
      const sinceUid = 42;
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 43 },
        search: [sinceUid],
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, sinceUid);

      expect(result).toEqual([]);
      expect(log.some((c) => c.op === 'fetchOne')).toBe(false);
    });

    it('treats a false search result as no matches', async () => {
      const log: LoggedCall[] = [];
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 1 },
        search: false,
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(result).toEqual([]);
    });

    it('skips a uid whose fetchOne races an expunge (returns false) and still returns the other message', async () => {
      const log: LoggedCall[] = [];
      const survivor = fetchedMessageFixture();
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 3 },
        search: [1, 2],
        fetch: new Map<number, FetchedMessage | false>([
          [1, false],
          [2, survivor],
        ]),
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(result.map((mail) => mail.uid)).toEqual([2]);
    });

    it('propagates a mapping error and still releases/logs out (finally)', async () => {
      const log: LoggedCall[] = [];
      const malformed = fetchedMessageFixture({
        envelope: {
          messageId: '<bad@example.com>',
          // Deliberately lies about the type imapflow guarantees (`address`
          // is always a string per imapflow 1.4.7's own construction — see
          // ImapAddressLike's doc comment in imapRead.ts) to manufacture a
          // genuine runtime throw inside the mapper, proving fetchSince's
          // finally block still releases the lock and logs out even when
          // mapping itself blows up mid-message.
          from: [{ address: 42 as unknown as string }],
          to: [],
          cc: [],
        },
      });
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 2 },
        search: [1],
        fetch: new Map([[1, malformed]]),
      });
      const transport = createImapReadTransport({ factory });

      await expect(transport.fetchSince(MAILBOX, UIDVALIDITY, 0)).rejects.toThrow();

      expect(log).toEqual([
        { op: 'connect' },
        { op: 'getMailboxLock', path: MAILBOX, readOnly: true },
        { op: 'search', query: '1:*' },
        { op: 'fetchOne', uid: 1 },
        { op: 'release' },
        { op: 'logout' },
      ]);
    });

    it('skips a message with a missing internalDate (fail-closed: it cannot pass the C4 readyAt fence) and still returns its sibling', async () => {
      const log: LoggedCall[] = [];
      // internalDate deliberately omitted (not undefined-assigned) to
      // represent "missing" without violating exactOptionalPropertyTypes.
      const missingDate: FetchedMessage = {
        envelope: {
          messageId: '<no-date@example.com>',
          from: [{ address: 'sender@example.com' }],
          to: [{ address: 'bridge-user@example.com' }],
          cc: [],
        },
        headers: Buffer.from('Subject: No Date\r\n', 'utf-8'),
      };
      const valid = fetchedMessageFixture();
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 3 },
        search: [1, 2],
        fetch: new Map([
          [1, missingDate],
          [2, valid],
        ]),
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(result.map((mail) => mail.uid)).toEqual([2]);
    });

    it('skips a message with an unparseable internalDate string and still returns its sibling', async () => {
      const log: LoggedCall[] = [];
      const badDate = fetchedMessageFixture({ internalDate: 'not-a-real-date' });
      const valid = fetchedMessageFixture();
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 3 },
        search: [1, 2],
        fetch: new Map([
          [1, badDate],
          [2, valid],
        ]),
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(result.map((mail) => mail.uid)).toEqual([2]);
    });

    it('drops from entries missing a local-part or a host, keeping well-formed ones', async () => {
      const log: LoggedCall[] = [];
      const mail = fetchedMessageFixture({
        envelope: {
          messageId: '<addr-edge@example.com>',
          from: [
            { address: 'good@example.com' },
            { address: '@example.com' }, // missing local-part
            { address: 'nohost@' }, // missing host
            // more than one `@` (an RFC 5322 quoted local-part with a
            // literal `@` can reach ENVELOPE): violates identity.ts's
            // documented single-`@` caller contract → dropped
            { address: 'a@b@c.example' },
          ],
          to: [],
          cc: [],
        },
      });
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 2 },
        search: [1],
        fetch: new Map([[1, mail]]),
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(result[0]?.from).toEqual(['good@example.com']);
    });

    it('maps an absent messageId (key omitted) to null', async () => {
      const log: LoggedCall[] = [];
      const mail = fetchedMessageFixture({
        envelope: { from: [], to: [], cc: [] },
      });
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 2 },
        search: [1],
        fetch: new Map([[1, mail]]),
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(result[0]?.messageId).toBeNull();
    });

    it('maps an empty-string messageId to null (unusual non-NIL-but-empty token)', async () => {
      // Per imapflow 1.4.7's lib/tools.js#parseEnvelope (review-verified
      // against a NIL token): a genuinely absent Message-ID leaves
      // envelope.messageId undefined (the `entry[9] && entry[9].value`
      // guard skips the assignment) — that common case is the test above.
      // '' arises only from an unusual non-NIL-but-empty token; treating it
      // as "absent" too keeps both branches mapping to null instead of
      // letting messageId: '' through.
      const log: LoggedCall[] = [];
      const mail = fetchedMessageFixture({
        envelope: { messageId: '', from: [], to: [], cc: [] },
      });
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 2 },
        search: [1],
        fetch: new Map([[1, mail]]),
      });
      const transport = createImapReadTransport({ factory });

      const result = await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(result[0]?.messageId).toBeNull();
    });

    it('connects once per fetchSince call (no pooling, v0.1 connection policy): two calls issue two connects', async () => {
      const log: LoggedCall[] = [];
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 1 },
        search: [],
      });
      const transport = createImapReadTransport({ factory });

      await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);
      await transport.fetchSince(MAILBOX, UIDVALIDITY, 0);

      expect(log.filter((c) => c.op === 'connect')).toHaveLength(2);
    });
  });

  describe('send', () => {
    it('rejects with the explicit not-implemented message and never touches a client when send deps are not configured', async () => {
      const transport = createImapReadTransport({ factory: createExplodingFactory() });

      await expect(transport.send(outboundMailFixture())).rejects.toThrow(
        'ImapReadTransport: send not implemented — awaits red-line-3 confirmation (SMTP batch)',
      );
    });

    // D-P3B5-2 clause 1 (C3 order invariant, happy path).
    it('mints, registers, then submits — awaiting registerOutbox strictly before smtpSend, and resolves the exact receipt', async () => {
      const harness = createSendHarness();
      const mail = outboundMailFixture();

      const receipt = await harness.transport.send(mail);

      expect(receipt).toEqual({ outboxId: FIXED_OUTBOX_ID, messageId: FIXED_MESSAGE_ID });
      expect(harness.events).toEqual(['register', 'smtp']);
      expect(harness.registrations).toHaveLength(1);
      expect(harness.registrations[0]?.receipt).toEqual(receipt);
      expect(harness.registrations[0]?.mail).toBe(mail);
    });

    // D-P3B5-2 clause 1 (register failure: better not to send at all than
    // to send mail no outbox row remembers).
    it('rejects with the registerOutbox error and NEVER calls smtpSend when registration throws', async () => {
      const events: Array<'register' | 'smtp'> = [];
      const boom = new Error('registerOutbox exploded');
      const transport = createImapReadTransport({
        factory: createExplodingFactory(),
        send: {
          selfAddress: SELF_ADDRESS,
          smtpSend: async () => {
            events.push('smtp');
          },
          registerOutbox: async () => {
            events.push('register');
            throw boom;
          },
          mintOutboxId: () => FIXED_OUTBOX_ID,
        },
      });

      await expect(transport.send(outboundMailFixture())).rejects.toBe(boom);
      expect(events).toEqual(['register']);
    });

    // D-P3B5-2 clause 1, AWAIT semantics (review finding, batch-5 T1): the
    // other order tests use fakes that settle immediately, so they pin the
    // CALL order but could in principle be satisfied by an implementation
    // that starts registerOutbox without awaiting its settlement. Holding
    // the register promise PENDING and draining the task queue proves
    // smtpSend is never invoked until registration has actually resolved —
    // the difference matters exactly when the real store write is slow.
    it('never calls smtpSend while registerOutbox is still pending', async () => {
      let resolveRegister!: () => void;
      const gate = new Promise<void>((resolve) => {
        resolveRegister = resolve;
      });
      const events: Array<'register' | 'smtp'> = [];
      const transport = createImapReadTransport({
        factory: createExplodingFactory(),
        send: {
          selfAddress: SELF_ADDRESS,
          smtpSend: async () => {
            events.push('smtp');
          },
          registerOutbox: () => {
            events.push('register');
            return gate;
          },
          mintOutboxId: () => FIXED_OUTBOX_ID,
        },
      });

      const pending = transport.send(outboundMailFixture());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(['register']);
      resolveRegister();
      await pending;
      expect(events).toEqual(['register', 'smtp']);
    });

    // D-P3B5-2 clause 1 (smtp failure: the row is already registered; the
    // rejection propagates as-is and reconciliation is the daemon batch's
    // outbox UNCERTAIN path).
    it('rejects with the original smtpSend error while the outbox row is already registered', async () => {
      const events: Array<'register' | 'smtp'> = [];
      const registrations: Array<{ receipt: SendReceipt; mail: OutboundMail }> = [];
      const boom = new Error('smtp submission exploded');
      const transport = createImapReadTransport({
        factory: createExplodingFactory(),
        send: {
          selfAddress: SELF_ADDRESS,
          smtpSend: async () => {
            events.push('smtp');
            throw boom;
          },
          registerOutbox: async (receipt, mail) => {
            events.push('register');
            registrations.push({ receipt, mail });
          },
          mintOutboxId: () => FIXED_OUTBOX_ID,
        },
      });

      await expect(transport.send(outboundMailFixture())).rejects.toBe(boom);
      expect(events).toEqual(['register', 'smtp']);
      expect(registrations[0]?.receipt).toEqual({
        outboxId: FIXED_OUTBOX_ID,
        messageId: FIXED_MESSAGE_ID,
      });
    });

    // D-P3B5-2 clause 2 (C9): the recipient is mechanically locked, and the
    // submitted message has EXACTLY the six SmtpMessage keys — a future
    // cc/bcc/replyTo (or any other field) shows up in this sorted key list
    // and turns the test red before it can widen where mail might go.
    it('locks to === from === selfAddress and submits EXACTLY the six SmtpMessage keys', async () => {
      const harness = createSendHarness();

      await harness.transport.send(outboundMailFixture());

      const message = harness.smtpMessages[0];
      expect(message?.to).toBe(SELF_ADDRESS);
      expect(message?.from).toBe(SELF_ADDRESS);
      expect(Object.keys(message ?? {}).sort()).toEqual([
        'from',
        'headers',
        'messageId',
        'subject',
        'text',
        'to',
      ]);
    });

    // D-P3B5-2 clause 3 (loop markers): headers carry exactly the
    // X-AMB-Outbox-ID key, and the minted Message-ID is receipt-identical
    // on the RFC 2606 reserved domain.
    it('stamps headers as exactly {X-AMB-Outbox-ID: outboxId} and a receipt-identical @agent-mail-bridge.invalid Message-ID', async () => {
      const harness = createSendHarness();

      const receipt = await harness.transport.send(outboundMailFixture());

      const message = harness.smtpMessages[0];
      expect(Object.keys(message?.headers ?? {})).toEqual(['X-AMB-Outbox-ID']);
      expect(message?.headers['X-AMB-Outbox-ID']).toBe(FIXED_OUTBOX_ID);
      expect(message?.messageId).toBe(FIXED_MESSAGE_ID);
      expect(receipt.messageId).toBe(FIXED_MESSAGE_ID);
    });

    // D-P3B5-2 clause 4: transport adds no prefix/suffix — redaction is the
    // upstream producer's job, and what it produced goes out byte-for-byte.
    it('passes subjectRedacted/bodyRedacted through byte-for-byte, whitespace and all', async () => {
      const harness = createSendHarness();
      const mail: OutboundMail = {
        kind: 'RESULT',
        commandId: 7,
        subjectRedacted: '  Re: run finished  ',
        bodyRedacted: 'line one\r\n\tline two\nline three ',
      };

      await harness.transport.send(mail);

      expect(harness.smtpMessages[0]?.subject).toBe('  Re: run finished  ');
      expect(harness.smtpMessages[0]?.text).toBe('line one\r\n\tline two\nline three ');
    });

    // D-P3B5-1: mintOutboxId defaults to crypto.randomUUID.
    it('defaults mintOutboxId to crypto.randomUUID: two sends mint two distinct RFC 4122 ids', async () => {
      const transport = createImapReadTransport({
        factory: createExplodingFactory(),
        send: {
          selfAddress: SELF_ADDRESS,
          smtpSend: async () => {},
          registerOutbox: async () => {},
        },
      });

      const first = await transport.send(outboundMailFixture());
      const second = await transport.send(outboundMailFixture());

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(first.outboxId).toMatch(uuidPattern);
      expect(second.outboxId).toMatch(uuidPattern);
      expect(first.outboxId).not.toBe(second.outboxId);
      expect(first.messageId).toBe(`<amb-${first.outboxId}@agent-mail-bridge.invalid>`);
    });

    // D-P3B5-2 clause 5 (identity.ts blank-guard precedent): a blank
    // selfAddress must fail at CONSTRUCTION, never survive to send time.
    it('throws at construction when selfAddress is blank or all-whitespace', () => {
      for (const blank of ['', '   ', '\t\n']) {
        expect(() =>
          createImapReadTransport({
            factory: createExplodingFactory(),
            send: {
              selfAddress: blank,
              smtpSend: async () => {},
              registerOutbox: async () => {},
            },
          }),
        ).toThrow('ImapReadTransport: send.selfAddress must not be blank');
      }
    });
  });

  describe('markProcessed', () => {
    it('locks NOT read-only, flags the message \\Seen with exact args, then releases and logs out', async () => {
      const log: LoggedCall[] = [];
      const factory = createScriptedFactory(log, {
        mailbox: { uidValidity: UIDVALIDITY_BIGINT, uidNext: 1 },
      });
      const transport = createImapReadTransport({ factory });
      const mail = incomingMailFixture({ uid: 7 });

      await transport.markProcessed(mail);

      expect(log).toEqual([
        { op: 'connect' },
        { op: 'getMailboxLock', path: MAILBOX, readOnly: false },
        { op: 'messageFlagsAdd', uid: 7, flags: ['\\Seen'], uidOpt: true },
        { op: 'release' },
        { op: 'logout' },
      ]);
    });
  });

  describe('close', () => {
    it('resolves without making any client calls', async () => {
      const transport = createImapReadTransport({ factory: createExplodingFactory() });

      await expect(transport.close()).resolves.toBeUndefined();
    });
  });
});

describe('parseHeaderBlock (header parser, exported for direct unit testing)', () => {
  it('returns an empty map for an undefined buffer', () => {
    expect(parseHeaderBlock(undefined).size).toBe(0);
  });

  it('unfolds a CRLF+SP folded line', () => {
    const result = parseHeaderBlock(Buffer.from('Subject: Hello\r\n World\r\n', 'utf-8'));

    expect(result.get('subject')).toEqual(['Hello World']);
  });

  it('unfolds a bare-LF+SP folded line', () => {
    const result = parseHeaderBlock(Buffer.from('Subject: Hello\n World\n', 'utf-8'));

    expect(result.get('subject')).toEqual(['Hello World']);
  });

  it('drops a line with no colon', () => {
    const result = parseHeaderBlock(Buffer.from('Subject: Kept\r\nthis line is junk\r\n', 'utf-8'));

    expect(Array.from(result.keys())).toEqual(['subject']);
  });

  it('drops a line whose name is empty (colon with nothing before it)', () => {
    const result = parseHeaderBlock(Buffer.from(':leading-colon\r\nSubject: Kept\r\n', 'utf-8'));

    expect(Array.from(result.keys())).toEqual(['subject']);
  });

  it('lowercases header names', () => {
    const result = parseHeaderBlock(Buffer.from('X-Custom-HEADER: value\r\n', 'utf-8'));

    expect(result.get('x-custom-header')).toEqual(['value']);
    expect(result.has('X-Custom-HEADER')).toBe(false);
  });

  it('accumulates 3 same-name instances in occurrence order', () => {
    const result = parseHeaderBlock(
      Buffer.from('Received: first\r\nReceived: second\r\nReceived: third\r\n', 'utf-8'),
    );

    expect(result.get('received')).toEqual(['first', 'second', 'third']);
  });

  it('trims only the single leading space of the value, preserving further/internal whitespace', () => {
    const result = parseHeaderBlock(Buffer.from('X:   three leading spaces\r\n', 'utf-8'));

    expect(result.get('x')).toEqual(['  three leading spaces']);
  });
});
