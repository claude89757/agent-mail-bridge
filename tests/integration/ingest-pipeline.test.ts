import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIngest } from '../../src/application/ingest.js';
import type { IngestConfig, IngestResult } from '../../src/application/ingest.js';
import { buildRegisterOutbox } from '../../src/daemon/replySender.js';
import { filterNewUids } from '../../src/domain/uid.js';
import { openDatabase } from '../../src/store/database.js';
import { CommandStore } from '../../src/store/commandStore.js';
import { IntentStore } from '../../src/store/intentStore.js';
import { MetaStore } from '../../src/store/metaStore.js';
import { OutboxStore } from '../../src/store/outboxStore.js';
import type { IncomingMail, SendReceipt } from '../../src/transports/types.js';
import { FakeMailTransport, FAKE_MAILBOX, FAKE_UID_VALIDITY } from '../helpers/fakeTransport.js';

// Guards the Phase 2 exit criteria (docs/superpowers/plans/2026-07-17-phase-2-event-core.md,
// Task 9): "under simulated IMAP, duplicate delivery / reordering produce no
// duplicate commands; self-sent system replies are recognized as echo 100%."
// Drives the FULL fake-transport -> ingest -> stores pipeline end to end —
// unlike tests/unit/ingest.test.ts, which calls ingestMail directly against
// hand-built IncomingMail values, this file goes through the same
// deliver/fetchSince/filterNewUids chokepoints a real daemon poll loop would.
//
// Placeholder addresses only (public-repo rule) — mirrors the SELF/attacker
// convention used across tests/unit/domain-identity.test.ts and
// tests/unit/ingest.test.ts.
const SELF = 'bridge-user@example.com';
const ATTACKER = 'attacker@example.net';
const READY_AT = '2026-07-17T00:00:00.000Z';
const AFTER_READY = '2026-07-17T00:00:01.000Z';
const BEFORE_READY = '2026-07-16T23:59:59.000Z';
const NOW = new Date('2026-07-17T00:00:05.000Z');

type Db = ReturnType<typeof openDatabase>;

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
 * Deterministic LCG (Numerical Recipes constants: a=1664525, c=1013904223,
 * m=2^32). NO Math.random, NO Date.now anywhere in this file — every shuffle
 * below is exactly reproducible across runs, which is the point of Task 9's
 * "deterministic seeded shuffle" requirement.
 */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Deterministic Fisher-Yates using the caller-supplied `rng` (from
 * `makeLcg`). Never mutates `items`; returns a new shuffled array. Indexed
 * reads are defensively checked (never actually undefined here — both `i`
 * and `j` stay within bounds by construction) to satisfy
 * `noUncheckedIndexedAccess`.
 */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = result[i];
    const b = result[j];
    if (a === undefined || b === undefined) {
      throw new Error('shuffle: index out of bounds (unreachable)');
    }
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/** Valid self-to-self mail, internalDate safely after READY_AT, delivered to
 *  the fake's fixed mailbox/uidValidity. `uid` is required (not defaulted):
 *  every mail in this file must carry an explicit, deliberately-chosen uid
 *  so tests control collision/ordering precisely. */
function buildMail(overrides: Partial<IncomingMail> & { uid: number }): IncomingMail {
  return {
    messageId: '<placeholder@example.com>',
    headers: new Map(),
    from: [SELF],
    to: [SELF],
    cc: [],
    bodyText: null,
    internalDate: AFTER_READY,
    uidValidity: FAKE_UID_VALIDITY,
    mailbox: FAKE_MAILBOX,
    ...overrides,
  };
}

interface Harness {
  db: Db;
  commandStore: CommandStore;
  intentStore: IntentStore;
  outboxStore: OutboxStore;
  metaStore: MetaStore;
  transport: FakeMailTransport;
  ingest: (mail: IncomingMail, now: Date) => IngestResult;
}

/**
 * Fresh in-memory store set + fake transport, wired together the way a real
 * daemon would wire them: the transport's `registerOutbox` callback is the
 * PRODUCTION `buildRegisterOutbox` (src/daemon/replySender.ts) — the same
 * create-then-SENDING registration (over the normalized Message-ID) the real
 * daemon performs before any SMTP submission — using the same store the echo
 * gate reads from, so `reflectOutbound`/hand-built echo mail are recognized
 * exactly as production code would recognize a real self-reply.
 * `readyAt` is preset (`setReadyAtIfUnset`) so mail is not rejected
 * NO_READY_AT by default.
 */
function setup(config: Partial<IngestConfig> = {}): Harness {
  const db = openDatabase(':memory:');
  openDbs.push(db);

  const commandStore = new CommandStore(db);
  const intentStore = new IntentStore(db);
  const outboxStore = new OutboxStore(db);
  const metaStore = new MetaStore(db);
  metaStore.setReadyAtIfUnset(READY_AT);

  const fullConfig: IngestConfig = { selfAddress: SELF, dryRun: false, ...config };
  const ingest = createIngest({ db, commandStore, intentStore, outboxStore, metaStore, config: fullConfig });

  const transport = new FakeMailTransport({
    registerOutbox: buildRegisterOutbox({ db, outboxStore, clock: () => AFTER_READY }),
  });

  return { db, commandStore, intentStore, outboxStore, metaStore, transport, ingest };
}

/**
 * Daemon-style read path (mirrors what a real poll loop does, per the Task 9
 * note): read the persisted watermark, fetch everything since it, then run
 * the result through `filterNewUids` — the single chokepoint that
 * neutralizes the P0-1 `UID SEARCH n:*` range-inversion quirk — before
 * treating any of it as new mail. Duplicates are deliberately NOT collapsed
 * here: that is `commandStore.insertIfAbsent`'s job inside `ingestMail`, not
 * the transport's or this helper's.
 */
async function pollNew(harness: Harness): Promise<IncomingMail[]> {
  const watermark = harness.metaStore.getWatermark(FAKE_MAILBOX, FAKE_UID_VALIDITY);
  const fetched = await harness.transport.fetchSince(FAKE_MAILBOX, FAKE_UID_VALIDITY, watermark);
  const newUids = new Set(filterNewUids(fetched.map((mail) => mail.uid), watermark));
  return fetched.filter((mail) => newUids.has(mail.uid));
}

function countRows(db: Db, table: 'commands' | 'dispatch_intents' | 'outbox'): number {
  const row = db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

function countCommandsByStatus(db: Db, status: string): number {
  const row = db
    .prepare<[string], { count: number }>(`SELECT COUNT(*) AS count FROM commands WHERE status = ?`)
    .get(status);
  return row?.count ?? 0;
}

describe('ingest pipeline integration (Phase 2 Task 9)', () => {
  describe('duplicates + reorder', () => {
    it('50 valid mails delivered 3x each in a deterministic shuffled order collapse to exactly 50 commands and 50 intents; watermark reaches the max uid', async () => {
      const harness = setup();
      const MAIL_COUNT = 50;
      const DUPLICATE_FACTOR = 3;

      const uniqueMails = Array.from({ length: MAIL_COUNT }, (_, index) => {
        const uid = index + 1;
        return buildMail({ uid, messageId: `<dup-${uid}@example.com>` });
      });
      // Duplicating a mail 3x = deliver the SAME mail object three times, per
      // fakeTransport.ts's isSameLogicalMail (reference-equal short-circuit)
      // — this stays legal under the uid-collision guard regardless of
      // shuffle order.
      const deliveries = shuffle(
        uniqueMails.flatMap((mail) => [mail, mail, mail]),
        makeLcg(20260717),
      );
      expect(deliveries).toHaveLength(MAIL_COUNT * DUPLICATE_FACTOR);

      for (const mail of deliveries) {
        harness.transport.deliver(mail);
      }

      const toIngest = await pollNew(harness);
      expect(toIngest).toHaveLength(MAIL_COUNT * DUPLICATE_FACTOR);

      const results = toIngest.map((mail) => harness.ingest(mail, NOW));

      const readyCount = results.filter((result) => result.outcome === 'ready').length;
      const duplicateCount = results.filter((result) => result.outcome === 'duplicate').length;
      expect(readyCount).toBe(MAIL_COUNT);
      expect(duplicateCount).toBe(MAIL_COUNT * (DUPLICATE_FACTOR - 1));

      expect(countRows(harness.db, 'commands')).toBe(MAIL_COUNT);
      expect(harness.intentStore.countAll()).toBe(MAIL_COUNT);
      expect(new Set(results.map((result) => result.commandId)).size).toBe(MAIL_COUNT);

      expect(harness.metaStore.getWatermark(FAKE_MAILBOX, FAKE_UID_VALIDITY)).toBe(MAIL_COUNT);
    });
  });

  describe('100% echo classification (MVP loop guard)', () => {
    it('reflecting all 20 sent replies back classifies exactly 20/20 as echo with 0 new intents', async () => {
      const harness = setup();
      const REPLY_COUNT = 20;

      const receipts: SendReceipt[] = [];
      for (let i = 0; i < REPLY_COUNT; i += 1) {
        const receipt = await harness.transport.send({
          kind: 'ACK',
          commandId: null,
          subjectRedacted: '[redacted]',
          bodyRedacted: '[redacted]',
        });
        receipts.push(receipt);
      }

      for (const receipt of receipts) {
        harness.transport.reflectOutbound(receipt);
      }

      const toIngest = await pollNew(harness);
      expect(toIngest).toHaveLength(REPLY_COUNT);

      const results = toIngest.map((mail) => harness.ingest(mail, NOW));

      const echoCount = results.filter((result) => result.outcome === 'echo').length;
      expect(echoCount).toBe(REPLY_COUNT);
      expect(harness.intentStore.countAll()).toBe(0);
      expect(countCommandsByStatus(harness.db, 'SYSTEM_ECHO')).toBe(REPLY_COUNT);
    });
  });

  describe('mixed stream: valid + echo + forged-identity + pre-readyAt', () => {
    it('ingesting one shuffled batch produces exactly the outcome counts constructed', async () => {
      const harness = setup();
      const VALID_COUNT = 10;
      const ECHO_COUNT = 6;
      const FORGED_COUNT = 5;
      const PRE_READY_COUNT = 4;

      let uidSeq = 0;
      const nextUid = (): number => {
        uidSeq += 1;
        return uidSeq;
      };

      const validMails = Array.from({ length: VALID_COUNT }, () => {
        const uid = nextUid();
        return buildMail({ uid, messageId: `<valid-${uid}@example.com>` });
      });

      const echoMails: IncomingMail[] = [];
      for (let i = 0; i < ECHO_COUNT; i += 1) {
        const receipt = await harness.transport.send({
          kind: 'ACK',
          commandId: null,
          subjectRedacted: '[redacted]',
          bodyRedacted: '[redacted]',
        });
        const uid = nextUid();
        echoMails.push(
          buildMail({
            uid,
            messageId: receipt.messageId,
            headers: new Map([['x-amb-outbox-id', [receipt.outboxId]]]),
            from: [],
            to: [],
            cc: [],
          }),
        );
      }

      const forgedMails = Array.from({ length: FORGED_COUNT }, () => {
        const uid = nextUid();
        return buildMail({ uid, messageId: `<forged-${uid}@example.com>`, from: [ATTACKER] });
      });

      const preReadyMails = Array.from({ length: PRE_READY_COUNT }, () => {
        const uid = nextUid();
        return buildMail({
          uid,
          messageId: `<early-${uid}@example.com>`,
          internalDate: BEFORE_READY,
        });
      });

      const batch = shuffle(
        [...validMails, ...echoMails, ...forgedMails, ...preReadyMails],
        makeLcg(19700101),
      );
      for (const mail of batch) {
        harness.transport.deliver(mail);
      }

      const toIngest = await pollNew(harness);
      expect(toIngest).toHaveLength(VALID_COUNT + ECHO_COUNT + FORGED_COUNT + PRE_READY_COUNT);

      const results = toIngest.map((mail) => harness.ingest(mail, NOW));

      const byOutcome = (outcome: IngestResult['outcome']): number =>
        results.filter((result) => result.outcome === outcome).length;
      const byReason = (reason: string): number =>
        results.filter((result) => result.reason === reason).length;

      expect(byOutcome('ready')).toBe(VALID_COUNT);
      expect(byOutcome('echo')).toBe(ECHO_COUNT);
      expect(byOutcome('rejected')).toBe(FORGED_COUNT + PRE_READY_COUNT);
      expect(byOutcome('duplicate')).toBe(0);
      expect(byOutcome('queued-window')).toBe(0);

      expect(byReason('IDENTITY_FROM')).toBe(FORGED_COUNT);
      expect(byReason('BEFORE_READY')).toBe(PRE_READY_COUNT);

      expect(harness.intentStore.countAll()).toBe(VALID_COUNT);
    });
  });

  // Directly cashes the MVP acceptance criterion "forged From ⇒ 0 trigger"
  // (the DKIM half; the echo half is the loop-guard test above). This forged
  // case is the one C1 alone CANNOT catch: from==to==self, so it sails through
  // the identity gate — but it carries an MX-stamped Authentication-Results
  // header, which only external mail traversing the inbound auth pipeline ever
  // has (ADR-0003 evidence). The inverted-polarity AUTH factor quarantines it
  // on PRESENCE alone, end to end through the same deliver/fetchSince/
  // filterNewUids/ingest chokepoints a real daemon poll loop uses.
  describe('forged From==To==self carrying Authentication-Results (MVP: forged From ⇒ 0 trigger)', () => {
    it('quarantines it as rejected AUTH_RESULTS_PRESENT with 0 intents, end to end', async () => {
      const harness = setup();

      // from/to default to SELF in buildMail, so this passes C1. The AR header
      // (a failing/misaligned verdict — the typical forger shape, since an
      // external sender cannot obtain a valid self-domain DKIM signature) is
      // what betrays external origin. Header key is lowercase per the
      // IncomingMail contract (imapRead lowercases every header name).
      const forged = buildMail({
        uid: 1,
        messageId: '<forged-self-ar-1@example.com>',
        headers: new Map([
          [
            'authentication-results',
            [
              'mx.google.com; dkim=fail header.d=example.net; ' +
                'spf=softfail; dmarc=fail header.from=example.com',
            ],
          ],
        ]),
      });
      harness.transport.deliver(forged);

      const toIngest = await pollNew(harness);
      expect(toIngest).toHaveLength(1);

      const results = toIngest.map((mail) => harness.ingest(mail, NOW));
      const [result] = results;

      expect(result?.outcome).toBe('rejected');
      expect(result?.reason).toBe('AUTH_RESULTS_PRESENT');
      expect(harness.intentStore.countAll()).toBe(0);
      expect(countCommandsByStatus(harness.db, 'REJECTED')).toBe(1);
    });
  });
});
