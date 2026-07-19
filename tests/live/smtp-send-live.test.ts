/**
 * Live SEND verification for the SMTP half of `ImapReadTransport`
 * (decision D-P3B5-3,
 * docs/superpowers/plans/2026-07-19-phase-3-batch5-smtp-send.md).
 *
 * THIS FILE SENDS ONE REAL MAIL PER RUN — the only test in the whole suite
 * that sends at all. The action stays inside the class red line 3 already
 * approved ("方案 A", 2026-07-19, first exercised by
 * spikes/p0-1-imap/send-observe.ts): authenticated SMTP from the dedicated
 * test mailbox TO ITSELF. No other recipient is mechanically reachable —
 * `send` hardwires `to === from === selfAddress` and `OutboundMail` carries
 * no recipient field at all (C9, unit-pinned by the six-key set-equality
 * test in tests/unit/imap-read-transport.test.ts). The verification mail is
 * deliberately LEFT in the mailbox afterwards: no `markProcessed`, no
 * deletion — one self-addressed probe with a fixed non-sensitive body is
 * harmless residue, and any post-send mutation would only widen this
 * file's blast radius beyond the single approved action.
 *
 * THREE gate conditions, ALL required before anything here runs:
 *   1. `process.env.AMB_LIVE_TEST === '1'` — the live-mailbox opt-in
 *      established by batch 2 (tests/live/imap-read-live.test.ts, whose
 *      header carries the full argument for env-var gating instead of
 *      file-presence gating);
 *   2. `process.env.AMB_LIVE_SEND === '1'` — the SEND-specific opt-in, new
 *      in this batch;
 *   3. `loadLiveCreds()` resolves real credentials from its DEFAULT path
 *      (`~/.secrets/amb-test.env`).
 *
 * WHY gate 2 exists on top of batch 2's gates: `AMB_LIVE_TEST=1` has had a
 * fixed meaning since batch 2 — "run the READ-ONLY live pass" — and
 * operators, completion records and review instructions already rely on
 * that exact invocation never mutating anything. Were this file keyed on
 * `AMB_LIVE_TEST` alone, the identical habitual command would have
 * silently started SENDING mail the day this file landed. `AMB_LIVE_SEND=1`
 * makes the escalation from "read a real mailbox" to "emit a real message"
 * its own explicit, single-purpose act:
 *
 *   AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 pnpm exec vitest run tests/live/smtp-send-live.test.ts
 *
 * (`AMB_LIVE_SEND=1` alone skips too — the read-side variable stays the
 * outer opt-in for touching the live mailbox at all.) A bare `pnpm test`
 * sets neither, so this suite always reports "skipped" there; per the
 * plan, the live execution itself is performed by the MAIN session, never
 * by the file-authoring subagent.
 *
 * COLLECTION-TIME CAVEAT (inherited from batch 2 — see that file's
 * IMPLEMENTATION NOTE for the empirical verification): `describe.skipIf`'s
 * factory body ALWAYS executes during test collection, even for a suite
 * that ends up fully skipped, so `creds` is only ever DEREFERENCED inside
 * hook/test callbacks — never at the factory's top level, where a throw
 * would turn a clean skip into a failed suite on every machine without
 * live creds.
 *
 * SCRUB BEFORE COMMIT (batch-2 failure-output rule): the happy path below
 * prints only counts, durations, protocol metadata and SELF-MINTED
 * identifiers (outboxId, `...@agent-mail-bridge.invalid` Message-IDs) — no
 * real address ever appears in an assertion's printable operands. But an
 * UNEXPECTED live failure — an SMTP rejection surfacing through
 * `transport.send`, an imapflow error mid-poll — propagates the raw
 * nodemailer/imapflow/server error through vitest's reporter, which can
 * embed the real mailbox address. That is accepted here for debuggability,
 * with the same compensating rule as batch 2: raw failure output from this
 * file MUST be scrubbed before it is pasted into any committed record or
 * public text (AGENTS.md red line 2).
 *
 * BASELINE-PROBE EXCEPTION (why raw imapflow appears in `beforeAll`): the
 * poll below needs a pre-send uid watermark so every `fetchSince` call
 * covers a bounded slice (P0-1 measured ~15k messages in this mailbox —
 * polling from uid 1 is unacceptable), and it needs the mailbox's current
 * UIDVALIDITY to call `fetchSince` at all. `fetchSince` can report
 * neither — by design it only ever returns already-mapped
 * `IncomingMail[]` — and batch 2's error-channel discovery trick (feed a
 * wrong uidValidity, read the real one off `UidValidityChangedError.actual`)
 * yields no uidNext either. So `beforeAll` opens ONE raw imapflow
 * connection (read-only `mailboxOpen`, then logout — same shape as batch
 * 2's discovery connect and the spike's baseline read) to capture
 * `uidValidity` + `uidNext`. That is the ONLY raw-client use in this file;
 * everything after it goes through the transport under test.
 *
 * CONNECTION BUDGET: 1 raw baseline connect (`beforeAll`) + 1 SMTP
 * submission + up to ~12 polling `fetchSince` connects (each an
 * independent connect/logout, ~2.5s per connect measured in P0-1; 5s poll
 * interval sized against ADR-0002's measured 15–30s send→INBOX visibility,
 * docs/adr/0002-p0-1-gmail-imap-smtp-go.md).
 */
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildDefaultSmtpSend,
  buildImapflowFactory,
  createImapReadTransport,
} from '../../src/transports/imapRead.js';
import type {
  IncomingMail,
  MailTransport,
  OutboundMail,
  SendReceipt,
} from '../../src/transports/types.js';
import { loadLiveCreds } from '../helpers/liveCreds.js';

const HOST = 'imap.gmail.com';
const PORT = 993;
const MAILBOX = 'INBOX';

/** `beforeAll` budget: one raw baseline connect (~2.5s measured in P0-1)
 *  plus generous TLS/auth slack — same value batch 2 uses per hook. */
const SETUP_TIMEOUT_MS = 60_000;
/** Main-test budget: SMTP submission + the full polling window below + one
 *  final in-flight `fetchSince` + assertions. */
const SEND_TEST_TIMEOUT_MS = 120_000;
/** ADR-0002 measured 15–30s typical send→INBOX visibility. The spike could
 *  poll its standing connection's EXISTS events every 500ms; here every
 *  probe is a full ~2.5s+ connect/logout cycle (v0.1 `fetchSince`
 *  connection policy), so 5s spacing keeps the connect count bounded while
 *  still resolving well inside the deadline. */
const POLL_INTERVAL_MS = 5_000;
/** Matches the spike's visibility deadline: past 90s the mail is treated as
 *  not delivered rather than polled forever. */
const POLL_DEADLINE_MS = 90_000;
/**
 * Slack subtracted from the local send instant to form the INTERNALDATE
 * lower bound. INTERNALDATE is assigned by Gmail's server clock at delivery
 * (RFC 3501 §2.3.3) but compared against THIS machine's clock — a strict
 * `>= local send instant` bound would flake whenever the local clock runs
 * even slightly ahead of the server's. Newness does not rest on this
 * assertion anyway (the uid fence below already proves arrival after the
 * baseline probe), so a generous 60s skew allowance costs nothing and the
 * assertion stays a meaningful "recent, sane instant" cross-check of the
 * transport's internalDate mapping.
 */
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;

/** Fixed-format UTC instant (`YYYY-MM-DDTHH:mm:ss.sssZ`) — what both
 *  `Date#toISOString` and the transport's `resolveInternalDate` (itself a
 *  `toISOString` call) produce. Equal-length, zero-padded, single-timezone
 *  strings are what make the plain lexicographic `>=` comparison below
 *  chronologically correct. */
const ISO_INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** BOTH send-path gates — see the file header for why the second exists. */
const liveEnabled = process.env.AMB_LIVE_TEST === '1' && process.env.AMB_LIVE_SEND === '1';
// Module scope, DEFAULT (real) path — one of the exactly two live suites
// allowed to resolve it (the other: tests/live/imap-read-live.test.ts).
// Gated behind `liveEnabled` so a plain `pnpm test` never even READS the
// real secrets path, not merely never uses it.
const creds = liveEnabled ? loadLiveCreds() : null;

describe.skipIf(!liveEnabled || creds === null)('smtp send path (live, one self-send)', () => {
  let transport: MailTransport;
  let baselineUidValidity: string;
  let baselineUidNext: number;
  /** Everything the in-memory `registerOutbox` fake captured, in call
   *  order. The real outbox store is out of scope here (daemon batch wires
   *  it); this test only needs proof that the receipt handed to
   *  `registerOutbox` is the same one `send` resolves with. */
  const registrations: Array<{ receipt: SendReceipt; mail: OutboundMail }> = [];

  beforeAll(async () => {
    // Unreachable in practice (`describe.skipIf` already excludes
    // `creds === null` from ever reaching a RUNNING `beforeAll`), but the
    // null-narrowing throw is only safe HERE, inside the callback — see the
    // file header's collection-time caveat.
    if (creds === null) {
      throw new Error(
        'unreachable: beforeAll only runs when describe.skipIf(!liveEnabled || creds === null) is false',
      );
    }

    // Baseline probe — the file's single allowed raw-client use (see the
    // BASELINE-PROBE EXCEPTION in the header for the full rationale).
    const baselineClient = new ImapFlow({
      host: HOST,
      port: PORT,
      secure: true,
      auth: { user: creds.user, pass: creds.pass },
      // AGENTS.md red line 2 — never omit `logger: false`. imapflow's
      // default logger prints the raw protocol stream (addresses,
      // subjects) to stdout/stderr.
      logger: false,
    });
    await baselineClient.connect();
    try {
      const mailboxStatus = await baselineClient.mailboxOpen(MAILBOX, { readOnly: true });
      baselineUidValidity = String(mailboxStatus.uidValidity);
      baselineUidNext = mailboxStatus.uidNext;
    } finally {
      await baselineClient.logout();
    }

    transport = createImapReadTransport({
      // Production read-side factory — the SAME wiring batch 2 verified
      // live; reused here so the read-back half of this test exercises the
      // exact production read path, not a bespoke poller.
      factory: buildImapflowFactory({ host: HOST, port: PORT, user: creds.user, pass: creds.pass }),
      send: {
        selfAddress: creds.user,
        // The production SMTP wiring under test — nodemailer over
        // smtp.gmail.com:465, deliberately NOT unit-tested (see its doc
        // comment in src/transports/imapRead.ts): this file is its only
        // executable verification.
        smtpSend: buildDefaultSmtpSend({ user: creds.user, pass: creds.pass }),
        registerOutbox: async (receipt, mail) => {
          registrations.push({ receipt, mail });
        },
        // `mintOutboxId` omitted DELIBERATELY: the live pass exercises the
        // production default (crypto.randomUUID), unlike the unit tests'
        // injected fixed id.
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // Guarded like batch 2: if `beforeAll` failed before the assignment, a
    // bare `transport.close()` would throw a TypeError that MASKS the real
    // beforeAll failure in vitest's output.
    if (transport !== undefined) {
      await transport.close();
    }
  });

  it(
    'sends one self-addressed mail through the real SMTP path and reads it back via fetchSince with the C3 markers intact',
    async () => {
      // Captured BEFORE the send — see CLOCK_SKEW_ALLOWANCE_MS's doc
      // comment for why the bound is deliberately loose. Not the forbidden
      // zero-arg `new Date()`: converting an explicitly-provided epoch
      // value, same stance as `resolveInternalDate`.
      const sentAtFloorIso = new Date(Date.now() - CLOCK_SKEW_ALLOWANCE_MS).toISOString();

      // Fixed, low-entropy, non-sensitive literals — this exact subject is
      // what a human sees in the test mailbox when auditing what the suite
      // sent. subject/text pass through `send` byte-for-byte (D-P3B5-2
      // clause 4), so this is also literally what goes on the wire.
      const outbound: OutboundMail = {
        kind: 'ACK',
        commandId: null,
        subjectRedacted: 'AMB live send verification',
        bodyRedacted: 'AMB live send verification probe. No sensitive content.',
      };

      const receipt = await transport.send(outbound);

      // Receipt/registration consistency: the row registered before the
      // SMTP submission carries the very receipt `send` resolved with.
      // (Both operands are self-minted ids — safe for vitest to print on a
      // mismatch.) The ORDER half of C3 (register strictly before submit)
      // is unit-pinned via an event log and not re-observable here.
      expect(registrations.length).toBe(1);
      expect(registrations[0]?.receipt).toEqual(receipt);

      // Poll the production read path until our message lands. sinceUid is
      // `baselineUidNext - 1`, NOT `baselineUidNext`: the sent message will
      // be assigned some uid >= baselineUidNext, and `fetchSince` keeps
      // only uids STRICTLY greater than sinceUid — passing baselineUidNext
      // itself would miss the common case where the mail gets exactly that
      // uid. Before delivery, Gmail's n:* range-inversion quirk (P0-1) may
      // echo the mailbox's last real uid (<= baselineUidNext - 1 ===
      // sinceUid) — `filterNewUids` inside fetchSince drops it, so the
      // pre-delivery polls cleanly return []. The mailbox is live and
      // shared: concurrent unrelated arrivals may appear in any poll's
      // result, so the sent mail is located by Message-ID equality and no
      // count is ever asserted on.
      const pollDeadlineMs = Date.now() + POLL_DEADLINE_MS;
      let found: IncomingMail | undefined;
      for (;;) {
        const fetched = await transport.fetchSince(
          MAILBOX,
          baselineUidValidity,
          baselineUidNext - 1,
        );
        found = fetched.find((mail) => mail.messageId === receipt.messageId);
        if (found !== undefined || Date.now() >= pollDeadlineMs) {
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      if (found === undefined) {
        throw new Error(
          'sent mail did not become visible through fetchSince within the polling deadline ' +
            '(ADR-0002 measured 15-30s typical send->INBOX latency; deadline 90s)',
        );
      }

      // C3 loop-prevention marker round trip, read EXACTLY the way the
      // ingest echo gate reads it (src/application/ingest.ts): lowercased
      // name, FIRST instance. Also implicitly covers nodemailer's on-wire
      // header-casing normalization (`X-Amb-Outbox-ID`) being neutralized
      // by the read side's lowercasing. Both operands are self-minted —
      // printable on failure.
      expect(found.headers.get('x-amb-outbox-id')?.[0]).toBe(receipt.outboxId);

      // Message-ID round trip, byte-identical end to end (ADR-0002's
      // preservation evidence, now via the production transport). The find
      // predicate above already located the mail by this equality; the
      // explicit assertion is the recorded proof.
      expect(found.messageId).toBe(receipt.messageId);

      // uid fence sanity: the live server honored the `sinceUid + 1:*`
      // range — the found mail really is from AFTER the baseline probe.
      expect(found.uid).toBeGreaterThanOrEqual(baselineUidNext);

      // INTERNALDATE lower bound (lexicographic — valid because both sides
      // match the fixed-length UTC shape asserted first; see
      // ISO_INSTANT_SHAPE's doc comment). Boolean-style comparison keeps
      // the failure output to true/false; internalDate itself is protocol
      // metadata and safe to print, which the shape assertion may do.
      expect(found.internalDate).toMatch(ISO_INSTANT_SHAPE);
      expect(found.internalDate >= sentAtFloorIso).toBe(true);
    },
    SEND_TEST_TIMEOUT_MS,
  );
});
