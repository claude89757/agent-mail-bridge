/**
 * Routing verdict (decision D-P4B7-1, plan
 * `docs/superpowers/plans/2026-07-19-phase-4-batch7-router-core.md`) — the
 * deterministic core of Phase 4 routing. Pure domain: no IO, no
 * dependencies, same discipline as `checkClarificationBinding`
 * (`clarificationState.ts`): a pure function over ALREADY-EXTRACTED values.
 * Term extraction and mail formats are explicitly OUT of this batch — spec
 * line 213 requires a real-device walkthrough before Phase 4 proper locks
 * those, so `RouteInput` models the extraction's OUTPUT shape only.
 *
 * LOCKED INVARIANT (spec §6, "低置信永远澄清而不猜测"): this function NEVER
 * returns any fuzzy/approximate result. Outside thread continuity
 * (CONTINUE_SESSION) and a UNIQUE exact-lookup hit (DISPATCH_NEW), every
 * input clarifies — CLARIFY_AMBIGUOUS or CLARIFY_NO_MATCH, never a guess.
 * Deliberately, `RouteInput` does NOT carry the full project index: with
 * only the exact-lookup `matches` in hand, this function COULD NOT sneak in
 * fuzzy matching even if a later edit were tempted to — the "list every
 * project so the user can pick" candidate assembly for a NO_MATCH
 * clarification mail is the clarification batch's job, done by a caller
 * that legitimately holds the index.
 */

/**
 * The session mapping already persisted for a thread (the router looks it
 * up BY threadKey — `sessionStore.findByThreadKey`, D-P4B7-2 — before
 * calling `routeCommand`); a brand-new thread has none (`null` in
 * `RouteInput.existingSession`).
 */
export interface RoutingSessionView {
  /** The project this thread's session is bound to (a realpath'd path that
   * originally came out of the project index — never from mail text). */
  projectPath: string;
  /**
   * The driver's own session id (ADR-0004: `codex exec`'s `thread.started`
   * thread_id, stable across resumes). `null` until the FIRST dispatch's
   * `thread.started` event is observed — the mapping row is created before
   * the driver session exists.
   */
  driverSessionId: string | null;
}

/**
 * One exact-lookup candidate — a {name, path} subset of
 * `projectIndex.ts`'s `ProjectEntry` (its `path` is the realpath'd,
 * allowlisted location; see that module's core invariant for why no other
 * path source exists).
 */
export interface RoutingCandidate {
  name: string;
  path: string;
}

export interface RouteInput {
  /**
   * The ALREADY-EXTRACTED project term; `null` when extraction failed or
   * the mail carried none (fail closed — with no existing session that
   * routes to a clarification, never a guess).
   */
  term: string | null;
  /** The thread's existing session mapping; `null` for a new thread. */
  existingSession: RoutingSessionView | null;
  /**
   * `projectIndex.lookup(term)`'s result — the CALLER performs the lookup
   * and passes it in, keeping this function pure (no index handle in here,
   * see the module doc comment). Contract: pass `[]` when `term` is
   * `null`. Should a caller violate that (non-empty `matches` with a
   * `null` term), the verdict still follows the matches count
   * deterministically — `term` is never re-inspected once `matches` is in
   * hand (test-pinned).
   */
  matches: readonly RoutingCandidate[];
}

export type RouteVerdict =
  | { kind: 'CONTINUE_SESSION'; session: RoutingSessionView }
  | { kind: 'DISPATCH_NEW'; project: RoutingCandidate }
  | { kind: 'CLARIFY_AMBIGUOUS'; candidates: readonly RoutingCandidate[] }
  | { kind: 'CLARIFY_NO_MATCH' };

/**
 * Maps one command mail's routing inputs onto exactly one of four verdicts,
 * in a FIXED priority order (D-P4B7-1, test-pinned):
 *
 *   1. `existingSession !== null` ⇒ CONTINUE_SESSION — thread continuity
 *      beats everything: replying on an existing thread IS "continue",
 *      whatever the reply's term says and whatever it matches. Whether a
 *      term inside such a reply should ever be re-interpreted (e.g. to
 *      redirect the thread) is the reply-parsing batch's question, not
 *      this function's — here the session mapping wins unconditionally.
 *   2. `matches.length === 1` ⇒ DISPATCH_NEW — only a UNIQUE exact hit
 *      dispatches.
 *   3. `matches.length > 1` ⇒ CLARIFY_AMBIGUOUS — candidates pass through
 *      in input order verbatim; any display cap/truncation belongs to the
 *      clarification-mail generator, not here.
 *   4. everything else (null term / empty matches) ⇒ CLARIFY_NO_MATCH —
 *      never guess (see the module doc comment for where the "offer every
 *      project" candidate list comes from instead).
 */
export function routeCommand(input: RouteInput): RouteVerdict {
  if (input.existingSession !== null) {
    return { kind: 'CONTINUE_SESSION', session: input.existingSession };
  }

  // `matches[0]` is only consumed behind the length === 1 check; the
  // `undefined` narrowing (rather than a non-null assertion) keeps
  // noUncheckedIndexedAccess honest — `RoutingCandidate[]` cannot contain
  // `undefined`, so `soleMatch !== undefined` iff exactly one match exists.
  const soleMatch = input.matches.length === 1 ? input.matches[0] : undefined;
  if (soleMatch !== undefined) {
    return { kind: 'DISPATCH_NEW', project: soleMatch };
  }

  if (input.matches.length > 1) {
    return { kind: 'CLARIFY_AMBIGUOUS', candidates: input.matches };
  }

  return { kind: 'CLARIFY_NO_MATCH' };
}
