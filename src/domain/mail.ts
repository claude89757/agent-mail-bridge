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
 * Normalizes a raw `Message-ID` header value into the canonical form used
 * as the idempotency key: trim whitespace, strip ONE outer `<...>` pair if
 * present, then require the result to be non-empty and contain `@`. Case is
 * preserved. Returns `null` for missing or unusable input — callers fall
 * back to `syntheticMessageKey` (fail closed).
 */
export function normalizeMessageId(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }

  const trimmed = raw.trim();
  const stripped =
    trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;

  return stripped.length > 0 && stripped.includes('@') ? stripped : null;
}

/**
 * Fallback idempotency key for mail with no usable Message-ID: unique per
 * `(uidValidity, uid)` so rejected mail (`NO_MESSAGE_ID`) is still
 * deduplicated across re-delivery of the same UID.
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
export function deriveIntentId(normalizedMessageId: string): string {
  const digest = createHash('sha256').update(normalizedMessageId).digest('hex');
  return `di-${digest.slice(0, 16)}`;
}
