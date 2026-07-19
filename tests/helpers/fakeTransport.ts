/**
 * In-memory `MailTransport` fake (D-P2-11 closing paragraph): Phase 2's
 * tests drive the whole event-core pipeline through this instead of a real
 * IMAP/SMTP connection. Implements the real `MailTransport` interface
 * faithfully — Phase 3 swaps in a real imap-smtp transport behind the exact
 * same seam, so anything written against this fake keeps working
 * unmodified.
 *
 * `no-console` still applies under `tests/helpers/` (house eslint rule):
 * this file must not become a hidden logging backdoor.
 */
import type {
  IncomingMail,
  MailTransport,
  OutboundMail,
  SendReceipt,
} from '../../src/transports/types.js';

/** Fixed mailbox `reflectOutbound` stamps onto re-delivered mail — the
 *  bridge watches exactly one mailbox (spec), so one fixed value is enough
 *  for a test fake. Exported so tests share one source of truth with the
 *  implementation instead of duplicating the literal. */
export const FAKE_MAILBOX = 'INBOX';

/** Fixed uidValidity `reflectOutbound` stamps onto re-delivered mail. */
export const FAKE_UID_VALIDITY = '1690000000';

/**
 * Registers a just-sent outbox row. `FakeMailTransport#send` calls this and
 * awaits it BEFORE resolving, mirroring the real send order where the
 * outbox row must exist before the SMTP ack arrives. May be sync or return
 * a promise; `send` awaits it either way so both work.
 */
export type RegisterOutbox = (receipt: SendReceipt, mail: OutboundMail) => void | Promise<void>;

export interface FakeMailTransportOptions {
  registerOutbox: RegisterOutbox;
}

/**
 * The intended at-least-once duplicate case: the very same object
 * redelivered, or a re-parsed copy carrying the same non-null Message-ID.
 * Two DISTINCT null-Message-ID objects are never the same logical mail —
 * with no id and no shared reference there is nothing left to prove it by,
 * so they fail closed as a collision in `deliver`.
 */
function isSameLogicalMail(a: IncomingMail, b: IncomingMail): boolean {
  return a === b || (b.messageId !== null && a.messageId === b.messageId);
}

/**
 * In-memory, at-least-once `MailTransport`. Deliberately does NOT sort or
 * dedupe delivered mail: `deliver` enqueues exactly what it is given, in
 * call order, duplicates and all — de-duplication is the store layer's job
 * (idempotent insert on the normalized Message-ID / synthetic key), not the
 * transport's.
 */
export class FakeMailTransport implements MailTransport {
  /** Every `OutboundMail` passed to `send`, in send order. */
  readonly sentMails: OutboundMail[] = [];
  /** Every `IncomingMail` passed to `markProcessed`, in call order. */
  readonly processedMails: IncomingMail[] = [];
  /**
   * Scriptable `mailboxStatus` answer (D-P4B11-1). `null` (the default)
   * yields the mechanical answer — `FAKE_UID_VALIDITY` plus a `uidNext` one
   * past the highest uid this fake has seen; UIDVALIDITY-change tests set a
   * value here to steer the daemon's mail tick onto a new watermark key.
   */
  scriptedMailboxStatus: { uidValidity: string; uidNext: number } | null = null;

  private readonly registerOutbox: RegisterOutbox;
  private readonly deliveredMails: IncomingMail[] = [];
  private sendCounter = 0;
  private uidCounter = 0;

  constructor(options: FakeMailTransportOptions) {
    this.registerOutbox = options.registerOutbox;
  }

  /**
   * Enqueues an incoming mail exactly as given. No sorting, no dedupe —
   * callers may deliver out of order or redeliver the same logical mail
   * (same object, or a re-parsed copy with the same non-null Message-ID) to
   * exercise at-least-once semantics.
   *
   * The ONE thing it does validate: a DIFFERENT mail must not reuse an
   * already-delivered `(mailbox, uidValidity, uid)` triple. A real IMAP
   * server never reuses a uid within one uidValidity, so that state is
   * impossible in production and always means a broken test fixture (the
   * classic trap: hand-picking a low uid AFTER `reflectOutbound` already
   * auto-assigned it) — the fake throws loudly instead of modeling it.
   */
  deliver(mail: IncomingMail): void {
    const occupant = this.deliveredMails.find(
      (existing) =>
        existing.mailbox === mail.mailbox &&
        existing.uidValidity === mail.uidValidity &&
        existing.uid === mail.uid,
    );
    if (occupant !== undefined && !isSameLogicalMail(occupant, mail)) {
      throw new Error(
        `FakeMailTransport.deliver: uid collision — a different mail already occupies ` +
          `(${mail.mailbox}, uidValidity ${mail.uidValidity}, uid ${mail.uid}); a real IMAP ` +
          `server never reuses a uid within one uidValidity. Pick a fresh uid, or deliver ` +
          `hand-picked uids BEFORE the first reflectOutbound (see its doc comment).`,
      );
    }

    this.deliveredMails.push(mail);
    if (mail.uid > this.uidCounter) {
      this.uidCounter = mail.uid;
    }
  }

  /**
   * Returns delivered mail matching `mailbox` + `uidValidity` with
   * `uid > sinceUid`, in delivery order, duplicates included. This fake
   * implements that contract directly rather than reproducing the P0-1
   * `UID SEARCH n:*` server quirk (see `src/domain/uid.ts`) — that quirk is
   * a property of the real IMAP server behind Phase 3's transport, which is
   * exactly why `filterNewUids` exists as a chokepoint callers apply
   * regardless of which transport they are talking to.
   */
  fetchSince(mailbox: string, uidValidity: string, sinceUid: number): Promise<IncomingMail[]> {
    const result = this.deliveredMails.filter(
      (mail) =>
        mail.mailbox === mailbox && mail.uidValidity === uidValidity && mail.uid > sinceUid,
    );
    return Promise.resolve(result);
  }

  /**
   * Builds a deterministic `SendReceipt` — a plain counter, never
   * `Math.random`/`Date.now`, so tests stay reproducible — then calls
   * `registerOutbox` and awaits it, and ONLY THEN resolves. This mirrors the
   * real send order, where the outbox row is recorded before the SMTP ack
   * is received.
   */
  async send(mail: OutboundMail): Promise<SendReceipt> {
    this.sendCounter += 1;
    const receipt: SendReceipt = {
      outboxId: `fake-outbox-${this.sendCounter}`,
      messageId: `<fake-${this.sendCounter}@bridge-user.example.com>`,
    };

    await this.registerOutbox(receipt, mail);

    this.sentMails.push(mail);
    return receipt;
  }

  /**
   * Re-delivers the mail identified by `receipt` as a fresh `IncomingMail`
   * carrying `x-amb-outbox-id: <outboxId>` and the same Message-ID the
   * receipt was issued with — this is what drives the echo-gate tests
   * (Tasks 8-9): a bridge that failed to recognize its own send here would
   * re-ingest its own reply as a new command.
   *
   * Gets a fresh uid in this fake's own uid sequence (one past the highest
   * uid `deliver` has seen so far). Hand-picked `deliver` uids and this
   * auto-sequence share ONE uid space, guarded by `deliver`'s collision
   * check — the safe patterns for a test are: make every hand-picked
   * `deliver` call BEFORE the first `reflectOutbound` (the auto-sequence
   * then continues above the highest uid seen), or rely on auto-assigned
   * uids exclusively. Hand-picking a low uid AFTER a reflect can land on a
   * uid the auto-sequence already took, and `deliver` will throw.
   *
   * The receipt is trusted verbatim: there is no check that `send` ever
   * issued it — a hand-built receipt is accepted without validation
   * (test-helper pragmatism; tests may fabricate receipts to stage edge
   * states directly).
   *
   * `from`/`to`/`cc` are left empty — the reflected mail's sole purpose is
   * driving the echo gate, which inspects only the Message-ID and the
   * outbox header, never the address lists. `internalDate` defaults to the
   * Unix epoch when the caller does not care about its value; pass an
   * explicit ISO instant to control it.
   */
  reflectOutbound(receipt: SendReceipt, internalDate = '1970-01-01T00:00:00.000Z'): void {
    this.uidCounter += 1;

    this.deliver({
      messageId: receipt.messageId,
      headers: new Map([['x-amb-outbox-id', [receipt.outboxId]]]),
      from: [],
      to: [],
      cc: [],
      // Mechanically `null` (like from/to/cc staying empty): the reflected
      // mail's sole purpose is driving the echo gate, which never reads the
      // body.
      bodyText: null,
      internalDate,
      uid: this.uidCounter,
      uidValidity: FAKE_UID_VALIDITY,
      mailbox: FAKE_MAILBOX,
    });
  }

  /**
   * D-P4B11-1: scripted value when set, else the mechanical default (see
   * `scriptedMailboxStatus`). Declared parameterless — the fake watches one
   * mailbox, and a fake method may declare fewer parameters than the
   * interface it implements (the scripted-client precedent in
   * tests/unit/imap-read-transport.test.ts).
   */
  mailboxStatus(): Promise<{ uidValidity: string; uidNext: number }> {
    if (this.scriptedMailboxStatus !== null) {
      return Promise.resolve(this.scriptedMailboxStatus);
    }
    return Promise.resolve({ uidValidity: FAKE_UID_VALIDITY, uidNext: this.uidCounter + 1 });
  }

  /** Records `mail` into `processedMails`. No other effect — there is no
   *  real IMAP flag to actually set against an in-memory fake. */
  markProcessed(mail: IncomingMail): Promise<void> {
    this.processedMails.push(mail);
    return Promise.resolve();
  }

  /** No real connection to release. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
