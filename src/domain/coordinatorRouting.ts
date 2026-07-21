/**
 * Coordinator dispatch resolution (ADR-0006, coordination batch A). Once
 * the coordinator agent has emitted a `dispatch` decision
 * (`coordinatorDecision.ts`), this pure function maps it onto the SAME
 * `RouteVerdict` the existing deterministic dispatch pipeline
 * (`application/dispatch.ts`) already consumes — so the coordinator layer
 * reuses the whole downstream execution path unchanged.
 *
 * The mapping is driven by the coordinator's `mode`, which is the ONE place
 * this diverges from `routing.ts`'s `routeCommand`:
 *
 *   - `routeCommand` gives thread continuity ABSOLUTE priority — an existing
 *     session means CONTINUE_SESSION no matter what the reply says. That is
 *     right for the deterministic path, where a reply on a thread simply
 *     means "more of the same task".
 *   - Here the coordinator has read the mail and formed an intent. `mode`
 *     carries it: `continue` continues the thread's session; `new` starts a
 *     fresh task EVEN on a thread that already has a session (旧线程换新任务
 *     — replying on an old thread to kick off a different project's task,
 *     which the deterministic path cannot express).
 *
 * The safety envelope does NOT depend on trusting the coordinator, though —
 * it holds structurally for BOTH modes:
 *   - `continue` can only ever continue THIS thread's already-persisted
 *     session (`existingSession`, looked up by threadKey upstream, never
 *     supplied by the model); a `continue` with no such session fails closed
 *     to a clarification rather than inventing one.
 *   - `new` can only ever dispatch to a UNIQUE allowlisted match (the
 *     `matches` come from `projectIndex.lookup(projectAlias)`, the only path
 *     source); zero or many matches fail closed to a clarification. Same
 *     "never guess" invariant as `routeCommand` (spec §6).
 *
 * Pure domain, no IO. `matches` is the caller's `projectIndex.lookup`
 * result (the caller holds the index; this function stays index-free, same
 * discipline as `routeCommand`). `prompt` does not appear here — it rides
 * alongside the verdict into the dispatch pipeline, exactly as in the
 * deterministic path's term/prompt split.
 */
import type { RouteVerdict, RoutingCandidate, RoutingSessionView } from './routing.js';

export interface CoordinatorDispatchInput {
  /** The coordinator's `dispatch.mode`. */
  readonly mode: 'new' | 'continue';
  /**
   * `projectIndex.lookup(projectAlias)`'s result — performed by the caller,
   * passed in to keep this function index-free. Only consulted on the `new`
   * path; on `continue` the thread session decides and matches are ignored.
   */
  readonly matches: readonly RoutingCandidate[];
  /** The thread's existing session mapping; `null` for a new thread. */
  readonly existingSession: RoutingSessionView | null;
}

/**
 * Maps a coordinator `dispatch` decision onto exactly one `RouteVerdict`.
 * See the module doc comment for the mode-driven priority and why every
 * non-executable case fails closed to a clarification.
 */
export function resolveCoordinatorDispatch(input: CoordinatorDispatchInput): RouteVerdict {
  if (input.mode === 'continue') {
    if (input.existingSession !== null) {
      return { kind: 'CONTINUE_SESSION', session: input.existingSession };
    }
    // Coordinator asked to continue a thread that has no persisted session —
    // contradiction (or an injected/confused output). Fail closed rather
    // than fabricate a session.
    return { kind: 'CLARIFY_NO_MATCH' };
  }

  // mode === 'new': the alias's exact-lookup matches decide, existingSession
  // deliberately NOT consulted (that is the 旧线程换新任务 divergence). Same
  // undefined-narrowing guard as routeCommand for noUncheckedIndexedAccess.
  const soleMatch = input.matches.length === 1 ? input.matches[0] : undefined;
  if (soleMatch !== undefined) {
    return { kind: 'DISPATCH_NEW', project: soleMatch };
  }

  if (input.matches.length > 1) {
    return { kind: 'CLARIFY_AMBIGUOUS', candidates: input.matches };
  }

  return { kind: 'CLARIFY_NO_MATCH' };
}
