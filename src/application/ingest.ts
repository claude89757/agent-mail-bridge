/**
 * `ingestMail` use case (decision D-P2-8): turns one piece of inbound mail
 * into exactly one of five outcomes, with every persisted side effect
 * (command row, intent row, watermark advance) landing inside ONE
 * better-sqlite3 transaction — a thrown error or crash mid-chain leaves
 * NOTHING behind (full rollback; Task 10 exercises this transaction
 * boundary directly), and a successful call is fully crash-consistent.
 *
 * Chain order (normative, D-P2-8 — this IS the threat-model control
 * ordering, not an arbitrary implementation choice):
 *
 *   idempotent insert -> [NO_MESSAGE_ID short-circuit] -> echo gate
 *     -> readyAt fence -> C1 identity -> time window -> intent creation
 *
 * Why this order, read top to bottom:
 *  1. Idempotent insert happens FIRST and unconditionally: every
 *     at-least-once redelivery of the same mail (same normalized Message-ID
 *     / same synthetic per-UID key) must collapse onto the SAME command row
 *     no matter which gate below would otherwise reject/queue/echo it. A
 *     `duplicate` outcome short-circuits here and never re-runs any gate.
 *  2. Missing/invalid Message-ID is resolved as part of step 1's key choice
 *     (`syntheticMessageKey` fallback) and, for a FRESH row, immediately
 *     produces `rejected`/`NO_MESSAGE_ID` before any further gate runs. This
 *     is this file's own ruling (the plan's chain prose names four gates —
 *     echo/readyAt/C1/window — not this fifth check): without a normalized
 *     Message-ID there is no input for `deriveIntentId`, so failing closed
 *     immediately, rather than evaluating echo/readyAt/C1/window against a
 *     mail that can never become an intent anyway, is both simpler and no
 *     less conservative (still a non-dispatching terminal outcome either
 *     way — it just skips gates that could not have changed that).
 *  3. Echo gate runs BEFORE identity so the bridge's own reflected replies
 *     (which `tests/helpers/fakeTransport.ts`'s `reflectOutbound` sends with
 *     EMPTY from/to/cc) are recognized as `echo` rather than misclassified
 *     as an identity failure (`IDENTITY_MULTI_RECIPIENT` on empty To/From).
 *     Reversing this order would make the loop guard unreliable exactly
 *     when it matters most.
 *  4. readyAt fence runs BEFORE C1 identity: mail predating the fence is
 *     rejected regardless of how well-formed its addresses are — the
 *     first-install guarantee ("never act on history") does not get
 *     weaker just because a mail also happens to look identity-valid.
 *  5. Time window is last of the reject/queue gates: only mail that is
 *     genuinely ours, fresh enough, and correctly addressed ever reaches the
 *     question of "queue for later or dispatch now."
 *  6. Intent creation is the only step reachable after every gate passes.
 *     `deriveIntentId` is deterministic, so re-running it for the same
 *     command id would be idempotent regardless — though per point 1 this
 *     step in practice only ever runs once per command row.
 *
 * Watermark ruling (orchestrator decision — D-P2-8's chain prose does not
 * mention the watermark at all; this file makes the call): a fresh call to
 * `metaStore.advanceWatermark` runs unconditionally, once, before any gate,
 * inside the SAME transaction as everything else. The Phase 2 plan's Task 9
 * integration criteria require the watermark to reach the max ingested uid
 * regardless of how individual mails were classified, and folding the
 * advance into this transaction keeps the command row and the watermark
 * crash-consistent with each other (either both persist, or neither does).
 * Calling it before the gates rather than in every individual return branch
 * is behaviorally identical — the store's advance is a `MAX(last_uid, ...)`
 * upsert, so its position relative to the gates inside one transaction
 * cannot change the stored result — and it avoids repeating the call at
 * five different return sites.
 *
 * QUEUED_WINDOW reason: `commands.status_reason` / `IngestResult.reason` on
 * a `queued-window` outcome carries `isWithinWindow`'s own `TimeWindowReason`
 * (`'excluded-date' | 'outside-days' | 'outside-hours'`) for diagnostics.
 * D-P2-2 does not enumerate specific QUEUED_WINDOW reasons the way it does
 * for REJECTED, so this is additive, not a contradiction — and the
 * lowercase-dashed shape reads unambiguously distinct from REJECTED's
 * `UPPER_SNAKE_CASE` reasons at a glance.
 *
 * Transaction type: `deps.db` is typed as the minimal structural
 * `TransactionRunner` below, NOT the concrete better-sqlite3 `Database` type
 * (not even type-only) — `src/application/` has no reason to know its store
 * is SQLite-backed; it only needs "something that can run a synchronous
 * callback transactionally and return its result." better-sqlite3's real
 * `Database#transaction` satisfies this structurally (its wrapped return
 * value is callable with the wrapped function's signature, plus extra
 * `.deferred`/`.immediate`/`.exclusive` properties this file never uses), so
 * the real store slots in with no adapter. Consistent with the store
 * layer's own inline-preparation style (see `commandStore.ts`'s doc
 * comment: "prepare fresh per call ... at one-mail-at-a-time call volume the
 * cost cannot matter"), a fresh transaction-wrapped closure is created on
 * EVERY `ingestMail` call rather than hoisted once in `createIngest` — the
 * minimal structural type's zero-argument signature is exactly what makes
 * that closure just close over that call's own `mail`/`now` instead of
 * threading them through as transaction arguments.
 *
 * No console (house eslint rule), no `Date.now()` / `new Date()` read
 * internally — `now` always arrives from the caller so ingest stays
 * deterministic and testable.
 */
import { classifyEcho } from '../domain/echo.js';
import { checkIdentityC1 } from '../domain/identity.js';
import {
  deriveIntentId,
  normalizeMessageId,
  syntheticMessageKey,
  type NormalizedMessageId,
} from '../domain/mail.js';
import { isWithinWindow, type TimeWindowConfig } from '../domain/timeWindow.js';
import type { CommandStore } from '../store/commandStore.js';
import type { IntentStore } from '../store/intentStore.js';
import type { MetaStore } from '../store/metaStore.js';
import type { OutboxStore } from '../store/outboxStore.js';
import type { IncomingMail } from '../transports/types.js';

/** The five possible outcomes of one `ingestMail` call (D-P2-8). */
export type IngestOutcome = 'duplicate' | 'echo' | 'rejected' | 'queued-window' | 'ready';

/**
 * Result of one `ingestMail` call (D-P2-8). `intentId` is non-null only for
 * `ready` (and for `duplicate` when the original command already reached
 * `ready`); `reason` is non-null only for `rejected` and `queued-window`.
 */
export interface IngestResult {
  outcome: IngestOutcome;
  commandId: number | null;
  intentId: string | null;
  reason: string | null;
}

/** Operator configuration `ingestMail` is parameterized over. */
export interface IngestConfig {
  /** Configured self address; forwarded verbatim to `checkIdentityC1`. */
  selfAddress: string;
  /** Omitted ⇒ always within window (`isWithinWindow`'s own contract). */
  timeWindow?: TimeWindowConfig;
  /** Marks every intent created by this pipeline `dry_run = 1`. */
  dryRun: boolean;
}

/**
 * Minimal structural shape `createIngest` needs from a database handle: run
 * a zero-argument callback transactionally and return its result. See the
 * module doc comment's "Transaction type" section for why this is NOT the
 * concrete better-sqlite3 `Database` type.
 */
export interface TransactionRunner {
  transaction<T>(fn: () => T): () => T;
}

export interface IngestDeps {
  db: TransactionRunner;
  commandStore: CommandStore;
  intentStore: IntentStore;
  outboxStore: OutboxStore;
  metaStore: MetaStore;
  config: IngestConfig;
  /**
   * Optional override for deriving a dispatch-intent id from a normalized
   * Message-ID. Test-only seam (Task 10, Phase 2 plan): omitted (the
   * default), behavior is EXACTLY as before — `deriveIntentId`, unchanged —
   * so this field exists purely so `tests/integration/crash-recovery.test.ts`
   * can inject a factory that throws (proving better-sqlite3's
   * whole-transaction rollback covers the full ingest chain, not just the
   * step that failed) or one that returns a fixed id (pinning the
   * fail-closed intent-id-collision guard below). Production callers never
   * set this.
   */
  intentIdFactory?: (id: NormalizedMessageId) => string;
}

/**
 * Builds the `ingestMail` use case (D-P2-8). See the module doc comment for
 * the full chain-order rationale.
 */
export function createIngest(deps: IngestDeps): (mail: IncomingMail, now: Date) => IngestResult {
  const {
    db,
    commandStore,
    intentStore,
    outboxStore,
    metaStore,
    config,
    intentIdFactory = deriveIntentId,
  } = deps;

  return (mail: IncomingMail, now: Date): IngestResult => {
    const run = db.transaction((): IngestResult => {
      const nowIso = now.toISOString();

      // Watermark ruling — see module doc comment: unconditional, first,
      // same transaction as everything else below.
      metaStore.advanceWatermark(mail.mailbox, mail.uidValidity, mail.uid);

      const normalizedId = normalizeMessageId(mail.messageId);
      const key = normalizedId ?? syntheticMessageKey(mail.uidValidity, mail.uid);

      const { inserted, record } = commandStore.insertIfAbsent({
        messageId: key,
        status: 'RECEIVED',
        statusReason: null,
        internalDate: mail.internalDate,
        uid: mail.uid,
        uidValidity: mail.uidValidity,
        now: nowIso,
      });

      if (!inserted) {
        const existingIntent = intentStore.getByCommandId(record.id);
        return {
          outcome: 'duplicate',
          commandId: record.id,
          intentId: existingIntent?.id ?? null,
          reason: null,
        };
      }

      const commandId = record.id;

      const reject = (reason: string): IngestResult => {
        commandStore.updateStatus(commandId, 'REJECTED', reason, nowIso);
        return { outcome: 'rejected', commandId, intentId: null, reason };
      };

      // NO_MESSAGE_ID short-circuit (module doc comment, point 2): a fresh
      // row with no usable Message-ID is rejected immediately, BEFORE the
      // echo/readyAt/C1/window gates ever run.
      if (normalizedId === null) {
        return reject('NO_MESSAGE_ID');
      }

      // D-P3B2-1: `headers` is a multi-value map (one array of same-name
      // instances per header name, in occurrence order) because
      // Authentication-Results legitimately repeats once per forwarding
      // hop. x-amb-outbox-id is different: the bridge writes EXACTLY ONE
      // such header on its own outbound mail (see
      // tests/helpers/fakeTransport.ts's reflectOutbound), so reading only
      // the FIRST instance is sufficient for every mail this bridge itself
      // produces. A hostile SECOND instance injected by an attacker cannot
      // turn a genuinely non-echo mail into a false "echo": classifyEcho
      // below still requires whatever value is read here to match a
      // recorded outboxStore id, so an attacker-supplied first instance
      // simply fails that lookup — the same trust decision the single-value
      // map made before this change, unaffected by what a later instance in
      // the same header might contain.
      const outboxHeaderValue = mail.headers.get('x-amb-outbox-id')?.[0] ?? null;
      const isEcho = classifyEcho(
        { messageId: normalizedId, outboxHeaderValue },
        {
          isKnownOutboxId: (id) => outboxStore.isKnownOutboxId(id),
          isKnownOutboxMessageId: (id) => outboxStore.isKnownOutboxMessageId(id),
        },
      );
      if (isEcho) {
        commandStore.updateStatus(commandId, 'SYSTEM_ECHO', null, nowIso);
        return { outcome: 'echo', commandId, intentId: null, reason: null };
      }

      const readyAt = metaStore.getReadyAt();
      if (readyAt === null) {
        // Fail closed: the fence cannot pass without a readyAt to compare
        // against (setup/Phase 5 sets it at install time).
        return reject('NO_READY_AT');
      }
      if (mail.internalDate < readyAt) {
        return reject('BEFORE_READY');
      }

      const identity = checkIdentityC1(
        { from: mail.from, to: mail.to, cc: mail.cc },
        config.selfAddress,
      );
      if (!identity.ok) {
        return reject(identity.reason);
      }

      const windowVerdict = isWithinWindow(config.timeWindow, now);
      if (!windowVerdict.within) {
        commandStore.updateStatus(commandId, 'QUEUED_WINDOW', windowVerdict.reason, nowIso);
        return {
          outcome: 'queued-window',
          commandId,
          intentId: null,
          reason: windowVerdict.reason,
        };
      }

      const intentId = intentIdFactory(normalizedId);
      const { created } = intentStore.createForCommand(intentId, commandId, config.dryRun, nowIso);
      if (!created) {
        // Fail closed (Task 8 review follow-up): a truncated-SHA collision
        // between two DIFFERENT Message-IDs deriving the SAME intent id
        // would otherwise silently report `ready` with a phantom intent
        // still belonging to the earlier mail. Unreachable in practice with
        // the real `deriveIntentId` (16 hex chars of SHA-256); pinned via
        // the intentIdFactory seam in tests/integration/crash-recovery.test.ts.
        throw new Error(
          `createIngest: intentStore.createForCommand did not create a row for commandId ` +
            `${commandId} (intent id "${intentId}" already exists) — intent-id collision (unexpected)`,
        );
      }
      commandStore.updateStatus(commandId, 'READY_FOR_DISPATCH', null, nowIso);

      return { outcome: 'ready', commandId, intentId, reason: null };
    });

    return run();
  };
}
