/**
 * Transport-layer error types (D-P3B2-5). Errors here describe a real mail
 * backend behaving unexpectedly (protocol-level facts: a mailbox's
 * identity changed underneath us) — NOT an illegal application state-machine
 * transition, which is what `src/domain/errors.ts`'s `IllegalTransitionError`
 * is for. Kept in a separate file on purpose: `domain/` guard functions
 * throwing/consuming transport errors would give domain code a reason to
 * know IMAP exists, and `domain/` must stay IO-free (see
 * `src/domain/README.md`) and free of even a type-level dependency on any
 * transport.
 */

/**
 * Thrown by `createImapReadTransport`'s `fetchSince` (D-P3B2-3 step 2) when
 * the mailbox's live UIDVALIDITY no longer matches the value the caller
 * persisted from a prior run. Per RFC 3501 S:2.3.1.1, a server MAY reassign
 * UIDs after a UIDVALIDITY change — every uid the caller has on file is
 * potentially meaningless once this fires. This is a FAIL-CLOSED guard: the
 * transport reports the mismatch and stops (it releases the mailbox lock
 * and logs out before throwing); deciding how to recover — spec S:3.2's
 * bounded rescan from uid 1 — is an application-layer policy choice this
 * error deliberately does not make.
 */
export class UidValidityChangedError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(details: { expected: string; actual: string }) {
    super(`UIDVALIDITY changed: expected ${details.expected}, got ${details.actual}`);
    this.name = 'UidValidityChangedError';
    this.expected = details.expected;
    this.actual = details.actual;
  }
}
