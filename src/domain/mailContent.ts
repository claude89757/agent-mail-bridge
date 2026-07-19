/**
 * Command-mail content extraction (decision D-P4B10-2, plan
 * docs/superpowers/plans/2026-07-19-phase-4-batch10-mail-content-path.md):
 * the pure function that turns a command mail's already-fetched pieces —
 * subject, decoded `bodyText`, thread headers — into the three values the
 * daemon's dispatch wiring (next batch) needs: `threadKey` (routing
 * anchor), `term` (project word for `resolveProject`) and `prompt` (the
 * agent task text). Pure domain, zero IO (AGENTS.md module boundary): no
 * clock, no parsing of raw mail bytes — every input arrives pre-extracted
 * by the transport/application layers (`IncomingMail.bodyText`, header-map
 * lookups), and this module only decides.
 *
 * v0.1 COMMAND FORMAT — 最小论, locked here (D-P4B10-2): the subject's
 * first whitespace-delimited token (after stripping the reply/forward
 * chain) is the PROJECT TERM; the body is the TASK TEXT; replying on an
 * existing thread means "continue" (the threadKey → session mapping is the
 * routing verdict's job — `term` does not participate on the CONTINUE
 * path). This deliberately minimal format is cheap to adjust after
 * real-device use precisely BECAUSE extraction is one pure function with
 * its own test file — reshaping the format touches nothing but this module.
 * Only `re:`/`fwd:` prefixes are recognized as chain links in v0.1.
 *
 * Message-id extraction (the plan's "<...> 提取 + ingest-identical
 * normalization"): References/In-Reply-To values are attacker-influenced
 * header text, so the angle-token scan below is manual `indexOf`/`charAt`
 * scanning — no regex — same ReDoS posture as `authResults.ts` and
 * `imapRead.ts#parseHeaderBlock`. Each extracted token then passes through
 * `normalizeMessageId` (`./mail.ts`) — LITERALLY the function ingest uses
 * as its idempotency key (the plan sketch said "identity.ts" but the ingest
 * normalizer actually lives in `mail.ts`; same layer, imported directly,
 * replyComposition's same-layer-import precedent). Reusing the exact
 * function, rather than a lowercasing re-implementation, is load-bearing:
 * `threadKey` must compare equal to keys derived from the SAME message-id
 * elsewhere in the pipeline (`commands.message_id`,
 * `agent_sessions.thread_key`), and `normalizeMessageId` preserves case —
 * a lowercased variant would silently break thread matching for any
 * mixed-case id. Pinned by the 对拍 test in
 * `tests/unit/mail-content.test.ts` (same input ⇒ same output as
 * `normalizeMessageId`).
 */
import { normalizeMessageId } from './mail.js';

export interface ExtractedCommand {
  /**
   * Thread anchor: References FIRST id ?? In-Reply-To ?? the mail's own
   * normalized Message-ID. All three absent ⇒ `null` (upstream ingest
   * already rejects NO_MESSAGE_ID mail, so the all-null case is
   * belt-and-suspenders, not a live path). The References anchor takes the
   * first COMPLETE `<...>` token across instances in occurrence order —
   * Gmail's References first entry is the thread ROOT (spec reliability
   * model's thread-anchoring semantics) — and if that first token fails
   * normalization the References level contributes `null` WITHOUT
   * re-anchoring onto a later id: a non-root anchor would silently split
   * the thread, so it is root or nothing (fail closed).
   */
  threadKey: string | null;
  /**
   * Project term: the subject's first whitespace-delimited token after
   * stripping the `re:`/`fwd:` chain, trim+lowercase (lowercase matches
   * `resolveProject`'s trim+lowercase term normalization in
   * `src/application/projectIndex.ts`); empty ⇒ `null`.
   */
  term: string | null;
  /**
   * Task text: the trimmed body when non-empty; else the FULL stripped
   * subject (a subject-only command is legitimate — "proj-a fix the tests"
   * with an empty body); both empty ⇒ `null`.
   */
  prompt: string | null;
}

/**
 * Finds the first complete `<...>` token in `raw`, or `null` when none
 * exists. Manual linear scan (see the module doc comment's ReDoS note). A
 * `<` encountered before the current token closes RESTARTS the scan at
 * that inner `<` — RFC 5322 msg-ids never contain `<`, so an unclosed
 * bracket is junk that must not swallow the real id following it
 * (`junk < <root@example.com>` yields `<root@example.com>`).
 */
function firstAngleBracketedToken(raw: string): string | null {
  const len = raw.length;
  let start = raw.indexOf('<');
  while (start !== -1) {
    let pos = start + 1;
    while (pos < len) {
      const ch = raw.charAt(pos);
      if (ch === '>') {
        return raw.slice(start, pos + 1);
      }
      if (ch === '<') {
        break;
      }
      pos += 1;
    }
    if (pos >= len) {
      return null;
    }
    start = pos;
  }
  return null;
}

/**
 * The References-level thread anchor: the first complete `<...>` token
 * across all header instances (occurrence order), normalized. An instance
 * with NO complete token is skipped (it carries no id at all); the first
 * instance that yields one DECIDES — `normalizeMessageId` returning `null`
 * for it (e.g. `<no-at-sign>`) makes the whole References level `null`
 * rather than re-anchoring on a later id (see `ExtractedCommand.threadKey`).
 */
function referencesAnchor(references: readonly string[]): string | null {
  for (const raw of references) {
    const token = firstAngleBracketedToken(raw);
    if (token !== null) {
      return normalizeMessageId(token);
    }
  }
  return null;
}

/**
 * The In-Reply-To-level thread anchor: same `<...>`-token extraction +
 * ingest normalization as {@link referencesAnchor}, over the single raw
 * header value. A bracketless value yields no token and therefore no
 * anchor (fail closed) — every real mail client brackets msg-ids, and
 * feeding an unbracketed free-form value straight into normalization could
 * mint a threadKey no legitimately-derived key would ever equal.
 */
function inReplyToAnchor(inReplyTo: string | null): string | null {
  if (inReplyTo === null) {
    return null;
  }
  const token = firstAngleBracketedToken(inReplyTo);
  return token === null ? null : normalizeMessageId(token);
}

/** True for the characters `firstToken` treats as token boundaries — the
 *  ASCII whitespace a subject line can realistically carry (space, tab, and
 *  CR/LF survivors of header unfolding). */
function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

/**
 * Strips the leading `re:`/`fwd:` chain (case-insensitive, arbitrarily
 * repeated, whitespace tolerated between links — `re: re: fix` and
 * `RE:FWD:fix` both yield `fix`), returning the remainder with leading
 * whitespace removed. Manual scan, no regex (module doc comment).
 */
function stripReplyForwardChain(subject: string): string {
  let rest = subject;
  for (;;) {
    const trimmed = rest.trimStart();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('re:')) {
      rest = trimmed.slice(3);
    } else if (lower.startsWith('fwd:')) {
      rest = trimmed.slice(4);
    } else {
      return trimmed;
    }
  }
}

/** The first whitespace-delimited token of `text`, or `null` when `text`
 *  is empty/all-whitespace. */
function firstToken(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let end = 0;
  while (end < trimmed.length && !isSpace(trimmed.charAt(end))) {
    end += 1;
  }
  return trimmed.slice(0, end);
}

/**
 * Extracts `{ threadKey, term, prompt }` from a command mail's
 * already-fetched pieces (D-P4B10-2; field semantics on
 * {@link ExtractedCommand}). Inputs map 1:1 onto what the caller reads off
 * an `IncomingMail`: `subjectRaw` = the `subject` header's FIRST instance
 * (`null` when absent), `references` = every `references` header instance
 * passed through verbatim, `inReplyTo` = the `in-reply-to` header's first
 * instance, `messageIdNormalized` = the mail's own Message-ID AFTER
 * `normalizeMessageId` (ingest already computes it — pass that, never the
 * raw header).
 */
export function extractCommand(input: {
  subjectRaw: string | null;
  bodyText: string | null;
  messageIdNormalized: string | null;
  references: readonly string[];
  inReplyTo: string | null;
}): ExtractedCommand {
  const threadKey =
    referencesAnchor(input.references) ??
    inReplyToAnchor(input.inReplyTo) ??
    input.messageIdNormalized;

  const strippedSubject =
    input.subjectRaw === null ? null : stripReplyForwardChain(input.subjectRaw).trim();

  const term = strippedSubject === null ? null : (firstToken(strippedSubject)?.toLowerCase() ?? null);

  const trimmedBody = input.bodyText === null ? '' : input.bodyText.trim();
  const prompt =
    trimmedBody.length > 0
      ? trimmedBody
      : strippedSubject !== null && strippedSubject.length > 0
        ? strippedSubject
        : null;

  return { threadKey, term, prompt };
}
