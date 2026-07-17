/**
 * UID high-water mark filter (decision D-P2-7).
 *
 * P0-1 evidence: the P0-1 IMAP smoke spike observed that RFC 3501
 * `UID SEARCH <n>:*` does NOT reliably report "nothing new" when no mail
 * has arrived since uid `n` — Gmail's IMAP server was seen returning the
 * LAST message in the mailbox instead (a range-inversion quirk: `n:*` reads
 * as "n through the highest uid", but a search anchored above every real uid
 * comes back non-empty rather than empty). A caller that trusts a search
 * result verbatim would re-ingest that same trailing message forever.
 *
 * `filterNewUids` is the single chokepoint that neutralizes this: every
 * caller of a search-like fetch (real IMAP now, any future transport later)
 * MUST run its result through this filter before treating any of it as new
 * mail. Pure, no IO — the watermark is passed in by the caller
 * (`src/store/metaStore.ts` persists it; this module never reads it itself).
 */

/**
 * Keeps only the `uids` strictly greater than `watermark`, preserving input
 * order and duplicates. Order/duplicates are preserved deliberately:
 * de-duplication is the store layer's job (idempotent insert on the
 * normalized Message-ID / synthetic key), not this filter's — collapsing
 * duplicates here would hide at-least-once redelivery from callers that
 * legitimately need to see it.
 */
export function filterNewUids(uids: number[], watermark: number): number[] {
  return uids.filter((uid) => uid > watermark);
}
