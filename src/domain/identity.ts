/**
 * Identity gate (decision D-P2-5, security control C1): the deterministic
 * half of strict self-addressing. Rejects any inbound mail whose envelope
 * shape or addresses are not exactly "self talking to self, alone" — the
 * provider-authentication half (`Authentication-Results` / DKIM alignment,
 * control C2) waits on P0-3 and lands in Phase 3; it is NOT checked here.
 *
 * No IO: `checkIdentityC1` is a pure function of its arguments. Addresses
 * arrive already parsed as addr-spec strings (e.g. `bridge-user@example.com`
 * — no display names, no angle brackets); parsing the raw header is the
 * caller's job.
 */

/** The three address lists a piece of inbound mail is checked against. */
export interface IdentityMailInput {
  /** `From` addr-specs, already parsed. Passing requires exactly one. */
  readonly from: readonly string[];
  /** `To` addr-specs, already parsed. Passing requires exactly one. */
  readonly to: readonly string[];
  /** `Cc` addr-specs, already parsed. Passing requires zero. */
  readonly cc: readonly string[];
}

/**
 * Reasons `checkIdentityC1` can reject mail for. These exact strings become
 * `commands.status_reason` values once ingest (Task 8) wires this gate in —
 * do not rename them.
 */
export type IdentityReason =
  | 'IDENTITY_MULTI_RECIPIENT'
  | 'IDENTITY_CC'
  | 'IDENTITY_PLUS_TAG'
  | 'IDENTITY_FROM'
  | 'IDENTITY_TO';

export type IdentityVerdict = { ok: true } | { ok: false; reason: IdentityReason };

/**
 * Addr-spec local part: everything before the FIRST `@`. Real addr-specs
 * handed to this module never contain more than one `@` (that is the
 * caller's parser's job to guarantee), so "first" and "only" coincide here;
 * this function does not re-validate that assumption.
 */
function localPart(address: string): string {
  const at = address.indexOf('@');
  return at === -1 ? address : address.slice(0, at);
}

/**
 * Checks control C1's deterministic half. Pass iff: exactly one `From`,
 * exactly one `To`, zero `Cc`, neither address's local part contains a `+`
 * (v0.1 rejects plus-tag aliasing outright; a `+` in the DOMAIN part is not
 * an alias mechanism and does not count), and both `From` and `To` equal
 * `selfAddress` case-insensitively. `selfAddress` is trimmed before use and
 * MUST NOT be blank — a blank value throws (config error) rather than ever
 * becoming a comparison target, since `'' === ''` would otherwise let mail
 * with empty-string addresses pass the gate (fail open).
 *
 * Comparison is byte-wise after lowercasing; there is deliberately NO
 * Unicode/NFC normalization in v0.1 — homograph or NFC-variant addresses
 * simply never compare equal to self and are rejected (fail closed).
 *
 * The FIRST failing check decides `reason`, in this fixed priority order
 * (D-P2-5): MULTI_RECIPIENT → CC → PLUS_TAG → FROM → TO.
 *
 * - MULTI_RECIPIENT is "count !== 1" for either list, so it covers
 *   two-From, two-To, empty-From and empty-To alike — there is no separate
 *   reason for "missing" versus "duplicated".
 * - PLUS_TAG is checked structurally (does From or To contain a `+` in its
 *   local part) BEFORE either is compared against `selfAddress`. So even if
 *   `selfAddress` itself is misconfigured with a `+`, mail that matches it
 *   exactly still fails closed as PLUS_TAG — a `+` address can never reach
 *   the FROM/TO equality checks and pass.
 */
export function checkIdentityC1(mail: IdentityMailInput, selfAddress: string): IdentityVerdict {
  // Validated BEFORE any mail-shape check so a broken config surfaces loudly
  // on the first call, not only for mail that reaches the equality stage.
  // toLowerCase, NOT toLocaleLowerCase: a security gate's verdict must be
  // locale-independent (under a Turkish locale, dotted/dotless-i folding
  // would change comparison results per process locale).
  const self = selfAddress.trim().toLowerCase();
  if (self.length === 0) {
    throw new Error('checkIdentityC1: selfAddress must not be blank');
  }

  if (mail.from.length !== 1 || mail.to.length !== 1) {
    return { ok: false, reason: 'IDENTITY_MULTI_RECIPIENT' };
  }

  if (mail.cc.length > 0) {
    return { ok: false, reason: 'IDENTITY_CC' };
  }

  const hasPlusTag = (address: string): boolean => localPart(address).includes('+');
  if (mail.from.some(hasPlusTag) || mail.to.some(hasPlusTag)) {
    return { ok: false, reason: 'IDENTITY_PLUS_TAG' };
  }

  const matchesSelf = (address: string): boolean => address.toLowerCase() === self;

  if (!mail.from.every(matchesSelf)) {
    return { ok: false, reason: 'IDENTITY_FROM' };
  }

  if (!mail.to.every(matchesSelf)) {
    return { ok: false, reason: 'IDENTITY_TO' };
  }

  return { ok: true };
}
