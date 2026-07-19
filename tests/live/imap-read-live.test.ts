/**
 * Live, read-only integration test for `ImapReadTransport` (decision
 * D-P3B2-4,
 * docs/superpowers/plans/2026-07-19-phase-3-batch2-imap-read-path.md).
 *
 * This is the ONLY test file in the suite that ever opens a real network
 * connection to a real mailbox. Everything below is READ-ONLY against the
 * dedicated test mailbox (AGENTS.md red line 1): every `fetchSince` call
 * opens its mailbox lock `readOnly: true` (enforced inside
 * `src/transports/imapRead.ts`, not re-verified here), and `markProcessed`/
 * `send` are never called from this file at all — the plan's explicit
 * zero-mutation ruling for this batch (`markProcessed`'s live verification
 * is deferred to the daemon batch; `send` awaits red-line-3 confirmation and
 * is not implemented yet — it throws by design).
 *
 * TWO SAFETY GATES, both required (belt and suspenders):
 *   1. `loadLiveCreds()` (`tests/helpers/liveCreds.ts`) must resolve real
 *      credentials from `~/.secrets/amb-test.env` (its DEFAULT path — only
 *      the live suites, this file and `tests/live/smtp-send-live.test.ts`,
 *      may call it with no injected `baseDir`).
 *   2. `process.env.AMB_LIVE_TEST` must be exactly `'1'`.
 *
 * WHY gate 2 exists on top of gate 1: `loadLiveCreds()`'s default path is
 * the REAL path on every machine that runs this suite, including whichever
 * machine authors or reviews this file — a credentials file dropped there by
 * an unrelated task (the P0-1 spike, `amb setup`, a developer's own local
 * testing, ...) would otherwise make this describe block fire a real network
 * connection the INSTANT anyone ran a bare `pnpm test`, with no way for the
 * test file itself to distinguish "an operator deliberately wants the live
 * pass" from "this machine happens to have a stray file". Gate 2 makes
 * opting into a real connection and a real mailbox read an explicit,
 * single-purpose act:
 *
 *   AMB_LIVE_TEST=1 pnpm exec vitest run tests/live/imap-read-live.test.ts
 *
 * instead of an ambient side effect of file presence. A bare `pnpm test` —
 * by any developer, by CI, by this task's own author running the suite —
 * NEVER sets this variable, so this describe block always reports "skipped"
 * there; verified and the output captured in this batch's completion
 * record.
 *
 * IMPLEMENTATION NOTE on where each gate's null-check lives: `creds` is read
 * at MODULE scope (below), inside `describe.skipIf`'s factory function,
 * which Vitest always executes during test collection — EVEN for a suite
 * that ends up fully skipped (verified empirically while designing this
 * file: a `describe.skipIf(...)` factory body runs unconditionally so
 * Vitest can enumerate and report every child test as "skipped"; only
 * nested `beforeAll`/`it` CALLBACK bodies are the parts that do not run when
 * skipped). That is exactly why every place below that actually
 * DEREFERENCES `creds.user`/`creds.pass` is nested inside `beforeAll`'s own
 * callback, never at the `describe` factory's top level: a null-check that
 * THROWS at the factory's top level would abort test collection itself and
 * turn a clean skip into a failed suite on every machine without live creds
 * — the exact opposite of this file's purpose.
 *
 * CONNECTION BUDGET (v0.1 has no pooling — every `fetchSince` call and the
 * one discovery probe below are each an independent connect/logout, see
 * `src/transports/imapRead.ts`'s module doc comment; P0-1 measured ~2.5s per
 * connect against this same mailbox): 1 discovery connect (`beforeAll`) + 1
 * connect per test (4 tests) = 5 connects total, comfortably inside the
 * generous per-hook/per-test timeout set below.
 */
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UidValidityChangedError } from '../../src/transports/errors.js';
import { buildImapflowFactory, createImapReadTransport } from '../../src/transports/imapRead.js';
import type { MailTransport } from '../../src/transports/types.js';
import { loadLiveCreds } from '../helpers/liveCreds.js';

const HOST = 'imap.gmail.com';
const PORT = 993;
const MAILBOX = 'INBOX';
const TEST_TIMEOUT_MS = 60_000;

/** Shape-only pattern for an addr-spec (`local@domain`), no display name —
 *  matches `IncomingMail.from`/`.to`/`.cc`'s documented mapping rule
 *  (D-P3B2-3). Used with `.test()` rather than vitest's `.toMatch()` — see
 *  the leak-avoidance note on Test 3 below. */
const ADDR_SPEC_LIKE = /^[^@\s]+@[^@\s]+$/;

/** Shape-only pattern for `error.actual` / `realUidValidity`: a nonempty run
 *  of ASCII digits. Not personal data (IMAP mailbox metadata, comparable in
 *  sensitivity to a message count) — safe to let vitest print the actual
 *  value on a mismatch, unlike `from`/`to`/`messageId` below. */
const DIGITS_ONLY = /^[0-9]+$/;

const liveEnabled = process.env.AMB_LIVE_TEST === '1';
// Module scope, DEFAULT (real) path — see the "IMPLEMENTATION NOTE" above.
// Gated behind `liveEnabled` so a plain `pnpm test` (CI, any dev machine)
// never even READS the real secrets path, not merely never uses it. Never
// resolve the default path outside the live suites (this file and
// tests/live/smtp-send-live.test.ts): every other caller of
// `loadLiveCreds` injects a temp-dir `baseDir`
// (see tests/unit/live-creds.test.ts).
const creds = liveEnabled ? loadLiveCreds() : null;

describe.skipIf(!liveEnabled || creds === null)('imap read path (live, read-only)', () => {
  let transport: MailTransport;
  let uidNext: number;
  let realUidValidity: string;

  beforeAll(async () => {
    // `creds` is `LiveCreds | null` at the type level (module scope,
    // above); this branch is unreachable in practice because
    // `describe.skipIf` already excludes `creds === null` from ever
    // reaching a RUNNING `beforeAll` — but it is only safe to encode that
    // as a throw HERE, inside the callback (see the file header's
    // "IMPLEMENTATION NOTE"). Narrows `creds` to non-null for the rest of
    // this function.
    if (creds === null) {
      throw new Error(
        'unreachable: beforeAll only runs when describe.skipIf(!liveEnabled || creds === null) is false',
      );
    }

    transport = createImapReadTransport({
      factory: buildImapflowFactory({ host: HOST, port: PORT, user: creds.user, pass: creds.pass }),
    });

    // Test-harness-only discovery (NOT transport-path duplication,
    // D-P3B2-4): `fetchSince` has no way to report `uidNext` on its own —
    // by design it only ever returns already-mapped `IncomingMail[]` — and
    // Test 3 below needs `uidNext` to choose a `sinceUid` that yields a
    // small, bounded slice of real mail rather than the whole mailbox (P0-1
    // measured ~15k messages in this test mailbox; fetching all of it is
    // unacceptable). This is the ONLY place in the whole test suite that
    // talks to imapflow directly outside `src/transports/**`: one connect,
    // one read-only `mailboxOpen`, one logout. It issues no `search`/
    // `fetch` call, so it duplicates zero transport behavior.
    const discoveryClient = new ImapFlow({
      host: HOST,
      port: PORT,
      secure: true,
      auth: { user: creds.user, pass: creds.pass },
      // AGENTS.md red line 2 — never omit `logger: false`. imapflow's
      // default logger prints the raw protocol stream (addresses,
      // subjects) to stdout/stderr.
      logger: false,
    });
    await discoveryClient.connect();
    try {
      const mailboxStatus = await discoveryClient.mailboxOpen(MAILBOX, { readOnly: true });
      uidNext = mailboxStatus.uidNext;
    } finally {
      await discoveryClient.logout();
    }
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    // `ImapReadTransport#close` is a documented no-op in v0.1 (no standing
    // connection to release — see imapRead.ts's module doc comment); called
    // anyway so this file exercises the full real MailTransport surface a
    // caller would use, and stays correct automatically if that ever
    // changes. Guarded: if `beforeAll` failed before the assignment, a bare
    // `transport.close()` would throw a TypeError that MASKS the real
    // beforeAll failure in vitest's output.
    if (transport !== undefined) {
      await transport.close();
    }
  });

  // TEST ORDER IS LOAD-BEARING: tests 2 and 3 both depend on
  // `realUidValidity` (and test 3 also on `uidNext`), captured as a side
  // effect of test 1 / `beforeAll`. Vitest runs tests within one `describe`
  // sequentially in declaration order by default (nothing in this file
  // opts into `concurrent`), so this dependency chain is safe as written —
  // but these three tests cannot be reordered, run individually via
  // `.only`, or parallelized without breaking. That constraint is
  // deliberate: it holds the live-connection budget to the minimum (module
  // doc comment above) instead of adding a second bespoke UIDVALIDITY probe
  // purely to decouple the tests — discovering it through the transport's
  // own fail-closed error channel (Test 1) is the whole point of this
  // design (D-P3B2-4).

  it(
    'test 1: a deliberately wrong uidValidity fails closed and reports the real one via error.actual',
    async () => {
      let caught: unknown;
      try {
        await transport.fetchSince(MAILBOX, '0', 0);
      } catch (error) {
        caught = error;
      }

      // LEAK-AVOIDANCE on the FAILURE path (review finding): when the throw
      // is NOT the expected UidValidityChangedError (e.g. a stale app
      // password → a server auth error), an `expect(caught).toBeInstanceOf`
      // failure would let vitest print the raw error — whose message is
      // authored by imapflow/the IMAP server and can embed the real mailbox
      // address. Sanitize to the constructor name BEFORE any assertion can
      // print it; deliberately no `{ cause }` either (vitest prints cause
      // chains too).
      if (!(caught instanceof UidValidityChangedError)) {
        const name =
          caught === undefined
            ? 'no error thrown at all'
            : caught instanceof Error
              ? caught.constructor.name
              : typeof caught;
        throw new Error(`expected UidValidityChangedError, got: ${name}`);
      }
      realUidValidity = caught.actual;

      // Shape only (nonempty digit string) — this IS the live discovery of
      // the mailbox's real UIDVALIDITY, so there is no separately-known
      // expected value to compare against.
      expect(realUidValidity).toMatch(DIGITS_ONLY);
    },
    TEST_TIMEOUT_MS,
  );

  // FAILURE-OUTPUT WARNING (review finding): tests 2 and 3 call
  // `fetchSince` UNguarded — an unexpected live failure there surfaces the
  // raw imapflow/server error through vitest's reporter, which may embed
  // the real mailbox address. That is accepted here for debuggability
  // (unlike test 1, whose failure mode is a DESIGNED wrong-type check),
  // with this compensating rule: raw failure output from this file must be
  // scrubbed before it is pasted into any committed record or public text
  // (AGENTS.md red line 2). Happy-path output contains only counts and
  // durations.
  it(
    'test 2: an absurdly high sinceUid returns [] end-to-end (P0-1 n:* range-inversion quirk, live)',
    async () => {
      // 999_999_999 is far above any real uidNext this mailbox will ever
      // reach. Per the P0-1-measured RFC 3501 quirk, `search({ uid:
      // '1000000000:*' })` against Gmail answers with the mailbox's last
      // real uid instead of an empty result; `filterNewUids` (reused inside
      // fetchSince, never reimplemented — D-P3B2-3) drops that single
      // echoed uid because it is not `> sinceUid`. This exercises that
      // whole path against the real server, not a fake.
      const result = await transport.fetchSince(MAILBOX, realUidValidity, 999_999_999);

      expect(result).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'test 3: a small real slice maps every field to the documented shape',
    async () => {
      const sinceUid = Math.max(0, uidNext - 6);

      const result = await transport.fetchSince(MAILBOX, realUidValidity, sinceUid);

      // 0..5 messages depending on the mailbox's real recent contents,
      // which this test does not control and never asserts a count on.
      for (const mail of result) {
        // internalDate/uid/uidValidity/header-names are protocol metadata,
        // not personal data — vitest may print the actual value on a
        // mismatch (acceptable, see the module header's leak-avoidance
        // scope).
        expect(mail.internalDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(mail.uid).toBeGreaterThan(sinceUid);
        expect(mail.uidValidity).toBe(realUidValidity);
        for (const key of mail.headers.keys()) {
          expect(key).toBe(key.toLowerCase());
        }

        // LEAK-AVOIDANCE (AGENTS.md red line 2): `from`/`to`/`cc` entries
        // are real mailbox addresses. `expect(value).toMatch(pattern)`
        // would print the actual failing address in the assertion failure
        // message; wrapping the regex test in a boolean and asserting
        // `.toBe(true)` prints only `true`/`false` on failure, never the
        // address itself. Extended defensively to `messageId` below too,
        // even though it is closer to protocol metadata than to a mailbox
        // address (it can embed a sending host/domain fragment).
        for (const address of mail.from) {
          expect(ADDR_SPEC_LIKE.test(address)).toBe(true);
        }
        for (const address of mail.to) {
          expect(ADDR_SPEC_LIKE.test(address)).toBe(true);
        }
        for (const address of mail.cc) {
          expect(ADDR_SPEC_LIKE.test(address)).toBe(true);
        }

        expect(mail.messageId === null || typeof mail.messageId === 'string').toBe(true);
        if (mail.messageId !== null) {
          expect(mail.messageId.length).toBeGreaterThan(0);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Same test-order dependency as tests 2/3 (realUidValidity from test 1,
  // uidNext from beforeAll) — see the TEST ORDER IS LOAD-BEARING note above.
  it(
    'test 4: bodyText on a small real slice is decoded — booleans/lengths only, NEVER the content (red line 2)',
    async () => {
      const sinceUid = Math.max(0, uidNext - 6);

      const result = await transport.fetchSince(MAILBOX, realUidValidity, sinceUid);

      // LEAK-AVOIDANCE (AGENTS.md red line 2, stricter here than anywhere
      // else in this file): a real message body can embed real local paths,
      // addresses, or task text. EVERY assertion below therefore compares
      // only booleans and lengths — `expect(bool).toBe(true)` prints
      // `true`/`false` on failure, never a fragment of the body itself. Do
      // not "improve" any of these into toMatch/toContain on `bodyText`.
      for (const mail of result) {
        expect(mail.bodyText === null || typeof mail.bodyText === 'string').toBe(true);
      }

      // Unlike test 3, this test REQUIRES a non-empty slice: its whole
      // purpose is live evidence that the source→parseMime path decodes a
      // real message, and an empty slice would prove nothing. The dedicated
      // test mailbox is append-only in practice (~15k messages, P0-1), so
      // an empty recent slice is itself a signal worth failing on. The two
      // asserts are split so a failure names which fact broke — still only
      // ever printing true/false.
      expect(result.length > 0).toBe(true);

      // A recent slice decoding NOTHING would mean the source→parseMime
      // path is broken (e.g. `source: true` never requested): the mailbox's
      // recent probe mail (P0-1/batch-6) all carries real text bodies.
      const decodedOne = result.some(
        (mail) => typeof mail.bodyText === 'string' && mail.bodyText.length > 0,
      );
      expect(decodedOne).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
