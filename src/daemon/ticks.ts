/**
 * The daemon's single-step functions ("ticks", decision D-P4B11-3, plan
 * docs/superpowers/plans/2026-07-19-phase-4-batch11-daemon-ticks.md). Four
 * entry points, every one a SINGLE bounded step with a structured report —
 * the long-running loop, IDLE keep-alive, signals and `cli start` wiring
 * are the daemon-shell batch's (see ../daemon/README.md):
 *
 *   - `recoverInterruptedIntents`: startup-only; lands the crash-recovery
 *     contract `domain/intentState.ts` locked — every RUNNING intent found
 *     at boot is FAILED with the EXACT reason `INTERRUPTED_BY_RESTART`
 *     (comparable constant, first appearing as code here, as that module
 *     prescribed). Never re-run: effectively-once hands re-dispatch to the
 *     user via the result mail.
 *   - `sweepExpiredClarifications`: walks the store's `<=`-bounded
 *     pending-expired feed onto the PENDING→EXPIRED edge (the store and
 *     `checkClarificationBinding` share that boundary — a record this sweep
 *     expires at instant T is one the binding check would reject at T).
 *   - `runMailTick`: mailboxStatus → watermark → fetchSince → per mail
 *     [ingest → markProcessed → echo-reconcile | dispatch+reply]. The spec's
 *     reliability model in one function: at-least-once fetch + idempotent
 *     ingest, UIDVALIDITY change ⇒ NEW watermark key at 0 ⇒ full rescan
 *     whose BOUNDEDNESS comes from the readyAt fence and Message-ID dedupe
 *     (every historical mail collapses to `duplicate`/`rejected`), not from
 *     any fetch truncation; echo reconciliation is the ONLY path out of
 *     outbox UNCERTAIN (C3 closed loop).
 *   - `runOrphanTick`: re-animates PENDING intents whose dispatch never ran
 *     (crash between ingest and dispatch) by re-fetching the original mail
 *     via its persisted `(uidValidity, uid)` — `commandStore.getById`'s
 *     restart-recovery entry point put to work. Unrecoverable variants are
 *     TWO-STEP finalized `PENDING→RUNNING→FAILED(reason)`: the batch-8
 *     intent machine has no direct PENDING→FAILED edge and is deliberately
 *     not amended — the two-step spelling keeps the machine's invariant
 *     ("only RUNNING resolves") intact in the store's own terms.
 *
 * Failure posture (mail tick): one poisoned mail fails OPEN into
 * `report.failures` — `{uid, stage, message}` with the message passed
 * through `scrubText` (RED LINE 2: the report is log material for the
 * shell; paths/tokens must never reach it raw; `worktreePath: null` because
 * no single worktree is in scope at catch time, and production worktrees
 * live under the home dir the needle does cover) — and the batch continues.
 * `fetchSince` itself throwing (UIDVALIDITY race and friends) is FATAL for
 * the tick and propagates: with no mail list there is no per-mail blast
 * radius to contain, and the shell owns retry cadence. The orphan tick
 * mirrors the plan exactly: only the re-fetch is caught (→
 * ORPHAN_UNRECOVERABLE); an unexpected throw elsewhere propagates loudly.
 *
 * Dispatch glue (shared by mail tick `ready` arm and orphan tick found-mail
 * arm): extractCommand → [extraction-incomplete short-circuit] →
 * dispatchIntent → outcome-shaped reply → sendReply. Details pinned by
 * tests/unit/daemon-ticks.test.ts:
 *   - extraction inputs read off the mail exactly as `mailContent.ts`
 *     documents (subject/in-reply-to FIRST instance, references ALL
 *     instances, the mail's own Message-ID through `normalizeMessageId`);
 *   - `threadKey ?? prompt` missing ⇒ intent two-step finalized with reason
 *     `EXTRACTION_INCOMPLETE` + an EXTRACTION-stage ERROR reply naming the
 *     missing pieces (the stage-union member added for exactly this);
 *   - `ReplyContext` is built from the POST-dispatch session row: on
 *     DISPATCH_NEW the row (and possibly its worktreePath) only exists
 *     after `dispatchIntent` returns, and the reply's ScrubContext MUST
 *     carry that worktree needle to mask driver text (C9). `projectName` =
 *     the session projectPath's last POSIX segment (never the path itself);
 *     `homeDir` is injected by the shell (`os.homedir()` at the boundary —
 *     domain stays IO-free);
 *   - `clarification-needed` ⇒ STOPGAP until the clarification batch: if
 *     the command already carries an ERROR outbox row the user was already
 *     told — skip silently; else send ONE ROUTING-stage ERROR reply whose
 *     reason lists candidate NAMES only, never paths (batch-9 discipline),
 *     and leave the intent PENDING (the real clarification lifecycle owns
 *     the upgrade path). The orphan tick pre-checks the same ERROR-row
 *     predicate BEFORE re-fetching (skip reason CLARIFICATION_HELD), so the
 *     in-glue check is defense in depth on that path;
 *   - ACK: deliberately NOT sent by ticks. Dispatch here is synchronous —
 *     the result reply arrives in the same step, so an "accepted, working
 *     on it" ACK adds nothing; `composeAckReply` stands ready for the
 *     shell batch's async execution (doc'd in README.md).
 *
 * `report.dispatched` counts EXECUTED outcomes only (the driver actually
 * ran); replies of every kind are visible in `report.replies` regardless.
 *
 * No console, no zero-arg `new Date()`/`Date.now()`: time only arrives
 * through `deps.clock` (`new Date(deps.clock())` converts a provided value
 * — the dispatch.ts/ingest.ts discipline).
 */
import { dispatchIntent } from '../application/dispatch.js';
import { createIngest, type IngestConfig, type IngestOutcome, type TransactionRunner } from '../application/ingest.js';
import type { ProjectIndex } from '../application/projectIndex.js';
import type { CreateWorktreeInput } from '../application/worktreeManager.js';
import { normalizeMessageId } from '../domain/mail.js';
import { extractCommand } from '../domain/mailContent.js';
import {
  composeDispatchFailedReply,
  composeDryRunReply,
  composeResultReply,
  scrubText,
  type ReplyContext,
} from '../domain/replyComposition.js';
import type { AgentDriver } from '../drivers/types.js';
import type { ClarificationStore } from '../store/clarificationStore.js';
import type { CommandStore } from '../store/commandStore.js';
import type { IntentStore } from '../store/intentStore.js';
import type { MetaStore } from '../store/metaStore.js';
import type { OutboxStore } from '../store/outboxStore.js';
import type { SessionStore } from '../store/sessionStore.js';
import type { IncomingMail, MailTransport } from '../transports/types.js';
import { sendReply, type SendReplyResult } from './replySender.js';

/** The crash-recovery reason `domain/intentState.ts` locked (exact casing —
 *  a comparable constant, not prose). Exported so the shell batch compares
 *  against the same value it was written with. */
export const INTERRUPTED_BY_RESTART = 'INTERRUPTED_BY_RESTART';

/* ------------------------------------------------------------------ */
/* Startup recovery + expiry sweep                                     */
/* ------------------------------------------------------------------ */

export interface RecoverInterruptedDeps {
  intentStore: IntentStore;
  /** ISO clock (production binding: `() => new Date().toISOString()`). */
  clock(): string;
}

/**
 * Startup-only (the shell runs it ONCE, before any tick): every RUNNING
 * intent is a dispatch whose fate the crash made unknowable — FAILED with
 * the locked reason, never resumed, never re-run (module doc comment).
 */
export function recoverInterruptedIntents(deps: RecoverInterruptedDeps): {
  recovered: readonly string[];
} {
  const now = deps.clock();
  const recovered: string[] = [];
  for (const intent of deps.intentStore.findByStatus('RUNNING')) {
    deps.intentStore.transition(intent.id, 'FAILED', INTERRUPTED_BY_RESTART, now);
    recovered.push(intent.id);
  }
  return { recovered };
}

export interface SweepExpiredDeps {
  clarificationStore: ClarificationStore;
  clock(): string;
}

/**
 * Walks `findPendingExpiredBefore(now)` onto PENDING→EXPIRED. One clock
 * draw feeds both the query and every transition, so the set expired and
 * the instant they were expired AT are the same fact.
 */
export function sweepExpiredClarifications(deps: SweepExpiredDeps): {
  expired: readonly number[];
} {
  const now = deps.clock();
  const expired: number[] = [];
  for (const record of deps.clarificationStore.findPendingExpiredBefore(now)) {
    deps.clarificationStore.transition(record.id, 'EXPIRED', null, now);
    expired.push(record.id);
  }
  return { expired };
}

/* ------------------------------------------------------------------ */
/* Tick dependencies + reports                                         */
/* ------------------------------------------------------------------ */

export interface MailTickDeps {
  /** Ingest-family structural transaction face (`ingest.ts`). */
  db: TransactionRunner;
  transport: MailTransport;
  commandStore: CommandStore;
  intentStore: IntentStore;
  sessionStore: SessionStore;
  outboxStore: OutboxStore;
  metaStore: MetaStore;
  index: ProjectIndex;
  driver: AgentDriver;
  /** Narrowed worktree injection — the dispatch.ts seam, passed through. */
  createWorktree(input: CreateWorktreeInput): Promise<{ worktreePath: string; baseCommit: string }>;
  directoryExists(path: string): Promise<boolean>;
  worktreesRoot: string;
  baseRef: string;
  /** Injected `os.homedir()` — the shell reads it ONCE at the boundary;
   *  nothing below `daemon/` touches `node:os` (C9 scrub context input). */
  homeDir: string;
  /** The one watched mailbox (spec: the bridge watches exactly one). */
  mailbox: string;
  ingestConfig: IngestConfig;
  clock(): string;
}

/** Orphan recovery needs everything the mail tick needs EXCEPT the
 *  watermark/ingest half — it re-fetches by persisted uid and never
 *  re-ingests. */
export type OrphanTickDeps = Omit<MailTickDeps, 'metaStore' | 'ingestConfig'>;

/** Where inside one mail's processing the throw happened (fail-open
 *  attribution for the shell's log line). */
export type MailTickFailureStage = 'INGEST' | 'MARK_PROCESSED' | 'ECHO_RECONCILE' | 'DISPATCH';

export interface MailTickFailure {
  uid: number;
  stage: MailTickFailureStage;
  /** `describeError` output AFTER `scrubText` (red line 2 — module doc). */
  message: string;
}

export interface MailTickReport {
  fetched: number;
  outcomes: Record<IngestOutcome, number>;
  /** EXECUTED dispatches only (the driver ran); see the module doc comment. */
  dispatched: number;
  replies: SendReplyResult[];
  failures: MailTickFailure[];
}

export interface OrphanTickReport {
  /** PENDING intents examined this pass. */
  scanned: number;
  dispatched: number;
  replies: SendReplyResult[];
  /** Two-step FAILED(reason) terminalizations, in scan order. */
  finalized: { intentId: string; reason: string }[];
  skipped: { intentId: string; reason: 'COMMAND_NOT_READY' | 'CLARIFICATION_HELD' }[];
}

/** Duplicated per-file by convention (dispatch.ts, worktreeManager.ts, ...). */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* Dispatch glue (shared: mail tick `ready` arm, orphan found-mail arm) */
/* ------------------------------------------------------------------ */

/** Last non-empty `/`-segment of a session's projectPath (a realpath'd
 *  POSIX absolute path out of the project index — the only path source),
 *  or `null` for a degenerate input. A display NAME for the reply meta
 *  region; the path itself never renders (C9). */
function lastPathSegment(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? null;
}

/** Two-step terminalization (module doc comment): the intent machine has no
 *  direct PENDING→FAILED edge, deliberately unamended. */
function finalizePendingIntent(
  deps: Pick<OrphanTickDeps, 'intentStore' | 'clock'>,
  intentId: string,
  reason: string,
): void {
  deps.intentStore.transition(intentId, 'RUNNING', null, deps.clock());
  deps.intentStore.transition(intentId, 'FAILED', reason, deps.clock());
}

/**
 * One READY command mail, end to end: extract → dispatch → compose →
 * sendReply. Returns whether the driver EXECUTED and the reply's send
 * result (`null` when the stopgap dedupe skipped replying).
 */
async function dispatchReadyCommand(
  deps: OrphanTickDeps,
  mail: IncomingMail,
  commandId: number,
  intentId: string,
): Promise<{ executed: boolean; reply: SendReplyResult | null }> {
  const subjectRaw = mail.headers.get('subject')?.[0] ?? null;
  const extracted = extractCommand({
    subjectRaw,
    bodyText: mail.bodyText,
    messageIdNormalized: normalizeMessageId(mail.messageId),
    references: mail.headers.get('references') ?? [],
    inReplyTo: mail.headers.get('in-reply-to')?.[0] ?? null,
  });

  const senderDeps = {
    db: deps.db,
    outboxStore: deps.outboxStore,
    transport: deps.transport,
    clock: deps.clock,
  };

  /** Built AFTER dispatch so a DISPATCH_NEW session row (and its recorded
   *  worktreePath — the scrub needle) is visible; also correct pre-dispatch
   *  for the extraction arm, where no session can exist yet. */
  const buildContext = (): ReplyContext => {
    const session =
      extracted.threadKey === null
        ? undefined
        : deps.sessionStore.findByThreadKey(extracted.threadKey);
    return {
      originalSubject: subjectRaw,
      commandId,
      intentId,
      projectName: session === undefined ? null : lastPathSegment(session.projectPath),
      scrub: { worktreePath: session?.worktreePath ?? null, homeDir: deps.homeDir },
    };
  };

  if (extracted.threadKey === null || extracted.prompt === null) {
    finalizePendingIntent(deps, intentId, 'EXTRACTION_INCOMPLETE');
    const missing = [
      ...(extracted.threadKey === null ? ['threadKey'] : []),
      ...(extracted.prompt === null ? ['prompt'] : []),
    ];
    const reply = composeDispatchFailedReply(buildContext(), {
      stage: 'EXTRACTION',
      reason: `EXTRACTION_INCOMPLETE: missing ${missing.join(', ')}`,
    });
    return { executed: false, reply: await sendReply(senderDeps, reply) };
  }

  const outcome = await dispatchIntent(
    {
      intentId,
      threadKey: extracted.threadKey,
      term: extracted.term,
      prompt: extracted.prompt,
    },
    {
      intentStore: deps.intentStore,
      sessionStore: deps.sessionStore,
      index: deps.index,
      driver: deps.driver,
      createWorktree: deps.createWorktree,
      directoryExists: deps.directoryExists,
      worktreesRoot: deps.worktreesRoot,
      baseRef: deps.baseRef,
      clock: deps.clock,
    },
  );

  const ctx = buildContext();

  switch (outcome.kind) {
    case 'executed': {
      const reply = composeResultReply(ctx, {
        verdict: outcome.verdict,
        terminal: outcome.terminal,
        events: outcome.events,
      });
      return { executed: true, reply: await sendReply(senderDeps, reply) };
    }
    case 'dispatch-failed': {
      const reply = composeDispatchFailedReply(ctx, {
        stage: outcome.stage,
        reason: outcome.reason,
      });
      return { executed: false, reply: await sendReply(senderDeps, reply) };
    }
    case 'skipped-dry-run': {
      const reply = composeDryRunReply(ctx, outcome.verdict);
      return { executed: false, reply: await sendReply(senderDeps, reply) };
    }
    case 'clarification-needed': {
      const alreadyTold = deps.outboxStore
        .findByCommandId(commandId)
        .some((row) => row.kind === 'ERROR');
      if (alreadyTold) {
        return { executed: false, reply: null };
      }
      const reason =
        outcome.verdict.kind === 'CLARIFY_AMBIGUOUS'
          ? `cannot route: ambiguous (${String(outcome.verdict.candidates.length)} candidates: ` +
            `${outcome.verdict.candidates.map((candidate) => candidate.name).join(', ')})`
          : 'cannot route: no match';
      const reply = composeDispatchFailedReply(ctx, { stage: 'ROUTING', reason });
      return { executed: false, reply: await sendReply(senderDeps, reply) };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Mail tick                                                           */
/* ------------------------------------------------------------------ */

export async function runMailTick(deps: MailTickDeps): Promise<MailTickReport> {
  // Step 1-2: current validity picks the watermark KEY — a changed validity
  // lands on a fresh key at 0 and the full rescan converges (module doc).
  const { uidValidity } = await deps.transport.mailboxStatus(deps.mailbox);
  const since = deps.metaStore.getWatermark(deps.mailbox, uidValidity);

  // Step 3: fatal on throw (module doc comment) — nothing to fail open over.
  const fetched = await deps.transport.fetchSince(deps.mailbox, uidValidity, since);
  // Ascending uid order is this tick's own responsibility — the seam does
  // not promise sorted output (the fake preserves delivery order).
  const mails = [...fetched].sort((a, b) => a.uid - b.uid);

  const ingest = createIngest({
    db: deps.db,
    commandStore: deps.commandStore,
    intentStore: deps.intentStore,
    outboxStore: deps.outboxStore,
    metaStore: deps.metaStore,
    config: deps.ingestConfig,
  });

  const report: MailTickReport = {
    fetched: mails.length,
    outcomes: { duplicate: 0, echo: 0, rejected: 0, 'queued-window': 0, ready: 0 },
    dispatched: 0,
    replies: [],
    failures: [],
  };

  for (const mail of mails) {
    let stage: MailTickFailureStage = 'INGEST';
    try {
      const result = ingest(mail, new Date(deps.clock()));
      report.outcomes[result.outcome] += 1;

      // \Seen whatever the outcome — the flag is mailbox cosmetics, the
      // command row is the truth (plan step 3b).
      stage = 'MARK_PROCESSED';
      await deps.transport.markProcessed(mail);

      if (result.outcome === 'echo') {
        stage = 'ECHO_RECONCILE';
        reconcileEcho(deps, mail);
      } else if (result.outcome === 'ready') {
        stage = 'DISPATCH';
        if (result.commandId === null || result.intentId === null) {
          // IngestResult contract: `ready` always carries both — anything
          // else is an upstream bug, surfaced loudly (fail closed).
          throw new Error(
            'runMailTick: ready outcome without commandId/intentId (ingest contract violation)',
          );
        }
        const { executed, reply } = await dispatchReadyCommand(
          deps,
          mail,
          result.commandId,
          result.intentId,
        );
        if (executed) {
          report.dispatched += 1;
        }
        if (reply !== null) {
          report.replies.push(reply);
        }
      }
    } catch (error) {
      report.failures.push({
        uid: mail.uid,
        stage,
        message: scrubText(describeError(error), { worktreePath: null, homeDir: deps.homeDir }),
      });
    }
  }

  return report;
}

/**
 * Echo reconciliation (plan step 3c): the same normalized-Message-ID key
 * the echo gate matched on locates the outbox row; ONLY an UNCERTAIN row
 * transitions (SENDING is still in flight, SENT is already terminal — and
 * UNCERTAIN→SENT is the machine's single legal exit from UNCERTAIN). This
 * is the effectively-once loop's closing edge: seeing our own reply back
 * in the mailbox IS the proof the uncertain send landed.
 */
function reconcileEcho(deps: Pick<MailTickDeps, 'outboxStore' | 'clock'>, mail: IncomingMail): void {
  const normalized = normalizeMessageId(mail.messageId);
  if (normalized === null) {
    // Unreachable: ingest's NO_MESSAGE_ID short-circuit runs BEFORE its
    // echo gate, so an `echo` outcome implies a normalizable id.
    return;
  }
  const row = deps.outboxStore.findByMessageId(normalized);
  if (row !== undefined && row.status === 'UNCERTAIN') {
    deps.outboxStore.transition(row.id, 'SENT', deps.clock());
  }
}

/* ------------------------------------------------------------------ */
/* Orphan tick                                                         */
/* ------------------------------------------------------------------ */

export async function runOrphanTick(deps: OrphanTickDeps): Promise<OrphanTickReport> {
  const pending = deps.intentStore.findByStatus('PENDING');
  const report: OrphanTickReport = {
    scanned: pending.length,
    dispatched: 0,
    replies: [],
    finalized: [],
    skipped: [],
  };

  for (const intent of pending) {
    const finalize = (reason: string): void => {
      finalizePendingIntent(deps, intent.id, reason);
      report.finalized.push({ intentId: intent.id, reason });
    };

    const command = deps.commandStore.getById(intent.commandId);
    if (command === undefined) {
      // Defensive — the FK makes this unreachable in a healthy store.
      finalize('ORPHAN_COMMAND_MISSING');
      continue;
    }
    if (command.status !== 'READY_FOR_DISPATCH') {
      // QUEUED_WINDOW revival is a doc'd follow-up (v0.1 default config has
      // no time window, so the state is unreachable); everything else
      // non-READY simply is not this tick's to touch.
      report.skipped.push({ intentId: intent.id, reason: 'COMMAND_NOT_READY' });
      continue;
    }
    if (deps.outboxStore.findByCommandId(command.id).some((row) => row.kind === 'ERROR')) {
      // The stopgap already told the user this command cannot route —
      // held for the clarification batch, checked BEFORE any re-fetch IO.
      report.skipped.push({ intentId: intent.id, reason: 'CLARIFICATION_HELD' });
      continue;
    }
    if (command.uid === null || command.uidValidity === null) {
      // uidValidity null is folded in: without the pair there is nothing
      // to re-fetch by (ingest always persists both together).
      finalize('ORPHAN_NO_UID');
      continue;
    }

    let mails: IncomingMail[];
    try {
      mails = await deps.transport.fetchSince(deps.mailbox, command.uidValidity, command.uid - 1);
    } catch {
      // The persisted validity no longer opens (server reissued UIDs):
      // the original mail is unfindable by uid, permanently.
      finalize('ORPHAN_UNRECOVERABLE');
      continue;
    }
    const mail = mails.find((candidate) => candidate.uid === command.uid);
    if (mail === undefined) {
      finalize('ORPHAN_MAIL_GONE');
      continue;
    }

    const { executed, reply } = await dispatchReadyCommand(deps, mail, command.id, intent.id);
    if (executed) {
      report.dispatched += 1;
    }
    if (reply !== null) {
      report.replies.push(reply);
    }
  }

  return report;
}
