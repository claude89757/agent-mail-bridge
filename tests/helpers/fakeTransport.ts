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

  private readonly registerOutbox: RegisterOutbox;
  private readonly deliveredMails: IncomingMail[] = [];
  private sendCounter = 0;
  private uidCounter = 0;

  constructor(options: FakeMailTransportOptions) {
    this.registerOutbox = options.registerOutbox;
  }

  /**
   * Enqueues an incoming mail exactly as given. No sorting, no dedupe, no
   * validation of `uid` monotonicity — callers may deliver out of order or
   * redeliver the same mail to exercise at-least-once semantics.
   */
  deliver(mail: IncomingMail): void {
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
   * uid `deliver` has seen so far). `from`/`to`/`cc` are left empty — the
   * reflected mail's sole purpose is driving the echo gate, which inspects
   * only the Message-ID and the outbox header, never the address lists.
   * `internalDate` defaults to the Unix epoch when the caller does not care
   * about its value; pass an explicit ISO instant to control it.
   */
  reflectOutbound(receipt: SendReceipt, internalDate = '1970-01-01T00:00:00.000Z'): void {
    this.uidCounter += 1;

    this.deliver({
      messageId: receipt.messageId,
      headers: new Map([['x-amb-outbox-id', receipt.outboxId]]),
      from: [],
      to: [],
      cc: [],
      internalDate,
      uid: this.uidCounter,
      uidValidity: FAKE_UID_VALIDITY,
      mailbox: FAKE_MAILBOX,
    });
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
