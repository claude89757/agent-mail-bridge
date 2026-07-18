/**
 * Clarification state machine + four-factor binding check (decisions
 * D-P4B4-1 / D-P4B4-2, plan
 * `docs/superpowers/plans/2026-07-19-phase-4-batch4-clarification-binding.md`).
 * Pure domain: no IO. The state-machine half is isomorphic in shape to
 * `commandState.ts` (D-P2-2), `outboxState.ts` (D-P2-3) and `intentState.ts`
 * (D-P3P-4) — map-as-data + assert — so this is the fourth state machine in
 * this bridge, told apart from the other three only by its statuses and
 * edges, never by a different verification strategy. `src/store/
 * clarificationStore.ts` (Task 2 of the same plan) re-enforces this exact
 * map just before persisting `clarification_requests.status`, mirroring
 * D-P2-2's `commandStore.updateStatus`.
 *
 * This module also owns `checkClarificationBinding` (D-P4B4-2): the
 * deterministic half of threat-model control C8 ("clarification replies
 * must match token + thread + candidate-set version and TTL; late or stale
 * replies are quarantined" — `docs/threat-model.md`; spec §6, "低置信永远
 * 澄清而不猜测；澄清回复必须绑定 token + thread + 候选版本"). It is a pure
 * function over ALREADY-EXTRACTED values: parsing a real reply mail (token /
 * In-Reply-To extraction from subject/body) is explicitly OUT of this
 * batch's scope — spec line 213 requires a real-device walkthrough of the
 * candidate display format before Phase 4 proper locks that extraction, so
 * `ExtractedReplyBinding` below models the extraction's OUTPUT shape, not
 * its implementation. Likewise the quarantine ACTION for a rejected reply
 * (what the router does with an `{ ok: false }` verdict) is out of scope —
 * this function only classifies; see its own doc comment.
 */
import { IllegalTransitionError } from './errors.js';

/**
 * PENDING = a clarification was sent and is awaiting a reply. CONSUMED = a
 * reply that passed `checkClarificationBinding` was bound to this record.
 * EXPIRED = the TTL (`expiresAt`) passed. SUPERSEDED = the SAME command had
 * a NEWER candidate set issued (the underlying command was re-evaluated
 * before the old clarification was ever answered), so the old record is
 * retired without having been answered.
 *
 * WHO drives PENDING -> EXPIRED is deliberately NOT decided here: whether a
 * lazy check (the next time the record happens to be looked up) or a
 * proactive daemon sweep performs that transition is the daemon batch's
 * call, out of scope for this plan (see the plan's Task 3 hand-off note).
 * This module only defines that the edge is LEGAL, not who walks it.
 *
 * SUPERSEDED invariant (D-P4B4-1) — enforced by the STORE, not here (Task 2
 * of the same plan, `clarificationStore.create`): when a command's
 * clarification is re-issued, the OLD PENDING record is transitioned to
 * SUPERSEDED BEFORE the new record is inserted, in the SAME transaction.
 * This module has no notion of "records for the same command" to enforce
 * that with — it only knows single-record transitions — so "never two
 * PENDING records for one command" is a `clarificationStore.create`
 * responsibility. Called out here so the reader of SUPERSEDED's meaning
 * finds the enforcement point instead of assuming this module guarantees it.
 *
 * CONSUMED, EXPIRED and SUPERSEDED are all terminal: once a record leaves
 * PENDING, by whichever edge, nothing transitions it further (empty edge
 * lists below) — an outcome, once decided, never changes.
 */
export type ClarificationStatus = 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'SUPERSEDED';

/**
 * Legal outgoing edges per status (D-P4B4-1). PENDING resolves exactly
 * three ways — CONSUMED (a valid reply arrived), EXPIRED (TTL passed) or
 * SUPERSEDED (a newer candidate set was issued for the same command) — and
 * every other status is a dead end, exactly as in `commandState.ts` /
 * `outboxState.ts` / `intentState.ts`.
 */
// Typed as `Readonly<Record<..., readonly ...[]>>` rather than `as const`
// (which the plan's illustrative snippet used): under `as const` each edge
// list is a DISTINCT readonly tuple type, the map's value type becomes a
// union of those tuples, and `.includes(to)` on that union collapses its
// parameter type to `never` (TS2345) — it does not compile under any
// tsconfig. The wide-but-uniform annotation is the same convention the
// other three machines use.
export const CLARIFICATION_TRANSITIONS: Readonly<
  Record<ClarificationStatus, readonly ClarificationStatus[]>
> = {
  PENDING: ['CONSUMED', 'EXPIRED', 'SUPERSEDED'],
  CONSUMED: [],
  EXPIRED: [],
  SUPERSEDED: [],
};

// Derived from CLARIFICATION_TRANSITIONS's keys (declared below it to avoid
// a temporal-dead-zone reference) rather than hand-written, so this list can
// never silently drift from the map — extending CLARIFICATION_STATUSES
// without extending CLARIFICATION_TRANSITIONS is now a type error instead
// of a silent gap. Same technique as INTENT_STATUSES/COMMAND_STATUSES/
// OUTBOX_STATUSES.
export const CLARIFICATION_STATUSES = Object.keys(
  CLARIFICATION_TRANSITIONS,
) as readonly ClarificationStatus[];

/**
 * Throws `IllegalTransitionError` unless `to` is one of `from`'s legal edges
 * in `CLARIFICATION_TRANSITIONS`. As in the other three machines, a status
 * whose array is empty has no legal `to` at all, for any `to` including
 * itself (no self-transitions are modeled).
 */
export function assertClarificationTransition(
  from: ClarificationStatus,
  to: ClarificationStatus,
): void {
  if (!CLARIFICATION_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError('clarification', from, to);
  }
}

/**
 * Read-only view of a persisted clarification record (D-P4B4-2) — only the
 * fields `checkClarificationBinding` needs, not the store's full row shape
 * (no `id`/`commandId`/`candidateSetJson`/timestamps here; the store's own
 * row type carries those). `threadKey` is included for the CALLER's
 * benefit, not for this function's own use — see `checkClarificationBinding`'s
 * doc comment for why the function itself never reads it.
 */
export interface ClarificationRecordView {
  readonly token: string;
  readonly threadKey: string;
  readonly candidateSetVersion: number;
  /**
   * ISO 8601 instant (`.toISOString()` shape), compared lexicographically —
   * same convention as the readyAt fence in `src/application/ingest.ts`
   * (`mail.internalDate < readyAt`): both operands come from the same
   * fixed-width `.toISOString()` shape family, so lexical order agrees with
   * chronological order.
   */
  readonly expiresAt: string;
  readonly status: ClarificationStatus;
}

/**
 * Values already extracted from an inbound reply mail (D-P4B4-2). Mail
 * parsing itself — pulling a token out of a subject/body, normalizing
 * In-Reply-To into `threadKey` — is Phase 4 proper's job (see the module
 * doc comment); this interface is only the extraction's OUTPUT shape, kept
 * here so `checkClarificationBinding` has something to accept without this
 * batch depending on a parser that does not exist yet.
 */
export interface ExtractedReplyBinding {
  /**
   * `null` when the reply's token could not be extracted at all — fail
   * closed: `checkClarificationBinding` reports `TOKEN_MISMATCH`, never
   * throws and never waves a missing token through.
   */
  readonly token: string | null;
  /**
   * The reply's normalized In-Reply-To. Present so this shape mirrors
   * `ClarificationRecordView` for router/store convenience, but
   * `checkClarificationBinding` deliberately does NOT compare it against
   * `record.threadKey` — see the function's own doc comment for why.
   */
  readonly threadKey: string;
  /**
   * `null` when the candidate-set version could not be extracted at all —
   * fail closed: `checkClarificationBinding` reports `VERSION_STALE`.
   */
  readonly candidateSetVersion: number | null;
}

/**
 * Why `checkClarificationBinding` can reject (D-P4B4-2), in EXACT priority
 * order — see the function's doc comment for how ties are broken when a
 * reply fails more than one check at once.
 */
export type ClarificationRejectReason =
  // Record already left PENDING (CONSUMED/EXPIRED/SUPERSEDED) — e.g. a
  // reply arrived on a thread whose clarification was already answered,
  // already expired, or already superseded by a newer candidate set.
  | 'NOT_PENDING'
  // Reply token missing (null, extraction failed) or does not `===`
  // record.token.
  | 'TOKEN_MISMATCH'
  // Reply candidateSetVersion missing (null, extraction failed) or does not
  // match record.candidateSetVersion.
  | 'VERSION_STALE'
  // now >= record.expiresAt, compared lexicographically.
  | 'EXPIRED_AT_REPLY';

/**
 * The deterministic half of threat-model control C8 (D-P4B4-2): does
 * `reply` legitimately bind to `record`? Fail closed throughout — every
 * ambiguous or missing input is a rejection, never a pass.
 *
 * CONTRACT: the caller (router, out of this batch's scope) has ALREADY
 * looked `record` up BY `reply`'s threadKey before calling this function.
 * "No record found for this thread" is therefore not a
 * `ClarificationRejectReason` this function can report — a `NO_MATCH`-style
 * outcome belongs to the caller's lookup step; this function's contract
 * starts from "a record exists". Likewise, WHAT the caller does with an
 * `{ ok: false }` verdict (quarantine, log, drop) is out of scope — this
 * function only classifies.
 *
 * threadKey is deliberately NOT re-compared here even though both
 * `record.threadKey` and `reply.threadKey` exist: since the caller obtained
 * `record` BY looking it up via `reply.threadKey` (the CONTRACT above), a
 * re-comparison inside this function could only ever re-confirm what the
 * lookup already guarantees — it would be fake validation, checking the
 * caller's own lookup key against itself. `reply.threadKey` stays in the
 * shape anyway because store/router code finds it convenient to carry the
 * same extracted-binding value through both the lookup and this check.
 *
 * Priority order (fixed, deterministic, exactly the
 * `ClarificationRejectReason` enum order — test-pinned): a reply that fails
 * MULTIPLE checks at once reports only the FIRST one, in this order:
 *
 *   1. NOT_PENDING      — record.status !== 'PENDING'
 *   2. TOKEN_MISMATCH   — reply.token is null, or !== record.token
 *   3. VERSION_STALE    — reply.candidateSetVersion is null, or !== record's
 *   4. EXPIRED_AT_REPLY — now >= record.expiresAt
 *
 * So e.g. a SUPERSEDED record with a wrong token, a stale version, AND an
 * expired TTL reports `NOT_PENDING` — never any of the other three, because
 * once a record has left PENDING none of the fresher-looking factors matter
 * anymore. This also means a record's own terminal status is checked BEFORE
 * anything about the reply itself: an attacker cannot learn anything about
 * a dead record's token/version/TTL by observing which reason comes back.
 *
 * Token comparison (`reply.token === record.token`): exact, case-sensitive,
 * NOT trimmed. The bridge generates the token and embeds it verbatim in the
 * clarification mail it sends, so ANY transformation — different case, a
 * stray leading/trailing space introduced by a mail client's quoting or
 * wrapping — is treated as a genuine mismatch, not "close enough". No
 * constant-time comparison is used: a timing side channel on a `===`
 * string compare is not a realistic threat here because mail round-trips
 * are seconds-scale (nowhere near precise enough to time a byte-by-byte
 * compare) and each token is single-shot (one legitimate reply consumes
 * it; there is no repeated-oracle scenario to accumulate timing signal
 * against). Do not "fix" this into a constant-time-compare dependency — it
 * would add a dependency to defend against a threat that does not exist in
 * this transport.
 *
 * TTL comparison (`now >= record.expiresAt`): lexicographic, same
 * convention as the readyAt fence in `src/application/ingest.ts`
 * (`mail.internalDate < readyAt`) — both `now` and `expiresAt` are ISO 8601
 * strings from the same `.toISOString()` shape family, so lexical order
 * agrees with chronological order. The boundary is fail-closed: `now`
 * exactly EQUAL to `expiresAt` is treated as already expired
 * (`EXPIRED_AT_REPLY`), not as the last valid instant — `>=`, not `>`.
 *
 * Null extraction values (`reply.token === null` /
 * `reply.candidateSetVersion === null`, meaning Phase 4 proper's extraction
 * step could not read a token/version out of the reply at all) fail closed
 * into that factor's own mismatch reason (`TOKEN_MISMATCH` /
 * `VERSION_STALE` respectively) rather than a separate "extraction failed"
 * reason — from this function's point of view a missing value and a wrong
 * value are the same kind of failure to bind.
 */
export function checkClarificationBinding(
  record: ClarificationRecordView,
  reply: ExtractedReplyBinding,
  now: string,
): { ok: true } | { ok: false; reason: ClarificationRejectReason } {
  if (record.status !== 'PENDING') {
    return { ok: false, reason: 'NOT_PENDING' };
  }

  if (reply.token === null || reply.token !== record.token) {
    return { ok: false, reason: 'TOKEN_MISMATCH' };
  }

  if (
    reply.candidateSetVersion === null ||
    reply.candidateSetVersion !== record.candidateSetVersion
  ) {
    return { ok: false, reason: 'VERSION_STALE' };
  }

  if (now >= record.expiresAt) {
    return { ok: false, reason: 'EXPIRED_AT_REPLY' };
  }

  return { ok: true };
}
