/**
 * Echo gate (decision D-P2-4, security control C3): stops the bridge's own
 * outbound replies from being re-ingested as new inbound commands, which
 * would otherwise create a reply loop.
 *
 * No IO: `classifyEcho` is a pure function of its arguments. Lookups against
 * recorded outbox rows are injected by the caller as predicates rather than
 * performed here, so this module never touches the store directly.
 */
import type { NormalizedMessageId } from './mail.js';

/** The two mail-derived factors the echo gate checks. */
export interface EchoInput {
  /**
   * Inbound Message-ID already passed through `normalizeMessageId`;
   * `null`/`undefined` when missing or not normalizable.
   */
  readonly messageId: NormalizedMessageId | null | undefined;
  /**
   * Value of the inbound `x-amb-outbox-id` header; `null`/`undefined` when
   * absent (upstream header maps may yield either).
   */
  readonly outboxHeaderValue: string | null | undefined;
}

/**
 * Caller-provided lookups against previously recorded outbox rows. Both
 * outbox `id` (the nonce) and `message_id` are recorded before sending, so
 * either lookup can independently recognize our own mail.
 */
export interface EchoLookups {
  readonly isKnownOutboxId: (id: string) => boolean;
  readonly isKnownOutboxMessageId: (messageId: string) => boolean;
}

/**
 * Classifies inbound mail as an echo of our own outbound send. Echo iff the
 * `x-amb-outbox-id` header value matches a known outbox id, OR the inbound
 * normalized Message-ID matches a known outbox message id.
 *
 * An unknown `x-amb-outbox-id` header is NOT proof of echo by itself — an
 * attacker can forge that header on inbound mail, so only nonces/message-ids
 * we ourselves recorded before sending count. A missing factor
 * (`null`/`undefined`: header absent, or Message-ID that failed
 * normalization) simply does not match; its lookup is not invoked.
 */
export function classifyEcho(input: EchoInput, lookups: EchoLookups): boolean {
  if (input.outboxHeaderValue != null && lookups.isKnownOutboxId(input.outboxHeaderValue)) {
    return true;
  }

  if (input.messageId != null && lookups.isKnownOutboxMessageId(input.messageId)) {
    return true;
  }

  return false;
}
