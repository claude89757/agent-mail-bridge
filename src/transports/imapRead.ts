/**
 * Real IMAP read transport (D-P3B2-2/D-P3B2-3): the first production
 * implementation of the `MailTransport` seam (`./types.ts`), built on
 * imapflow 1.4.7. Grounded in the P0-1 spike's measured facts
 * (`spikes/p0-1-imap/observe.ts`) and in imapflow 1.4.7's actual source
 * (`node_modules/imapflow/lib/tools.js`, `lib/commands/fetch.js` — read
 * directly while implementing this module, not assumed from its `.d.ts`
 * alone; specific findings are cited inline below).
 *
 * LAYERING (D-P3B2-5): this file, inside `src/transports/**`, is the ONLY
 * place in the source tree allowed to import `imapflow`. `domain/`,
 * `application/`, and `store/` never see it, directly or transitively —
 * they only ever see the `MailTransport` seam.
 *
 * `send` is NOT implemented here (fails loud, see below): live send
 * verification awaits red-line-3 confirmation and belongs to a future SMTP
 * batch. IDLE/long-lived connections belong to the daemon batch. Both are
 * out of scope per the plan's explicit exclusions.
 */
import { ImapFlow } from 'imapflow';

import { filterNewUids } from '../domain/uid.js';
import { UidValidityChangedError } from './errors.js';
import type { IncomingMail, MailTransport, SendReceipt } from './types.js';

/* ------------------------------------------------------------------ */
/* ImapClientLike surface (D-P3B2-2)                                   */
/* ------------------------------------------------------------------ */

/**
 * One parsed address entry from imapflow's ENVELOPE. `address` is ALREADY
 * imapflow's joined `mailbox@host` addr-spec string, not a separate
 * mailbox/host pair: verified against imapflow 1.4.7's
 * `lib/tools.js#parseEnvelope`, whose `processAddresses` builds each entry
 * as `address = (mailbox || '') + '@' + (host || '')` (collapsing to `''`
 * only when BOTH parts are empty) — there is no lower-level shape this
 * module could read mailbox/host from separately. This is a DELTA from the
 * plan sketch, which described the mapping rule in terms of the classic
 * IMAP4 `(name adl mailbox host)` ENVELOPE tuple; imapflow's own
 * already-parsed `MessageAddressObject` only exposes the joined string, so
 * "entries lacking mailbox or host" (the plan's mapping rule) is
 * operationalized in `addressesToAddrSpecs` below as validating the joined
 * string has a non-empty substring on both sides of its first `@` — see
 * that function's doc comment for why this check is NOT redundant with
 * imapflow's own (looser) filtering.
 */
export interface ImapAddressLike {
  name?: string;
  address?: string;
}

/** Minimal projection of imapflow's `MessageEnvelopeObject` — only the
 *  fields this module reads. */
export interface ImapEnvelopeLike {
  messageId?: string;
  from?: ImapAddressLike[];
  to?: ImapAddressLike[];
  cc?: ImapAddressLike[];
}

/**
 * Minimal projection of imapflow's `FetchMessageObject`, scoped to exactly
 * the query this module issues (`{ envelope: true, internalDate: true,
 * headers: true }` — see `fetchOne` below). Deliberately excludes `uid`
 * (present on the real type): `fetchSince` already knows the uid it asked
 * for from its own search-result loop and uses that value directly rather
 * than trusting an echoed-back field, so this projection never needs to
 * carry one.
 */
export interface FetchedMessage {
  envelope?: ImapEnvelopeLike;
  /** `Date` when imapflow parsed INTERNALDATE successfully, or the raw
   *  string when it could not (verified against imapflow 1.4.7's
   *  `lib/tools.js#formatMessageResponse`: it tries `new Date(value)`
   *  itself and only keeps the original string on `Invalid Date`) — either
   *  shape is handled uniformly by `resolveInternalDate` below. */
  internalDate?: Date | string;
  /** Raw header block for the whole message (imapflow's `BODY[HEADER]`
   *  fetch response), unparsed. */
  headers?: Buffer;
}

export interface ImapClientFactory {
  /** Returns an already-connected client. Called once per `fetchSince` /
   *  `markProcessed` invocation (v0.1 connection policy, below) — never
   *  cached or reused by this module itself. */
  connect(): Promise<ImapClientLike>;
}

/**
 * The minimal projection of imapflow's `ImapFlow` surface this transport
 * actually calls (D-P3B2-2). `getMailboxLock`'s `opts` and `search`/
 * `fetchOne`/`messageFlagsAdd`'s `opts` are written here as the EXACT
 * literal shape every call site in this module always passes (e.g.
 * `{ uid: true }`, never `{ uid: false }` or omitted) — narrower than
 * imapflow's own much wider `MailboxLockOptions`/`StoreOptions` (which also
 * allow `description`, `acquireTimeout`, `changedSince`, ...), because none
 * of that extra surface is ever touched here. A real `ImapFlow` instance
 * satisfies this narrower interface structurally (TypeScript checks that at
 * `buildImapflowFactory`'s `return client` below): if a future imapflow
 * version narrows a member this module relies on, that line stops
 * compiling.
 */
export interface ImapClientLike {
  getMailboxLock(path: string, opts: { readOnly: boolean }): Promise<{ release(): void }>;
  mailbox: { uidValidity: bigint; uidNext: number } | false;
  search(query: { uid: string }, opts: { uid: true }): Promise<number[] | false>;
  fetchOne(
    uid: string | number,
    query: { envelope: true; internalDate: true; headers: true },
    opts: { uid: true },
  ): Promise<FetchedMessage | false>;
  messageFlagsAdd(uid: string | number, flags: string[], opts: { uid: true }): Promise<boolean>;
  logout(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Header block parsing (D-P3B2-3 mapping rule: headers)               */
/* ------------------------------------------------------------------ */

/** Step 1 of {@link parseHeaderBlock}: splits `text` into logical
 *  (unfolded) lines, tolerating both CRLF and bare-LF line endings. RFC
 *  5322 S:2.2.3 unfolding removes only the line-terminator that precedes a
 *  WSP-prefixed continuation line, NOT the WSP itself — appending a
 *  continuation physical line verbatim (its own leading SP/HTAB included)
 *  directly onto the previous logical line reproduces that byte-for-byte. */
function unfoldHeaderLines(text: string): string[] {
  const logicalLines: string[] = [];
  let current: string | null = null;
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const lf = text.indexOf('\n', pos);
    const lineEndsAt = lf === -1 ? len : lf;
    const hasCr = lineEndsAt > pos && text.charAt(lineEndsAt - 1) === '\r';
    const contentEnd = hasCr ? lineEndsAt - 1 : lineEndsAt;
    const physicalLine = text.slice(pos, contentEnd);

    const firstChar = physicalLine.charAt(0);
    const isContinuation = current !== null && (firstChar === ' ' || firstChar === '\t');

    if (isContinuation) {
      current = current + physicalLine;
    } else {
      if (current !== null) {
        logicalLines.push(current);
      }
      current = physicalLine;
    }

    pos = lf === -1 ? len : lf + 1;
  }

  if (current !== null) {
    logicalLines.push(current);
  }

  return logicalLines;
}

/**
 * Parses a raw RFC 5322 header block (imapflow's `BODY[HEADER]` fetch,
 * already a UTF-8-decodable Buffer) into the multi-value map
 * `IncomingMail.headers` requires (D-P3B2-1). Exported for direct unit
 * testing (`tests/unit/imap-read-transport.test.ts`) — production callers
 * go through `createImapReadTransport`'s `fetchSince`; this mirrors the
 * `applyMigrations` precedent in `src/store/database.ts` ("exported for
 * tests ... production callers should go through X").
 *
 * SECURITY (same ReDoS posture as `src/domain/authResults.ts`): this parses
 * attacker-influenced bytes — anyone who can get mail delivered to the
 * watched mailbox controls every header they send — so the whole pass is
 * manual `indexOf`/`charAt` scanning; no regex appears anywhere in this
 * function.
 *
 * Algorithm (two linear passes over the input, never throws):
 * 1. {@link unfoldHeaderLines} unfolds RFC 5322 folded lines.
 * 2. For each logical line, split at the FIRST `:` (`indexOf`). No colon,
 *    or an empty/all-whitespace name before it, drops the line silently —
 *    malformed input is tolerated, never thrown, matching the module's
 *    ReDoS-adjacent parsing precedent. The name is trimmed then lowercased.
 *    The value has AT MOST ONE leading space character removed — the
 *    conventional single separator space after `Name:` — deliberately NOT
 *    a general `.trim()`: this is a narrow, literal reading of "leading
 *    space only" (singular): further leading whitespace (extra spaces, or
 *    any leading HTAB), and ALL trailing/internal whitespace (including the
 *    single space a folded continuation leaves behind, per step 1), are
 *    preserved exactly as sent. Same-name lines accumulate into one array
 *    in occurrence order.
 */
export function parseHeaderBlock(
  buffer: Buffer | undefined,
): ReadonlyMap<string, readonly string[]> {
  const headers = new Map<string, string[]>();
  if (buffer === undefined) {
    return headers;
  }

  const logicalLines = unfoldHeaderLines(buffer.toString('utf-8'));

  for (const line of logicalLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      continue;
    }
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    if (name.length === 0) {
      continue;
    }
    const rawValue = line.slice(colonIdx + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    const existing = headers.get(name);
    if (existing === undefined) {
      headers.set(name, [value]);
    } else {
      existing.push(value);
    }
  }

  return headers;
}

/* ------------------------------------------------------------------ */
/* Envelope -> IncomingMail mapping (D-P3B2-3 mapping rules)            */
/* ------------------------------------------------------------------ */

/**
 * Converts one imapflow ENVELOPE address list into addr-spec strings,
 * discarding display names. `undefined`/empty input maps to `[]`.
 *
 * Validates each entry's already-joined `address` has a non-empty
 * substring on BOTH sides of its first `@` before trusting it (the plan's
 * "entries lacking mailbox or host -> skipped" mapping rule). This check is
 * NOT redundant with imapflow's own filtering: reading imapflow 1.4.7's
 * `processAddresses` (`lib/tools.js`) shows it only drops an entry when
 * BOTH the mailbox and host parts are empty (`'@'` collapses to `''`) — an
 * entry with just ONE side missing survives imapflow's own filter as
 * `'local@'` or `'@domain'` and would reach here unless this function
 * catches it. This is the trust boundary documented on `ImapAddressLike`:
 * envelope is the IMAP server's already-parsed product, trusted for
 * STRUCTURE (no RFC 5322 re-parsing), but this one shape invariant
 * (non-empty local-part AND non-empty domain) is verified rather than
 * assumed, because imapflow demonstrably does not guarantee it itself.
 */
function addressesToAddrSpecs(list: readonly ImapAddressLike[] | undefined): string[] {
  if (list === undefined) {
    return [];
  }

  const result: string[] = [];
  for (const entry of list) {
    const address = entry.address;
    if (address === undefined) {
      continue;
    }
    const at = address.indexOf('@');
    if (at <= 0 || at === address.length - 1) {
      continue;
    }
    result.push(address);
  }
  return result;
}

/**
 * Converts imapflow's `internalDate` (already a `Date`, or the raw string
 * imapflow itself failed to parse — see `FetchedMessage.internalDate`'s
 * doc comment) into the ISO-8601 shape `IncomingMail.internalDate`
 * requires, or `null` when no valid instant can be produced.
 *
 * Uses a single `new Date(value)` call regardless of whether `value` is
 * already a `Date` or a `string`, rather than branching on `instanceof
 * Date` to call `.toISOString()` directly on an existing Date: per the
 * ECMA-262 `Date` constructor, `new Date(existingDate)` copies that date's
 * exact time value, so `new Date(existingDate).toISOString() ===
 * existingDate.toISOString()` whenever `existingDate` is valid, and an
 * already-invalid input produces an invalid result either way — the two
 * approaches are provably equivalent, and the uniform call is simpler. This
 * is still squarely a "converting a PROVIDED value" call, never the
 * forbidden zero-arg `new Date()`.
 *
 * DELIBERATE FAIL-CLOSED JUDGMENT CALL (flagged for review): a message
 * whose INTERNALDATE cannot be parsed as a valid date is SKIPPED entirely
 * by the caller (this function returns `null`; `mapFetchedMessage` returns
 * `null` in turn; `fetchSince` drops it from the result array) — it is
 * NEVER included with a fabricated or missing `internalDate`. Why this
 * matters: `internalDate` is the exact field the C4 readyAt fence (spec's
 * first-install guard, applied via lexicographic string comparison in
 * `src/application/ingest.ts`) compares against. A message with no
 * parseable date cannot be fenced at all, so:
 *   - including it unfenced would be FAIL-OPEN — a message the fence exists
 *     to block could sail through unfiltered;
 *   - skipping it is FAIL-CLOSED — the bridge loses that one message rather
 *     than risk processing something the security fence was there to stop.
 * Given the fence is a security control, fail-closed is the deliberately
 * chosen default here, even though it means a message with a broken date
 * silently never reaches the pipeline. This is a real, non-obvious
 * tradeoff (an alternative design could report/count skipped messages
 * through some future observability channel) called out loudly per this
 * project's fail-closed convention (see also `src/domain/authResults.ts`,
 * `src/domain/uid.ts`) and flagged here for reviewer scrutiny.
 */
function resolveInternalDate(value: Date | string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

/**
 * Maps one already-fetched `FetchedMessage` (never the `false` "expunged"
 * case — the caller filters that out first) into `IncomingMail`, or `null`
 * when the message cannot be safely fenced (see `resolveInternalDate`'s
 * doc comment) — a `null` result is dropped by the caller, never surfaced
 * as a thrown error.
 *
 * `messageId`: imapflow 1.4.7's `lib/tools.js#parseEnvelope` always assigns
 * a STRING to `envelope.messageId` (verified in source), using `''` — never
 * `undefined` — to represent "the raw ENVELOPE field was absent". Both
 * `undefined` (defensive, in case a future imapflow version differs) and
 * `''` are therefore treated as "absent" here and mapped to `null`; the
 * value is otherwise passed through completely as-is (angle brackets kept,
 * no normalization) per the plan's mapping rule.
 */
function mapFetchedMessage(
  fetched: FetchedMessage,
  uid: number,
  mailbox: string,
  uidValidity: string,
): IncomingMail | null {
  const internalDate = resolveInternalDate(fetched.internalDate);
  if (internalDate === null) {
    return null;
  }

  const envelope = fetched.envelope;
  const rawMessageId = envelope?.messageId;
  const messageId = rawMessageId !== undefined && rawMessageId !== '' ? rawMessageId : null;

  return {
    messageId,
    headers: parseHeaderBlock(fetched.headers),
    from: addressesToAddrSpecs(envelope?.from),
    to: addressesToAddrSpecs(envelope?.to),
    cc: addressesToAddrSpecs(envelope?.cc),
    internalDate,
    uid,
    uidValidity,
    mailbox,
  };
}

/* ------------------------------------------------------------------ */
/* MailTransport implementation                                        */
/* ------------------------------------------------------------------ */

/**
 * Builds the real IMAP read `MailTransport` (D-P3B2-2/D-P3B2-3).
 *
 * v0.1 connection policy (deliberate, doc'd per the plan): every
 * `fetchSince`/`markProcessed` call is its own independent
 * connect -> lock -> work -> release -> logout, with NO pooling or reused
 * long-lived connection. IDLE/persistent connections are the daemon
 * batch's concern; P0-1 measured connect latency at roughly 2.5s, which is
 * acceptable for a correctness-first v0.1. `close()` is consequently a
 * no-op (see below) — there is never a standing connection for it to tear
 * down.
 */
export function createImapReadTransport(opts: { factory: ImapClientFactory }): MailTransport {
  const { factory } = opts;

  return {
    async fetchSince(
      mailbox: string,
      uidValidity: string,
      sinceUid: number,
    ): Promise<IncomingMail[]> {
      const client = await factory.connect();
      // Read path always opens read-only (D-P3B2-3 step 1) — this
      // transport never mutates mailbox state via fetchSince.
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        // UIDVALIDITY guard, FAIL CLOSED (D-P3B2-3 step 2). A bounded
        // rescan on mismatch is application-layer policy (spec S:3.2) —
        // this transport only ever reports the mismatch, never improvises
        // a recovery.
        if (client.mailbox === false) {
          throw new Error(
            `ImapReadTransport: mailbox "${mailbox}" reports no state after getMailboxLock ` +
              '(client.mailbox === false)',
          );
        }
        const actualUidValidity = String(client.mailbox.uidValidity);
        if (actualUidValidity !== uidValidity) {
          throw new UidValidityChangedError({ expected: uidValidity, actual: actualUidValidity });
        }

        // D-P3B2-3 step 3: `n:*` where n = sinceUid + 1. RFC 3501's search
        // range-inversion quirk (P0-1 measured: this can return the OLD
        // watermark uid itself even when nothing is new) is neutralized by
        // reusing `filterNewUids` — never reimplemented here.
        const searchResult = await client.search({ uid: `${sinceUid + 1}:*` }, { uid: true });
        const candidateUids = searchResult === false ? [] : searchResult;
        const newUids = filterNewUids(candidateUids, sinceUid);

        const mails: IncomingMail[] = [];
        for (const uid of newUids) {
          // D-P3B2-3 step 4: a `false` fetchOne means the message was
          // expunged in the race between search and fetch. Skip, don't
          // throw — at-least-once semantics mean the next fetchSince round
          // simply won't see this uid either (it's gone).
          const fetched = await client.fetchOne(
            uid,
            { envelope: true, internalDate: true, headers: true },
            { uid: true },
          );
          if (fetched === false) {
            continue;
          }
          const mapped = mapFetchedMessage(fetched, uid, mailbox, uidValidity);
          if (mapped !== null) {
            mails.push(mapped);
          }
        }

        // D-P3B2-3 step 5: ascending uid order — search/fetch order is
        // never trusted as already sorted.
        mails.sort((a, b) => a.uid - b.uid);
        return mails;
      } finally {
        lock.release();
        await client.logout();
      }
    },

    // Fails LOUD, never silent (D-P3B2-2): this is a read transport: `send`
    // awaits red-line-3 confirmation before any SMTP work begins. Declared
    // with no parameter (rather than an unused `mail: OutboundMail`) —
    // TypeScript's standard "a function may declare fewer parameters than
    // the interface it implements" leniency covers this, and it avoids an
    // unused-variable lint violation for a parameter this stub can never
    // use. `async` (not a bare `throw`) is required so the throw becomes a
    // proper Promise rejection rather than a synchronous throw at the call
    // site — every other MailTransport method only ever fails via
    // rejection, never a synchronous throw, and callers rely on that.
    async send(): Promise<SendReceipt> {
      throw new Error(
        'ImapReadTransport: send not implemented — awaits red-line-3 confirmation (SMTP batch)',
      );
    },

    async markProcessed(mail: IncomingMail): Promise<void> {
      const client = await factory.connect();
      // NOT read-only: setting \Seen is a write, so it needs write access
      // to the mailbox — the one deliberate asymmetry with fetchSince's
      // always-read-only lock.
      const lock = await client.getMailboxLock(mail.mailbox, { readOnly: false });
      try {
        // Idempotent by ordinary IMAP semantics: adding a flag a message
        // already has is a no-op on the server.
        await client.messageFlagsAdd(mail.uid, ['\\Seen'], { uid: true });
      } finally {
        lock.release();
        await client.logout();
      }
    },

    // v0.1 has no standing connection to release: every operation above
    // self-manages its own connect/logout pair. A future pooled/IDLE
    // transport (daemon batch) would give this a real body.
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/**
 * Builds an `ImapClientFactory` that talks to a real IMAP server via
 * imapflow.
 *
 * `logger: false` is RED LINE 2 (AGENTS.md security red lines): imapflow's
 * default logger prints the raw protocol stream, which includes message
 * addresses and other mailbox content, to stdout/stderr — never acceptable
 * output for this bridge. This is a hard requirement, not a verbosity
 * preference; do not remove it "just to see what's happening" while
 * debugging a connection issue.
 */
export function buildImapflowFactory(opts: {
  host: string;
  port: number;
  user: string;
  pass: string;
}): ImapClientFactory {
  return {
    async connect(): Promise<ImapClientLike> {
      const client = new ImapFlow({
        host: opts.host,
        port: opts.port,
        secure: true,
        auth: { user: opts.user, pass: opts.pass },
        logger: false,
      });
      await client.connect();
      return client;
    },
  };
}
