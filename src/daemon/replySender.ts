/**
 * Outbox lifecycle glue around every daemon send (decision D-P4B11-2, plan
 * docs/superpowers/plans/2026-07-19-phase-4-batch11-daemon-ticks.md) — the
 * daemon-side closure of the C3 send-order invariant. The transport already
 * guarantees `registerOutbox` is awaited BEFORE any SMTP submission
 * (`src/transports/imapRead.ts#send`, mirrored by
 * `tests/helpers/fakeTransport.ts`); this module supplies that callback and
 * settles the row's fate around the send's outcome:
 *
 *   - resolve            ⇒ SENDING → SENT (the receipt names the row);
 *   - reject, row exists ⇒ SENDING → UNCERTAIN — NEVER a resend: whether
 *     the server accepted that submission is unknowable here, and
 *     effectively-once (spec's "隔离对账，不盲目重发") hands the decision to
 *     reconciliation (the mail tick's echo pass) instead of guessing;
 *   - reject, no row     ⇒ REGISTER_FAILED — the C3 order means SMTP was
 *     never reached, nothing happened anywhere, so a later retry is safe.
 *
 * Reject-path row location: a transport rejection carries NO receipt, so
 * the just-registered row is found via
 * `outboxStore.findByCommandId(mail.commandId)` filtered to SENDING, taking
 * the id-order LAST row (plan-locked tie-break; in practice at most one
 * SENDING row exists per command — every send settles its own row, so a
 * second one is crash residue). A `commandId: null` mail that rejects after
 * registration cannot be located at all and returns REGISTER_FAILED
 * semantics — doc-noted unreachable: every reply the daemon composes
 * carries the command it answers (`ReplyContext.commandId` is non-null).
 *
 * Message-ID normalization (this module's own ruling, flagged in the batch
 * report): `registerOutbox` stores `normalizeMessageId(receipt.messageId)`,
 * NOT the raw bracketed receipt value. The plan sketch wrote
 * `messageId: receipt.messageId` verbatim, but its own reconciliation step
 * requires `findByMessageId(规范化 messageId)`（"echo gate 用的同键"）to hit
 * this row — and the echo gate (`ingest.ts` → `classifyEcho`) compares the
 * NORMALIZED inbound Message-ID against this column. Storing the bracketed
 * raw form would leave both the gate's message-id factor and the
 * UNCERTAIN→SENT reconciliation permanently blind for real receipts
 * (`<amb-…@agent-mail-bridge.invalid>`). A receipt whose Message-ID cannot
 * normalize throws (fail closed): per the C3 order invariant the SMTP
 * submission is then never attempted — better no send than a send no echo
 * key can ever recognize.
 *
 * No console, no `Date.now()`/`new Date()`: time only arrives through
 * `deps.clock` (dispatch.ts / ingest.ts discipline).
 */
import type { TransactionRunner } from '../application/ingest.js';
import { normalizeMessageId } from '../domain/mail.js';
import type { OutboxStore } from '../store/outboxStore.js';
import type { MailTransport, OutboundMail, SendReceipt } from '../transports/types.js';

export interface ReplySenderDeps {
  /** Same minimal structural transaction face as ingest (`ingest.ts`'s
   *  "Transaction type" doc) — the daemon has no reason to know its store
   *  is SQLite-backed either. */
  db: TransactionRunner;
  outboxStore: OutboxStore;
  transport: MailTransport;
  /** ISO clock (production binding: `() => new Date().toISOString()`). */
  clock(): string;
}

export interface SendReplyResult {
  /** Non-null whenever `registerOutbox` ran (SENT and UNCERTAIN); `null`
   *  when no row exists to point at (REGISTER_FAILED). */
  outboxId: string | null;
  status: 'SENT' | 'UNCERTAIN' | 'REGISTER_FAILED';
}

/** What `buildRegisterOutbox` needs — `ReplySenderDeps` minus the
 *  transport, because the PRODUCT of this builder is a construction-time
 *  dependency OF the transport (wiring it the other way round would be
 *  circular). */
export type RegisterOutboxDeps = Pick<ReplySenderDeps, 'db' | 'outboxStore' | 'clock'>;

/**
 * Builds the `registerOutbox` callback a transport is constructed with
 * (D-P4B11-2): inside ONE transaction, create the row (status PENDING) and
 * immediately transition it to SENDING — the row's existence in SENDING is
 * what marks "a submission may be in flight" for the reject path and for
 * crash recovery. A throw (including the normalization fail-closed below)
 * rolls back BOTH steps: zero rows, and — per the transport's C3 order —
 * zero SMTP submissions.
 */
export function buildRegisterOutbox(
  deps: RegisterOutboxDeps,
): (receipt: SendReceipt, mail: OutboundMail) => Promise<void> {
  return async (receipt: SendReceipt, mail: OutboundMail): Promise<void> => {
    const run = deps.db.transaction((): void => {
      const now = deps.clock();
      const normalized = normalizeMessageId(receipt.messageId);
      if (normalized === null) {
        // Fail closed (module doc comment): a row keyed by an
        // un-normalizable Message-ID could never be recognized by the echo
        // gate or reconciled out of UNCERTAIN — refuse before SMTP runs.
        throw new Error(
          `buildRegisterOutbox: cannot normalize receipt Message-ID ${receipt.messageId} — ` +
            'refusing to register (and therefore to send) a reply no echo key can recognize',
        );
      }
      deps.outboxStore.create({
        id: receipt.outboxId,
        messageId: normalized,
        commandId: mail.commandId,
        kind: mail.kind,
        now,
      });
      deps.outboxStore.transition(receipt.outboxId, 'SENDING', now);
    });
    run();
  };
}

/**
 * Sends one composed reply and settles its outbox row (D-P4B11-2; outcome
 * semantics in the module doc comment). The transport is expected to be
 * wired with `buildRegisterOutbox`'s product — a resolve against a
 * transport that never registered the row makes the SENT transition throw
 * loudly ("no outbox entry"), surfacing the wiring bug instead of
 * inventing a row.
 */
export async function sendReply(
  deps: ReplySenderDeps,
  mail: OutboundMail,
): Promise<SendReplyResult> {
  let receipt: SendReceipt;
  try {
    receipt = await deps.transport.send(mail);
  } catch {
    if (mail.commandId === null) {
      // Unreachable in practice (module doc comment): without a command
      // there is no way to locate a registered row, so report the
      // nothing-happened status even if a NULL-command row was stranded.
      return { outboxId: null, status: 'REGISTER_FAILED' };
    }
    const sendingRows = deps.outboxStore
      .findByCommandId(mail.commandId)
      .filter((row) => row.status === 'SENDING');
    const registered = sendingRows[sendingRows.length - 1];
    if (registered === undefined) {
      return { outboxId: null, status: 'REGISTER_FAILED' };
    }
    deps.outboxStore.transition(registered.id, 'UNCERTAIN', deps.clock());
    return { outboxId: registered.id, status: 'UNCERTAIN' };
  }

  deps.outboxStore.transition(receipt.outboxId, 'SENT', deps.clock());
  return { outboxId: receipt.outboxId, status: 'SENT' };
}
