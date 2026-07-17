/**
 * Transport seam (decision D-P2-11): the shape every mail backend
 * implements. `src/application/` (Task 8's `ingestMail`) is written once
 * against `MailTransport`; Phase 2 drives it entirely through the in-memory
 * `tests/helpers/fakeTransport.ts`, and Phase 3's real imap-smtp transport
 * (informed by the P0-1 spike) is swapped in behind this exact interface
 * without touching `domain/`, `store/`, or `application/`.
 *
 * `OutboxKind` is imported type-only: a type-only import is erased at
 * compile time, so it carries no RUNTIME dependency on `src/store/**`. That
 * keeps this file (and every real transport built against it) free of the
 * "only src/store/** may import better-sqlite3" rule's concern, which is
 * about runtime imports, not type references.
 */
import type { OutboxKind } from '../store/outboxStore.js';

/** One inbound mail as delivered by a transport, already parsed. */
export interface IncomingMail {
  /** Raw `Message-ID` header value, unnormalized; `null` when absent. */
  messageId: string | null;
  /** Header names lowercased; values as received. */
  headers: ReadonlyMap<string, string>;
  /** Parsed addr-spec strings (no display names). */
  from: readonly string[];
  to: readonly string[];
  cc: readonly string[];
  /** ISO 8601 instant — the IMAP INTERNALDATE. */
  internalDate: string;
  uid: number;
  uidValidity: string;
  mailbox: string;
}

/** One outbound mail the bridge asks a transport to send. */
export interface OutboundMail {
  kind: OutboxKind;
  commandId: number | null;
  subjectRedacted: string;
  bodyRedacted: string;
}

/** What a transport returns once a send has been accepted. */
export interface SendReceipt {
  outboxId: string;
  messageId: string;
}

/**
 * Everything the event-core pipeline needs from a mail backend. Phase 2
 * drives this entirely through `tests/helpers/fakeTransport.ts`; Phase 3
 * implements it against real IMAP/SMTP.
 */
export interface MailTransport {
  fetchSince(mailbox: string, uidValidity: string, sinceUid: number): Promise<IncomingMail[]>;
  send(mail: OutboundMail): Promise<SendReceipt>;
  markProcessed(mail: IncomingMail): Promise<void>;
  close(): Promise<void>;
}
