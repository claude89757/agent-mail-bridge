/**
 * Intent state machine (decision D-P3P-4, Phase 3 prework plan batch 1).
 * Pure domain: no IO. Isomorphic in shape to `commandState.ts` (D-P2-2) and
 * `outboxState.ts` (D-P2-3) — map-as-data + assert — so all three state
 * machines in this bridge are told apart only by their statuses and edges,
 * never by a different verification strategy. `src/store/intentStore.ts`'s
 * `transition` re-enforces this exact map just before persisting
 * `dispatch_intents.status`, mirroring D-P2-2's `commandStore.updateStatus`
 * and D-P2-3's `outboxStore.transition`.
 *
 * COMPLETED, FAILED, SKIPPED_DRY_RUN and RESOLVED are all terminal: once a
 * dispatch intent finishes running (however it finishes), is skipped for a dry
 * run, or is RESOLVED by a coordinator reply that ran no agent, nothing
 * transitions it further. In particular there is deliberately no edge back out
 * of FAILED into PENDING/RUNNING — see the CRASH RECOVERY doc comment below,
 * which is exactly why.
 *
 * RESOLVED (ADR-0006 coordination) is the terminal a mail reaches when the
 * coordinator handles it WITHOUT dispatching an agent — a meta-query `answer`
 * or a `clarify` question. It is a direct PENDING→RESOLVED edge (no RUNNING:
 * no agent ran) and is distinct from COMPLETED (an agent dispatch actually
 * completed) so metrics/observability never conflate "answered a question"
 * with "ran and finished a task". The coordinator's multi-turn continuity is
 * codex-thread resume on the NEXT mail (a fresh command + intent), so this
 * intent is genuinely done — unlike the deterministic C8 clarify, which
 * lingers PENDING awaiting a token round-trip. NOTE for the daemon (E-d-2):
 * PENDING→RESOLVED is not crash-atomic with sending the reply, so the
 * coordinator path MUST guard re-processing idempotently (the outbox
 * already-replied check), exactly as the deterministic clarify stopgap does.
 */
import { IllegalTransitionError } from './errors.js';

export type IntentStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED_DRY_RUN'
  | 'RESOLVED';

/**
 * CRASH RECOVERY (locked semantics — read this before touching daemon
 * startup code). The daemon itself is implemented OUTSIDE this batch; this
 * doc comment locks the contract so that implementer has a fixed target
 * instead of inventing one. Deliberately prose-only (no exported constant):
 * introducing daemon-facing code in a batch that explicitly excludes the
 * daemon would be unused, untested surface area — the daemon module is
 * where `'INTERRUPTED_BY_RESTART'` should first appear as code.
 *
 * On daemon startup, BEFORE processing anything else, every intent found in
 * `RUNNING` status MUST be transitioned to `FAILED` with
 * `status_reason = 'INTERRUPTED_BY_RESTART'` (exact casing — this is a
 * comparable constant, not prose; do not paraphrase it when writing the
 * daemon code).
 *
 * Why: a RUNNING intent at the moment of an unclean shutdown is in an
 * unknown state — the underlying agent task may have completed, partially
 * completed, or never started — and the bridge cannot safely tell which.
 * This is the intent-lifecycle analogue of the outbox `UNCERTAIN` status
 * (`outboxState.ts`, D-P2-3): effectively-once, never exactly-once (the MVP
 * acceptance criteria's "no blind resend" red line) means an interrupted
 * dispatch is NEVER silently re-run. Because FAILED is a dead end in
 * `INTENT_TRANSITIONS` below (empty edge list, same as COMPLETED and
 * SKIPPED_DRY_RUN), marking it FAILED this way hands the re-dispatch
 * decision back to the result mail / the user — exactly as UNCERTAIN hands
 * the send-outcome decision back to reconciliation instead of guessing.
 */

/**
 * Legal outgoing edges per status (D-P3P-4; RESOLVED added for ADR-0006).
 * PENDING can start running, be skipped outright (dry run — the underlying
 * agent task never runs at all), or be RESOLVED by a coordinator reply that
 * ran no agent (answer / clarify); RUNNING can only resolve to COMPLETED or
 * FAILED, never back to PENDING (see the crash-recovery doc comment above).
 * All four terminal statuses have empty edge lists — there is no notion of
 * "terminal" here beyond the map, exactly as in `commandState.ts`/
 * `outboxState.ts`.
 */
export const INTENT_TRANSITIONS: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  PENDING: ['RUNNING', 'SKIPPED_DRY_RUN', 'RESOLVED'],
  RUNNING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  SKIPPED_DRY_RUN: [],
  RESOLVED: [],
};

// Derived from INTENT_TRANSITIONS's keys (declared below it to avoid a
// temporal-dead-zone reference) rather than hand-written, so this list can
// never silently drift from the map — extending INTENT_STATUSES without
// extending INTENT_TRANSITIONS is now a type error instead of a silent gap.
export const INTENT_STATUSES = Object.keys(INTENT_TRANSITIONS) as readonly IntentStatus[];

/**
 * Throws `IllegalTransitionError` unless `to` is one of `from`'s legal edges
 * in `INTENT_TRANSITIONS`. As in `commandState.ts`/`outboxState.ts`, a
 * status whose array is empty has no legal `to` at all, for any `to`
 * including itself (no self-transitions are modeled).
 */
export function assertIntentTransition(from: IntentStatus, to: IntentStatus): void {
  if (!INTENT_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError('intent', from, to);
  }
}
