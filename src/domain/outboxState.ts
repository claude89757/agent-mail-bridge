/**
 * Outbox state machine (decision D-P2-3): a skeleton in Phase 2 (no real
 * SMTP send yet — that lands in Phase 3), but the transitions themselves
 * are final. Pure domain: no IO. `src/store/outboxStore.ts` (Task 6)
 * re-enforces these exact transitions just before persisting
 * `outbox.status`.
 *
 * UNCERTAIN models "the send outcome is unknown" (e.g. the network dropped
 * after SMTP accepted the message but before the bridge read the
 * response): threat-model control "no blind resend" (effectively-once,
 * never exactly-once, per the MVP acceptance criteria) — the only way out
 * of UNCERTAIN is reconciliation confirming SENT, never a fresh
 * PENDING/SENDING cycle that could double-send. SENT is terminal.
 */
import { IllegalTransitionError } from './errors.js';

export type OutboxStatus = 'PENDING' | 'SENDING' | 'SENT' | 'UNCERTAIN';

export const OUTBOX_STATUSES: readonly OutboxStatus[] = [
  'PENDING',
  'SENDING',
  'SENT',
  'UNCERTAIN',
];

/**
 * Legal outgoing edges per status (D-P2-3). SENT is terminal: a sent mail
 * is never re-sent, re-queued or re-classified.
 */
export const OUTBOX_TRANSITIONS: Readonly<Record<OutboxStatus, readonly OutboxStatus[]>> = {
  PENDING: ['SENDING'],
  SENDING: ['SENT', 'UNCERTAIN'],
  SENT: [],
  UNCERTAIN: ['SENT'],
};

/**
 * Throws `IllegalTransitionError` unless `to` is one of `from`'s legal edges
 * in `OUTBOX_TRANSITIONS`. In particular this blocks `PENDING -> UNCERTAIN`
 * directly — every send attempt must pass through `SENDING` first; there is
 * no shortcut straight into the reconciliation state.
 */
export function assertOutboxTransition(from: OutboxStatus, to: OutboxStatus): void {
  if (!OUTBOX_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError('outbox', from, to);
  }
}
