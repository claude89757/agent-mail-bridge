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
 * place in the source tree allowed to import `imapflow` — and, since the
 * batch-5 send half, `nodemailer`, and, since the batch-10 body path,
 * `mailparser` (`buildDefaultParseMime` below is the single import point;
 * supply-chain note: mailparser is the same author ecosystem as nodemailer,
 * batch-5 precedent, version pinned via the pnpm lockfile). `domain/`,
 * `application/`, and `store/` never see any of them, directly or
 * transitively — they only ever see the `MailTransport` seam.
 *
 * `send` (D-P3B5-1/2): real SMTP submission via the optional send deps
 * (`ImapReadTransportSendDeps` below; production wiring is
 * `buildDefaultSmtpSend`, nodemailer over Gmail implicit-TLS 465, per
 * ADR-0002's measured send half). A transport constructed WITHOUT send deps
 * — every read-only construction — keeps the exact pre-batch loud failure.
 * IDLE/long-lived connections and outbox retry/reconciliation belong to the
 * daemon batch, out of scope per the plan's explicit exclusions.
 */
import { randomUUID } from 'node:crypto';

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

import { filterNewUids } from '../domain/uid.js';
import { UidValidityChangedError } from './errors.js';
import type { IncomingMail, MailTransport, OutboundMail, SendReceipt } from './types.js';

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
 * headers: true, source: true }` — see `fetchOne` below). Deliberately
 * excludes `uid` (present on the real type): `fetchSince` already knows the
 * uid it asked for from its own search-result loop and uses that value
 * directly rather than trusting an echoed-back field, so this projection
 * never needs to carry one.
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
  /** Full raw message source (imapflow's `BODY[]` fetch response when the
   *  query passes `source: true`), unparsed — the ParseMime seam's input
   *  (D-P4B10-1). Absent when the server never produced one; that maps to
   *  `bodyText: null` (see `resolveBodyText` below). */
  source?: Buffer;
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
    query: { envelope: true; internalDate: true; headers: true; source: true },
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
  // Buffer.isBuffer, not `!== undefined`: imapflow's internal getBuffer
  // helper can structurally return `false` for a NIL token, which the
  // published types don't admit — guard by runtime shape instead of the
  // type-level promise.
  if (!Buffer.isBuffer(buffer)) {
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
/* MIME parsing seam (D-P4B10-1)                                       */
/* ------------------------------------------------------------------ */

/**
 * The MIME-parsing injection seam (D-P4B10-1), same shape family as
 * `SmtpSend` above and the codex driver's `SpawnCodex`: production is
 * `buildDefaultParseMime`'s mailparser wrapper, tests inject scripted
 * fakes. Takes the full raw message source and yields the decoded
 * plain-text body — `text: null` when the message simply has no text part.
 * A REJECTION from this function is tolerated by the caller
 * (`resolveBodyText` maps it to `bodyText: null`, fail open), so a fake
 * that throws is a legitimate test fixture, not a contract violation.
 */
export type ParseMime = (source: Uint8Array) => Promise<{ text: string | null }>;

/**
 * Production `ParseMime` (D-P4B10-1): wraps mailparser's `simpleParser`,
 * the SINGLE mailparser import point in the source tree (module doc
 * comment's layering note). `parsed.text` is mailparser's default body
 * resolution — the text/plain part when one exists, else its html-to-text
 * rendering — which is exactly the plan-locked "text/plain preferred"
 * semantics; a message with no text part at all leaves `parsed.text`
 * undefined, mapped here to `null`. An empty-string body stays `''`
 * (verbatim): "empty body" and "no body" are different facts, and the
 * downstream consumer (`extractCommand`'s prompt fallback) treats both as
 * absent anyway via its own trim.
 */
export function buildDefaultParseMime(): ParseMime {
  return async (source: Uint8Array): Promise<{ text: string | null }> => {
    const parsed = await simpleParser(Buffer.isBuffer(source) ? source : Buffer.from(source));
    return { text: typeof parsed.text === 'string' ? parsed.text : null };
  };
}

/**
 * Resolves one fetched message's `bodyText`, FAIL OPEN to `null` on every
 * failure mode (D-P4B10-1): a missing `source` (the fetch never produced
 * one) and a `parseMime` rejection alike yield `bodyText: null` for THAT
 * mail while the rest of the fetch batch proceeds untouched.
 *
 * DELIBERATE ASYMMETRY with `resolveInternalDate`'s fail-CLOSED skip
 * (below): `internalDate` is what the C4 readyAt security fence compares
 * against, so a message without it cannot be fenced at all and must be
 * dropped. The body carries no security decision — it is enhancement
 * information (the eventual command prompt), while headers/uid are the
 * pipeline's skeleton — and a mail whose body cannot be read still must
 * flow through the echo/identity/window gates and be recorded, so "no
 * body" is representable (`null`) instead of fatal, and one broken MIME
 * tree cannot poison the whole batch.
 *
 * `Buffer.isBuffer`, not `!== undefined`: same runtime-shape guard as
 * `parseHeaderBlock` above — imapflow's internal getBuffer helper can
 * structurally return `false` for a NIL token, which the published types
 * don't admit.
 */
async function resolveBodyText(
  source: Buffer | undefined,
  parseMime: ParseMime,
): Promise<string | null> {
  if (!Buffer.isBuffer(source)) {
    return null;
  }
  try {
    const { text } = await parseMime(source);
    return text;
  } catch {
    return null;
  }
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
    // Exactly ONE `@` — `identity.ts` documents "real addr-specs handed to
    // this module never contain more than one `@` (that is the caller's
    // parser's job to guarantee)", and this transport IS that caller's
    // parser. An RFC 5322 quoted local-part can legally contain a literal
    // `@`; a server that copies it into ENVELOPE would otherwise smuggle a
    // multi-`@` string here. Dropped, fail closed.
    if (address.lastIndexOf('@') !== at) {
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
 * tradeoff — reporting/counting skipped messages needs an observability
 * channel the locked `MailTransport` API does not have; the DAEMON batch
 * owns that story (review adjudication: INTERNALDATE is server-assigned at
 * delivery time, RFC 3501 §2.3.3, so an external sender has no lever to
 * weaponize this skip into targeted mail loss). Called out loudly per this
 * project's fail-closed convention (see also `src/domain/authResults.ts`,
 * `src/domain/uid.ts`).
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
 * `messageId`: per imapflow 1.4.7's `lib/tools.js#parseEnvelope`
 * (review-verified against a NIL token), a genuinely absent Message-ID
 * leaves `envelope.messageId` `undefined` — the assignment is skipped by
 * the `entry[9] && entry[9].value` guard — so `undefined` is the COMMON
 * absent case, while `''` arises only from an unusual non-NIL-but-empty
 * token. Both are treated as "absent" here and mapped to `null`; the value
 * is otherwise passed through completely as-is (angle brackets kept, no
 * normalization) per the plan's mapping rule.
 */
function mapFetchedMessage(
  fetched: FetchedMessage,
  uid: number,
  mailbox: string,
  uidValidity: string,
  bodyText: string | null,
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
    bodyText,
    internalDate,
    uid,
    uidValidity,
    mailbox,
  };
}

/* ------------------------------------------------------------------ */
/* SMTP send surface (D-P3B5-1)                                        */
/* ------------------------------------------------------------------ */

/**
 * The minimal SMTP submission surface `send` needs (D-P3B5-1): production
 * is `buildDefaultSmtpSend`'s nodemailer wrapper at the bottom of this
 * file; unit tests inject a capturing fake and never open a network
 * connection.
 *
 * EXACTLY these six keys, nothing more — no cc, no bcc, no replyTo. The
 * shape is load-bearing for security control C9 ("recipient mechanically
 * locked to self"): `send` always sets `to === from === selfAddress`, and
 * the unit tests assert the captured message's sorted key set is EXACTLY
 * these six — any future field added here (or stamped on in `send`) turns
 * a test red before it can widen where mail might go.
 */
export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Self-minted RFC 5322 Message-ID, angle brackets included. */
  messageId: string;
  /** Exactly one key: `X-AMB-Outbox-ID` (loop-prevention marker, C3). */
  headers: Record<string, string>;
}

export type SmtpSend = (message: SmtpMessage) => Promise<void>;

/**
 * Optional send-half dependencies for `createImapReadTransport`
 * (D-P3B5-1). Omitted entirely → the transport stays read-only and `send`
 * fails loud exactly as it did before this batch (zero read-side behavior
 * change).
 */
export interface ImapReadTransportSendDeps {
  /**
   * The bridge's own mailbox address — the ONLY value `send` ever places in
   * `from`/`to` (C9); `OutboundMail` itself carries no recipient field, so
   * there is no other source a recipient could even come from. Trimmed at
   * construction; blank throws there (same fail-closed whitespace guard as
   * `checkIdentityC1`'s selfAddress precedent in `src/domain/identity.ts`
   * — a blank address must fail loudly at wiring time, never become an
   * addressing target).
   */
  selfAddress: string;
  smtpSend: SmtpSend;
  /**
   * Persists the outbox row for a receipt. Awaited strictly BEFORE
   * `smtpSend` is invoked (C3 order invariant — see `send`'s doc comment).
   */
  registerOutbox: (receipt: SendReceipt, mail: OutboundMail) => Promise<void>;
  /** Outbox-id mint; defaults to `crypto.randomUUID`. Tests inject a fixed
   *  value for deterministic receipts. */
  mintOutboxId?: () => string;
}

/** {@link ImapReadTransportSendDeps} after construction-time validation:
 *  `selfAddress` trimmed and known non-blank, `mintOutboxId` defaulted. */
interface ResolvedSendDeps {
  selfAddress: string;
  smtpSend: SmtpSend;
  registerOutbox: (receipt: SendReceipt, mail: OutboundMail) => Promise<void>;
  mintOutboxId: () => string;
}

/** Construction-time validation for the send half (D-P3B5-2 clause 5):
 *  a blank/all-whitespace `selfAddress` throws HERE, at wiring time —
 *  never surviving to send time as an empty recipient. */
function resolveSendDeps(deps: ImapReadTransportSendDeps): ResolvedSendDeps {
  const selfAddress = deps.selfAddress.trim();
  if (selfAddress.length === 0) {
    throw new Error('ImapReadTransport: send.selfAddress must not be blank');
  }
  return {
    selfAddress,
    smtpSend: deps.smtpSend,
    registerOutbox: deps.registerOutbox,
    mintOutboxId: deps.mintOutboxId ?? randomUUID,
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
export function createImapReadTransport(opts: {
  factory: ImapClientFactory;
  /** Optional send half (D-P3B5-1). Omitted → read-only transport whose
   *  `send` fails loud (see `send` below). */
  send?: ImapReadTransportSendDeps;
  /** MIME parsing seam (D-P4B10-1). Omitted → `buildDefaultParseMime()`
   *  (the production mailparser wrapper); tests inject scripted fakes. */
  parseMime?: ParseMime;
}): MailTransport {
  const { factory } = opts;
  // Validated at CONSTRUCTION, not first send: a blank selfAddress is a
  // wiring bug and must surface before any mail could be involved.
  const sendDeps = opts.send === undefined ? undefined : resolveSendDeps(opts.send);
  const parseMime = opts.parseMime ?? buildDefaultParseMime();

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
            { envelope: true, internalDate: true, headers: true, source: true },
            { uid: true },
          );
          if (fetched === false) {
            continue;
          }
          // D-P4B10-1: the body path fails OPEN per message — see
          // `resolveBodyText` — unlike the fail-closed date skip inside
          // `mapFetchedMessage`.
          const bodyText = await resolveBodyText(fetched.source, parseMime);
          const mapped = mapFetchedMessage(fetched, uid, mailbox, uidValidity, bodyText);
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

    /**
     * Real SMTP send (D-P3B5-2) when send deps are configured. Without
     * them (every read-only construction) it keeps failing LOUD, never
     * silent, with the byte-identical pre-batch message — the text is
     * deliberately frozen ("same loud failure", D-P3B5-1): existing tests
     * pin it, and rewording it is not this batch's call. `async` (not a
     * bare `throw`) keeps the failure a proper Promise rejection — every
     * MailTransport method only ever fails via rejection, and callers rely
     * on that.
     *
     * ORDER INVARIANT (C3, load-bearing): mint `outboxId` → mint
     * `messageId` → AWAIT `registerOutbox` (outbox row recorded) →
     * `smtpSend` → resolve the receipt. `registerOutbox` rejecting means
     * `smtpSend` is NEVER reached — better to not send at all than to send
     * mail no outbox row remembers (an unrecorded send would blind the C3
     * echo gate and the bridge would re-ingest its own mail as a fresh
     * command). This is exactly the real-order contract
     * `tests/helpers/fakeTransport.ts#send` documents itself as mirroring.
     * A `smtpSend` rejection, by contrast, propagates AS-IS with the row
     * already registered: whether the server actually accepted that
     * submission is unknowable here, and reconciling such UNCERTAIN rows
     * is the daemon batch's outbox job, not this method's.
     *
     * Message-ID: `<amb-<outboxId>@agent-mail-bridge.invalid>`, on RFC
     * 2606's reserved `.invalid` TLD (never routable, never anyone's real
     * domain). ADR-0002 (docs/adr/0002-p0-1-gmail-imap-smtp-go.md, send
     * half) measured Gmail preserving sender-supplied Message-IDs on a
     * custom `.invalid` domain byte-identical end to end (3/3 probes) —
     * that preservation is what makes the receipt's `messageId` usable as
     * a C3 echo-gate key at all.
     */
    async send(mail: OutboundMail): Promise<SendReceipt> {
      if (sendDeps === undefined) {
        throw new Error(
          'ImapReadTransport: send not implemented — awaits red-line-3 confirmation (SMTP batch)',
        );
      }

      const outboxId = sendDeps.mintOutboxId();
      const messageId = `<amb-${outboxId}@agent-mail-bridge.invalid>`;
      const receipt: SendReceipt = { outboxId, messageId };

      await sendDeps.registerOutbox(receipt, mail);

      // C9: to === from === selfAddress — the ONLY recipient this message
      // can mechanically have. subject/text pass through byte-for-byte
      // (redaction is the upstream producer's job; the transport adds no
      // prefix or suffix). EXACTLY the six SmtpMessage keys, per its doc.
      await sendDeps.smtpSend({
        from: sendDeps.selfAddress,
        to: sendDeps.selfAddress,
        subject: mail.subjectRedacted,
        text: mail.bodyRedacted,
        messageId,
        headers: { 'X-AMB-Outbox-ID': outboxId },
      });

      return receipt;
    },

    /**
     * D-P4B11-1: current mailbox state for the daemon's watermark bootstrap
     * and UIDVALIDITY-change detection. Implemented over the SAME
     * connect -> read-only lock -> read `client.mailbox` -> release ->
     * logout cycle as `fetchSince` (the plan allowed imapflow's `status()`
     * as an alternative; reusing the existing mailbox-open fields keeps
     * `ImapClientLike` unchanged and the v0.1 one-connection-per-call
     * policy uniform). Read-only lock: reporting state must never mutate
     * the mailbox.
     */
    async mailboxStatus(mailbox: string): Promise<{ uidValidity: string; uidNext: number }> {
      const client = await factory.connect();
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        if (client.mailbox === false) {
          // Same loud fail-closed wording as fetchSince: a mailbox with no
          // state cannot anchor a watermark.
          throw new Error(
            `ImapReadTransport: mailbox "${mailbox}" reports no state after getMailboxLock ` +
              '(client.mailbox === false)',
          );
        }
        return {
          uidValidity: String(client.mailbox.uidValidity),
          uidNext: client.mailbox.uidNext,
        };
      } finally {
        lock.release();
        await client.logout();
      }
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

/**
 * Builds the production `SmtpSend` (D-P3B5-1): one nodemailer transport
 * over Gmail implicit-TLS SMTP — `smtp.gmail.com:465`, `secure: true` —
 * the exact host/port/TLS combination ADR-0002's send half measured
 * accepting authenticated self-sends 3/3. The `createTransport` call runs
 * ONCE and the returned closure reuses that same transport instance for
 * every submission; it is never rebuilt per message.
 *
 * NO `logger`/`debug` options, ever (RED LINE 2, AGENTS.md): nodemailer's
 * logger prints the SMTP dialogue — auth exchange and recipient addresses
 * included — to stdout. Same hard rule as `buildImapflowFactory`'s
 * `logger: false` above, and the same caveat applies: do not add it "just
 * to see what's happening" while debugging a send issue.
 *
 * Deliberately NOT unit-tested (unit tests inject fake `SmtpSend`s and
 * never open a network connection); this wiring is exercised by the live
 * send test (`tests/live/smtp-send-live.test.ts`, double-gated).
 *
 * Header-injection stance (load-bearing, review-verified at nodemailer
 * 9.0.3): `send()` passes `subjectRedacted`/`bodyRedacted` through
 * byte-for-byte, so CR/LF neutralization is delegated to nodemailer —
 * `_encodeHeaderValue` (lib/mime-node/index.js) collapses `\r?\n|\r` to a
 * single space in Subject, custom header values and Message-ID before
 * encoding, so a CRLF in upstream content folds into one header line
 * instead of smuggling extra headers. If nodemailer is ever swapped out,
 * this neutralization must be re-verified or enforced here. Related quirk:
 * nodemailer normalizes on-wire header casing (`X-AMB-Outbox-ID` is
 * emitted as `X-Amb-Outbox-ID`); harmless because the read side
 * lowercases all header names before matching (`x-amb-outbox-id`).
 */
export function buildDefaultSmtpSend(auth: { user: string; pass: string }): SmtpSend {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth,
  });
  return async (message: SmtpMessage): Promise<void> => {
    await transporter.sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      messageId: message.messageId,
      headers: message.headers,
    });
  };
}
