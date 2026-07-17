/**
 * Pure mail-identity helpers (decision D-P2-1): Message-ID normalization is
 * the idempotency key for inbound ingest, `syntheticMessageKey` is the
 * fallback when a Message-ID is missing or invalid, and `deriveIntentId`
 * turns a normalized Message-ID into a deterministic dispatch-intent id so
 * creating an intent for the same mail twice stays idempotent.
 *
 * No IO: every function here is pure over its arguments.
 */
import { createHash } from 'node:crypto';

/**
 * A Message-ID that has passed `normalizeMessageId`. The brand exists so
 * raw header values and synthetic per-UID keys cannot reach
 * `deriveIntentId` by mistake — only the normalizer mints this type.
 */
export type NormalizedMessageId = string & { readonly __brand: 'NormalizedMessageId' };

/**
 * Normalizes a raw `Message-ID` header value into the canonical form used
 * as the idempotency key: trim whitespace, strip ONE outer `<...>` pair if
 * present, then require an `@` with non-empty content on BOTH sides (a bare
 * or one-sided `@` would collapse distinct malformed mails onto one shared
 * key, silently swallowing later commands as duplicates). Case is
 * preserved. Returns `null` for missing (`null`/`undefined`) or unusable
 * input — callers fall back to `syntheticMessageKey` (fail closed).
 */
export function normalizeMessageId(raw: string | null | undefined): NormalizedMessageId | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();
  const stripped =
    trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;

  const at = stripped.indexOf('@');
  return at > 0 && at < stripped.length - 1 ? (stripped as NormalizedMessageId) : null;
}

/**
 * Fallback idempotency key for mail with no usable Message-ID: unique per
 * `(uidValidity, uid)` so rejected mail (`NO_MESSAGE_ID`) is still
 * deduplicated across re-delivery of the same UID. Deliberately a plain
 * string, NOT a `NormalizedMessageId` — synthetic keys never derive intents.
 */
export function syntheticMessageKey(uidValidity: string, uid: number): string {
  return `synthetic:${uidValidity}:${uid}`;
}

/**
 * Derives a dispatch-intent id deterministically from a normalized
 * Message-ID: `di-` + the first 16 hex characters of its SHA-256 digest.
 * The same input always yields the same id, so intent creation stays
 * idempotent under duplicate delivery.
 */
export function deriveIntentId(normalizedMessageId: NormalizedMessageId): string {
  const digest = createHash('sha256').update(normalizedMessageId).digest('hex');
  return `di-${digest.slice(0, 16)}`;
}
