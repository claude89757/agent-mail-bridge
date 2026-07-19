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
 *
 * Composers (D-P4B9-3): four entry points map `dispatchIntent`'s outcomes
 * onto ready-to-send mails — `composeResultReply` (executed: completed ⇒
 * RESULT, failed ⇒ ERROR), `composeDispatchFailedReply` (ERROR),
 * `composeDryRunReply` (RESULT — the dry-run's product IS the "what would
 * happen" report) and `composeAckReply` (ACK; whether an ack is actually
 * sent is the daemon's configuration call, this batch only composes). Body
 * skeleton is FIXED (test-pinned): status line -> meta region (project
 * name, intent id, verdict — NEVER a path: `projectName` is an index name,
 * and any path can only ever appear as a `<cwd>`/`<home>` placeholder) ->
 * event region (`[agent] `/`[tool] ` lines; terminal events are rendered
 * ONLY in the terminal region, never duplicated as event lines) -> terminal
 * region. Note the asymmetry with the dispatch pipeline: a CLARIFY_* verdict
 * short-circuits `dispatchIntent` WITHOUT producing a reply (clarification
 * record + token + mail are designed together in the clarification batch),
 * but `composeDryRunReply` legitimately REPORTS "would clarify" — a dry-run
 * report about clarifying is not a clarification. CLARIFY candidate lists
 * show `name` only, never `path` (spec candidate-display gate, test-pinned
 * zero path occurrence).
 */
import type { RouteVerdict } from './routing.js';

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
 * Path-needle normalization (review fix M-1): a trailing-slash-configured
 * path (`/tmp/x/wt/`) would never match a BARE mention of the same path,
 * leaving it standing in the mail. Today's producers (worktreeManager's
 * join products, `os.homedir()`) never carry a trailing slash, but
 * `ScrubContext` is an exported seam the daemon batch will construct on
 * its own — so the needle is normalized here rather than trusted. A needle
 * that strips to fewer than 2 chars (e.g. `///`) falls to the existing
 * `replaceAllLiteral` guard and is skipped entirely.
 */
function stripTrailingSlashes(needle: string): string {
  return needle.replace(/\/+$/, '');
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
    out = replaceAllLiteral(out, stripTrailingSlashes(ctx.worktreePath), '<cwd>');
  }
  out = replaceAllLiteral(out, stripTrailingSlashes(ctx.homeDir), '<home>');
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

// ---------------------------------------------------------------------------
// Locally re-declared upper-layer shapes (see the module doc comment)
// ---------------------------------------------------------------------------

/**
 * Mirror of `src/store/outboxStore.ts`'s `OutboxKind`, NARROWED to the
 * kinds this batch's composers produce ('CLARIFICATION' composition is the
 * clarification batch's scope). Re-declared instead of imported because
 * `src/domain/` never imports from upper layers — not even type-only (no
 * existing domain file does, and this module keeps that invariant). A
 * narrower literal union is structurally assignable to `OutboxKind`, so
 * nothing upstream notices the difference.
 */
export type ComposedReplyKind = 'ACK' | 'RESULT' | 'ERROR';

/**
 * Structurally identical to `src/transports/types.ts`'s `OutboundMail`
 * (with `kind` narrowed to `ComposedReplyKind`, a subtype of `OutboxKind`)
 * — domain does not reverse-depend on upper layers; TypeScript's structural
 * typing lets every composer product feed `MailTransport.send` directly.
 * `tests/unit/reply-composition.test.ts` pins the compatibility with an
 * `OutboundMail`-annotated assignment, so any drift between the two shapes
 * is a compile error there, not a silent fork. The `subjectRedacted`/
 * `bodyRedacted` field names ARE the contract (C9): by the time text sits
 * in this shape it has passed `scrubText`.
 */
export interface ComposedReply {
  kind: ComposedReplyKind;
  commandId: number | null;
  subjectRedacted: string;
  bodyRedacted: string;
}

/**
 * Structurally identical to `src/drivers/types.ts`'s `DriverEvent` — same
 * re-declaration rationale as `ComposedReply`, same test-side compile pin
 * (a `DriverEvent[]` is passed to `composeResultReply` verbatim). All four
 * members are mirrored so the FULL buffered event list from
 * `DispatchOutcome.executed` type-checks unchanged; terminal members are
 * skipped at render time, not at the type boundary.
 */
export type ComposerDriverEvent =
  | { kind: 'agent-message'; text: string }
  | { kind: 'tool-activity'; summary: string }
  | { kind: 'completed'; resultText: string }
  | { kind: 'failed'; errorText: string };

// ---------------------------------------------------------------------------
// Composers (D-P4B9-3)
// ---------------------------------------------------------------------------

/** Everything every composer needs about the command being replied to. */
export interface ReplyContext {
  /** The original command mail's subject; `null` ⇒ fallback subject. Runs
   *  through `scrubText` like everything else. */
  originalSubject: string | null;
  commandId: number;
  intentId: string;
  /** Display name from the project index (a NAME, never a path); `null`
   *  when no project is known (e.g. early dispatch failures). */
  projectName: string | null;
  scrub: ScrubContext;
}

/** Subject cap in chars (D-P4B9-3, plan-locked). */
const SUBJECT_CAP = 200;

const FALLBACK_SUBJECT = 'amb: task update';

/** Case-insensitive `re:` detection; one hit means "already a reply", so
 *  multiple stacked prefixes are tolerated as-is (never `Re: Re: ...`+1). */
const REPLY_PREFIX_PATTERN = /^\s*re:/i;

/**
 * D-P4B9-3 subject rules: reply-prefix logic, then SEMANTIC single-lining
 * (CR/LF -> space; nodemailer's header folding is transport insurance, but
 * emitting a single-line subject is this layer's own responsibility), then
 * scrub, then a hard 200-char cap.
 *
 * Single-lining runs BEFORE the scrub (review fix I-1 — the plan's
 * original scrub-then-single-line order was the gap): the keyword regex's
 * `[^\S\n]` newline guard is correct for multi-line BODY text, but a
 * subject is about to BECOME one line — scrubbing first would let
 * `password:\n<value>` dodge the keyword rule and then be glued back into
 * `password: <value>` inside the sent subject. Gluing first is strictly
 * safer here: it can only make the keyword rule match MORE (never less),
 * and a space-glue cannot assemble a path needle occurrence that was not
 * already present.
 */
function composeSubject(originalSubject: string | null, ctx: ScrubContext): string {
  const base =
    originalSubject === null
      ? FALLBACK_SUBJECT
      : REPLY_PREFIX_PATTERN.test(originalSubject)
        ? originalSubject
        : `Re: ${originalSubject}`;
  const singleLine = scrubText(base.replace(/\r\n|\r|\n/g, ' '), ctx);
  return singleLine.length <= SUBJECT_CAP ? singleLine : singleLine.slice(0, SUBJECT_CAP);
}

/** Meta region (skeleton region 2): project name, intent id, verdict when
 *  one exists — and NEVER a path (module doc comment). `verdictKind` is a
 *  CLOSED literal union (review fix M-2), which is exactly what makes the
 *  un-scrubbed `verdict:` line safe: the type system, not a runtime
 *  scrub, keeps arbitrary text out of this parameter. */
function metaLines(ctx: ReplyContext, verdictKind: RouteVerdict['kind'] | null): string[] {
  const lines = [
    scrubText(`project: ${ctx.projectName ?? '(unknown)'}`, ctx.scrub),
    scrubText(`intent: ${ctx.intentId}`, ctx.scrub),
  ];
  if (verdictKind !== null) {
    lines.push(`verdict: ${verdictKind}`);
  }
  return lines;
}

/** Event region entries: `[agent] `/`[tool] ` lines, each text through the
 *  scrub+cap funnel. Terminal events are NOT rendered here — the caller's
 *  `terminal` field feeds the terminal region, single-sourced. */
function eventEntries(
  events: readonly ComposerDriverEvent[],
  ctx: ScrubContext,
): string[] {
  const entries: string[] = [];
  for (const event of events) {
    if (event.kind === 'agent-message') {
      entries.push(`[agent] ${scrubAndCapEventText(event.text, ctx)}`);
    } else if (event.kind === 'tool-activity') {
      entries.push(`[tool] ${scrubAndCapEventText(event.summary, ctx)}`);
    }
  }
  return entries;
}

/**
 * Executed outcome -> reply mail. `terminal.kind === 'completed'` ⇒ RESULT
 * with a `result:` region; `failed` ⇒ ERROR with an `error:` region (the
 * driver already scrubbed its synthesized errorText once — idempotence
 * makes this second pass harmless, and agent-produced failure text gets
 * its FIRST pass here). The `events` list may include the terminal event
 * (dispatch buffers it last); it is rendered only in the terminal region.
 */
export function composeResultReply(
  ctx: ReplyContext,
  outcome: {
    verdict: 'DISPATCH_NEW' | 'CONTINUE_SESSION';
    terminal:
      | { kind: 'completed'; resultText: string }
      | { kind: 'failed'; errorText: string };
    events: readonly ComposerDriverEvent[];
  },
): ComposedReply {
  const { terminal } = outcome;
  const completed = terminal.kind === 'completed';
  const entries = eventEntries(outcome.events, ctx.scrub);
  const head = [
    scrubText(completed ? `✅ completed (${outcome.verdict})` : `❌ failed (${outcome.verdict})`, ctx.scrub),
    '',
    ...metaLines(ctx, outcome.verdict),
    ...(entries.length > 0 ? ['', 'events:'] : []),
  ];
  const terminalText = terminal.kind === 'completed' ? terminal.resultText : terminal.errorText;
  const tail = ['', completed ? 'result:' : 'error:', scrubAndCapEventText(terminalText, ctx.scrub)];
  return {
    kind: completed ? 'RESULT' : 'ERROR',
    commandId: ctx.commandId,
    subjectRedacted: composeSubject(ctx.originalSubject, ctx.scrub),
    bodyRedacted: assembleCappedBody({ head, eventEntries: entries, tail }),
  };
}

/**
 * Dispatch-stage failure -> ERROR mail. The batch-8 stage-prefixed reason
 * wording (`WORKTREE: <msg>`, `SESSION_STATE_INCOMPLETE`, ...) is kept
 * VERBATIM (post-scrub) — the stage also rides in the status line, and no
 * verdict line exists because the failure input carries none.
 *
 * Stage union (D-P4B11 additive extension): the first three members mirror
 * `dispatchIntent`'s own dispatch-failed stages; `'EXTRACTION'` (the mail's
 * threadKey/prompt could not be extracted) and `'ROUTING'` (the daemon's
 * one-time clarification-stopgap cannot-route notice — reason lists
 * candidate NAMES only, never paths) are daemon-batch stages that never
 * appear in a `DispatchOutcome`. Widening here is a pure superset: the
 * dispatch pipeline's three-valued union stays assignable unchanged.
 */
export function composeDispatchFailedReply(
  ctx: ReplyContext,
  failure: {
    stage: 'SESSION_STATE' | 'WORKTREE' | 'DRIVER_START' | 'EXTRACTION' | 'ROUTING';
    reason: string;
  },
): ComposedReply {
  const head = [
    scrubText(`❌ dispatch failed (${failure.stage})`, ctx.scrub),
    '',
    ...metaLines(ctx, null),
  ];
  const tail = ['', 'error:', scrubAndCapEventText(failure.reason, ctx.scrub)];
  return {
    kind: 'ERROR',
    commandId: ctx.commandId,
    subjectRedacted: composeSubject(ctx.originalSubject, ctx.scrub),
    bodyRedacted: assembleCappedBody({ head, eventEntries: [], tail }),
  };
}

/** Human-language "what would happen" line(s) per verdict — names only,
 *  never paths, never driver session ids (test-pinned zero occurrence). */
function dryRunPlanLines(verdict: RouteVerdict, ctx: ScrubContext): string[] {
  switch (verdict.kind) {
    case 'DISPATCH_NEW':
      return [
        scrubText(`would dispatch a new agent session in project '${verdict.project.name}'.`, ctx),
      ];
    case 'CONTINUE_SESSION':
      return ['would resume the existing agent session bound to this thread.'];
    case 'CLARIFY_AMBIGUOUS':
      return [
        'would ask for clarification — the term matches multiple projects:',
        ...verdict.candidates.map((candidate) => scrubText(`- ${candidate.name}`, ctx)),
      ];
    case 'CLARIFY_NO_MATCH':
      return ['would ask for clarification — no project matched the given term.'];
  }
}

/**
 * Dry-run verdict -> RESULT mail: the "what would happen" report IS the
 * dry-run's product. All four verdicts render — including the CLARIFY_*
 * ones the live pipeline short-circuits without any reply (module doc
 * comment): reporting "would clarify" is not clarifying.
 */
export function composeDryRunReply(ctx: ReplyContext, verdict: RouteVerdict): ComposedReply {
  const head = [
    scrubText(`🔍 dry-run (${verdict.kind})`, ctx.scrub),
    '',
    ...metaLines(ctx, verdict.kind),
  ];
  const tail = ['', 'plan:', ...dryRunPlanLines(verdict, ctx.scrub)];
  return {
    kind: 'RESULT',
    commandId: ctx.commandId,
    subjectRedacted: composeSubject(ctx.originalSubject, ctx.scrub),
    bodyRedacted: assembleCappedBody({ head, eventEntries: [], tail }),
  };
}

/**
 * Acknowledgement mail (ACK): status + meta only — the task was accepted
 * and dispatched; the result reply follows separately. The plan's status
 * lines cover the four rendered outcomes; the ack's `📨 accepted` line is
 * this module's own choice in the same shape (status + verdict in parens).
 * Whether an ACK is sent at all is daemon configuration, out of scope here.
 */
export function composeAckReply(
  ctx: ReplyContext,
  info: { verdict: 'DISPATCH_NEW' | 'CONTINUE_SESSION' },
): ComposedReply {
  const head = [
    scrubText(`📨 accepted (${info.verdict})`, ctx.scrub),
    '',
    ...metaLines(ctx, info.verdict),
  ];
  return {
    kind: 'ACK',
    commandId: ctx.commandId,
    subjectRedacted: composeSubject(ctx.originalSubject, ctx.scrub),
    bodyRedacted: assembleCappedBody({ head, eventEntries: [], tail: [] }),
  };
}
