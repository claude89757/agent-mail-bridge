/**
 * Reply composition — threat-model C9's RENDERING half (decisions
 * D-P4B9-1..4, plan
 * docs/superpowers/plans/2026-07-19-phase-4-batch9-reply-composition.md).
 * Batch 6 shipped the transport half of C9 (recipient locked to self); this
 * module ships the other half: everything a `DispatchOutcome` carries —
 * driver events, terminal texts, failure reasons, even the original subject
 * — is UNSCRUBBED input (`src/application/dispatch.ts` says so explicitly)
 * and must pass through `scrubText` + the size caps below before it may
 * appear in an outbound mail's `subjectRedacted`/`bodyRedacted`.
 *
 * Pure domain, zero IO (AGENTS.md module boundary): no `node:os`/`fs`/
 * `path`, no clock, no randomness — `ScrubContext.homeDir` is INJECTED by
 * the caller (production: `os.homedir()` at the daemon boundary) precisely
 * so this file never touches `node:os`. No imports from `transports/`,
 * `store/` or `drivers/` either, not even type-only ones: `src/domain/` has
 * no cross-layer import precedent, so the outbound-mail and driver-event
 * shapes are re-declared locally below (structurally identical — see their
 * doc comments) and TypeScript's structural typing makes the composers'
 * products directly usable as `transports/types.ts`'s `OutboundMail`
 * without domain ever depending on an upper layer.
 *
 * Scrub order (D-P4B9-1, FIXED and test-pinned):
 *   1. worktree path -> `<cwd>` — BEFORE the home path, because a worktree
 *      under the home directory would otherwise be torn into `<home>/...`
 *      fragments (the codex driver's cwd-first precedent, red line 2);
 *   2. home path -> `<home>`;
 *   3. keyword-labelled values -> `<redacted>` (keyword and separator are
 *      preserved so the reader still sees WHAT was masked);
 *   4. long tokens (48+ chars of [A-Za-z0-9+/=_-]) -> `<redacted:${len}ch>`.
 * Paths go FIRST so the long-token rule cannot shred a path-shaped run and
 * leave a recognizable prefix that no longer matches the needle; placeholder
 * literals `<cwd>`/`<home>` are the SAME vocabulary the driver already
 * prints, so users see one language across logs and mail.
 *
 * Secret heuristic honesty (D-P4B9-1): 启发式地板，非担保 — this is a
 * heuristic FLOOR, not a guarantee. A secret that carries no keyword label,
 * stays under 48 chars and contains no known path will pass through; the
 * layered defenses (C6 workspace-write ceiling, self-only recipients, this
 * scrub) reduce blast radius, they do not promise perfect redaction. The 48
 * threshold is a deliberate trade: 40-hex git commit shas and 36-char UUIDs
 * are USEFUL result content and must survive, so the cutoff sits above both.
 *
 * Size caps (D-P4B9-2): `EVENT_TEXT_CAP` per event text (this is also how
 * spec §2's "大 diff 脱敏" is implemented in v0.1 — a large diff is capped
 * mechanically like any other long text, no diff-syntax awareness) and
 * `BODY_TOTAL_CAP` for the assembled body, dropping WHOLE events from the
 * oldest end, never touching head or terminal regions. Truncation happens
 * strictly AFTER scrubbing (the driver's scrub-before-truncate precedent):
 * truncating first could bisect a path and leave a live prefix standing.
 *
 * `scrubText` is idempotent (test-pinned): its placeholders contain no
 * masked-pattern triggers, so double-scrubbing (e.g. a driver-synthesized
 * errorText that already replaced cwd/home) is harmless.
 */

export interface ScrubContext {
  /** The session's worktree absolute path; `null` when none exists yet
   *  (e.g. a dispatch failure before worktree creation). */
  worktreePath: string | null;
  /** The caller injects `os.homedir()` — domain never touches `node:os`
   *  (zero-IO red line). */
  homeDir: string;
}

/** Per-event text cap in chars (D-P4B9-2) — exported so daemon and tests
 *  share one constant. */
export const EVENT_TEXT_CAP = 2_000;

/** Assembled-body cap in chars (D-P4B9-2) — exported so daemon and tests
 *  share one constant. */
export const BODY_TOTAL_CAP = 16_000;

/**
 * Keyword-labelled value masking (D-P4B9-1, locked regex): keyword +
 * `[:=]` separator (same-line whitespace tolerated, `[^\S\n]` never
 * crosses a newline) + a non-space value. Keyword and separator are kept,
 * the value becomes `<redacted>`.
 */
const SECRET_KEYWORD_VALUE_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|credential)([^\S\n]*[:=][^\S\n]*)(\S+)/gi;

/**
 * Long-token masking (D-P4B9-1): 48+ consecutive base64/hex/url-safe-ish
 * chars. The threshold deliberately clears 40-hex commit shas and UUIDs
 * (36 chars, `-` is in the class) — see the module doc comment.
 */
const LONG_TOKEN_PATTERN = /[A-Za-z0-9+/=_-]{48,}/g;

/**
 * Literal (non-regex) global replacement with the driver's needle >= 2
 * guard: an empty needle would match everywhere and a one-char needle (a
 * pathological `/` homedir) would shred the text — scrubbing is
 * safety-over-fidelity, but not at the cost of destroying the text
 * outright. Same rationale, same shape as `codexDriver.ts`'s
 * `replaceAllLiteral` (duplicated per-file by convention: domain cannot
 * import from `drivers/`).
 */
function replaceAllLiteral(text: string, needle: string, placeholder: string): string {
  if (needle.length < 2) {
    return text;
  }
  return text.split(needle).join(placeholder);
}

/**
 * The one scrub funnel (D-P4B9-1): every piece of text a composer emits —
 * subject, meta lines, event lines, terminal texts — goes through here.
 * Fixed order and idempotence are documented in the module doc comment and
 * pinned by tests.
 */
export function scrubText(text: string, ctx: ScrubContext): string {
  let out = text;
  if (ctx.worktreePath !== null) {
    out = replaceAllLiteral(out, ctx.worktreePath, '<cwd>');
  }
  out = replaceAllLiteral(out, ctx.homeDir, '<home>');
  out = out.replace(
    SECRET_KEYWORD_VALUE_PATTERN,
    (_match, keyword: string, separator: string) => `${keyword}${separator}<redacted>`,
  );
  out = out.replace(LONG_TOKEN_PATTERN, (match) => `<redacted:${String(match.length)}ch>`);
  return out;
}

/**
 * Scrub, THEN cap one event text (D-P4B9-2) — the order lives INSIDE this
 * function so it cannot be reassembled wrongly at a call site: truncating
 * before scrubbing could bisect a path needle and leave a live prefix
 * standing (driver precedent, test-pinned with a straddling-path fixture).
 * Used for event lines AND terminal result/error texts — capping the
 * terminal text here is what makes `assembleCappedBody`'s
 * never-truncate-head / never-drop-tail invariant satisfiable at all.
 * Exported (like the cap constants) so tests and the daemon share the
 * exact production semantics; composers are the production callers.
 */
export function scrubAndCapEventText(text: string, ctx: ScrubContext): string {
  const scrubbed = scrubText(text, ctx);
  if (scrubbed.length <= EVENT_TEXT_CAP) {
    return scrubbed;
  }
  const dropped = scrubbed.length - EVENT_TEXT_CAP;
  return `${scrubbed.slice(0, EVENT_TEXT_CAP)} …[truncated ${String(dropped)}ch]`;
}

/**
 * Assemble a body from three regions under `BODY_TOTAL_CAP` (D-P4B9-2):
 * `head` (status + meta lines) is NEVER truncated, `tail` (the terminal
 * region — the reply's reason to exist) is NEVER dropped; the only size
 * lever is dropping WHOLE `eventEntries` from the OLDEST end, replaced by
 * one `[${n} earlier events omitted]` marker line at the drop point. An
 * entry may span multiple physical lines (agent messages keep their
 * newlines); it is still dropped as one unit. If head+tail alone exceed
 * the cap (a composer-precondition violation — composers cap every tail
 * text via `scrubAndCapEventText` first) the helper still refuses to cut
 * them and returns the over-cap body: head/tail integrity outranks the
 * total cap. Exported for the same reason as `scrubAndCapEventText`.
 */
export function assembleCappedBody(parts: {
  head: readonly string[];
  eventEntries: readonly string[];
  tail: readonly string[];
}): string {
  const { head, eventEntries, tail } = parts;
  let dropped = 0;
  for (;;) {
    const kept = eventEntries.slice(dropped);
    const lines = [
      ...head,
      ...(dropped > 0 ? [`[${String(dropped)} earlier events omitted]`] : []),
      ...kept,
      ...tail,
    ];
    const body = lines.join('\n');
    if (body.length <= BODY_TOTAL_CAP || dropped === eventEntries.length) {
      return body;
    }
    dropped += 1;
  }
}
