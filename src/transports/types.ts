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
  /**
   * Header names lowercased; each value is every same-name header instance,
   * in occurrence order (decision D-P3B2-1). A single-value map would
   * silently drop evidence: `Authentication-Results` legitimately appears
   * once per forwarding hop, and `parseAllAuthenticationResults`
   * (`src/domain/authResults.ts` — the deterministic half of security
   * control C2's DKIM-alignment check) takes exactly a `readonly string[]`
   * of raw header values so it can inspect every hop's verdict, not just
   * whichever instance happened to overwrite the others in a single-value
   * map. Pre-1.0 internal seam: this is a direct change to the field's
   * shape, not a compatibility shim or a second parallel field — see
   * D-P3B2-1 in
   * docs/superpowers/plans/2026-07-19-phase-3-batch2-imap-read-path.md.
   */
  headers: ReadonlyMap<string, readonly string[]>;
  /** Parsed addr-spec strings (no display names). */
  from: readonly string[];
  to: readonly string[];
  cc: readonly string[];
  /**
   * Decoded plain-text body (decision D-P4B10-1): the text/plain part when
   * one exists, else mailparser's default html-to-text `text` behavior.
   * Download or parse failure ⇒ `null` — fail OPEN to "no body", never a
   * throw: the body is enhancement information (the eventual command
   * prompt) while headers/uid are the pipeline's skeleton, so a mail whose
   * body cannot be read still flows through the echo/identity/window gates,
   * and one broken MIME tree must not poison the whole fetch batch. Direct
   * shape change to this pre-1.0 internal seam (D-P3B2-1 precedent), not a
   * parallel field or compatibility shim. Full fail-open-vs-fail-closed
   * rationale: `resolveBodyText` in `src/transports/imapRead.ts`.
   */
  bodyText: string | null;
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
  /**
   * Current mailbox state (decision D-P4B11-1, direct pre-1.0 seam change —
   * D-P3B2-1 precedent): the daemon's mail tick reads `uidValidity` FIRST,
   * keys its stored watermark on it, and thereby detects a UIDVALIDITY
   * change (new key ⇒ watermark 0 ⇒ bounded full rescan, converging via
   * ingest idempotency + the readyAt fence). Read-only: implementations must
   * not mutate any mailbox state answering this.
   */
  mailboxStatus(mailbox: string): Promise<{ uidValidity: string; uidNext: number }>;
  close(): Promise<void>;
}
