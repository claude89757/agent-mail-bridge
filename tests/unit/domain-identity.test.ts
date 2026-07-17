import { describe, expect, it } from 'vitest';

import { checkIdentityC1 } from '../../src/domain/identity.js';

// Placeholder self address for every test in this file (public-repo rule:
// no real mailbox addresses in git). Attacker/other addresses use the
// reserved example.net domain to read as clearly "not self" at a glance.
const SELF = 'bridge-user@example.com';

// Guards decision D-P2-5 / security control C1: the deterministic half of
// strict self-addressing. Only the shape/address checks live here — DKIM
// alignment (control C2) is Phase 3 and is out of scope for this gate.
describe('checkIdentityC1 (D-P2-5, control C1)', () => {
  it('passes when From and To both exactly equal self and Cc is empty', () => {
    const result = checkIdentityC1({ from: [SELF], to: [SELF], cc: [] }, SELF);

    expect(result).toEqual({ ok: true });
  });

  it('passes on a case-insensitive match against self', () => {
    const result = checkIdentityC1(
      { from: ['Bridge-User@Example.COM'], to: ['BRIDGE-USER@EXAMPLE.COM'], cc: [] },
      SELF,
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects with IDENTITY_MULTI_RECIPIENT when there are two From addresses', () => {
    const result = checkIdentityC1(
      { from: [SELF, 'attacker@example.net'], to: [SELF], cc: [] },
      SELF,
    );

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_MULTI_RECIPIENT' });
  });

  it('rejects with IDENTITY_MULTI_RECIPIENT when there are two To addresses', () => {
    const result = checkIdentityC1(
      { from: [SELF], to: [SELF, 'attacker@example.net'], cc: [] },
      SELF,
    );

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_MULTI_RECIPIENT' });
  });

  it('rejects with IDENTITY_MULTI_RECIPIENT when To is empty', () => {
    const result = checkIdentityC1({ from: [SELF], to: [], cc: [] }, SELF);

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_MULTI_RECIPIENT' });
  });

  it('rejects with IDENTITY_MULTI_RECIPIENT when From is empty', () => {
    // Not explicitly called out in the task's example list, but D-P2-5 pins
    // this: the check is "count !== 1", which covers empty-From exactly
    // like empty-To, two-From and two-To — no separate reason exists for it.
    const result = checkIdentityC1({ from: [], to: [SELF], cc: [] }, SELF);

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_MULTI_RECIPIENT' });
  });

  it('rejects with IDENTITY_CC when there is any Cc address', () => {
    const result = checkIdentityC1(
      { from: [SELF], to: [SELF], cc: ['observer@example.net'] },
      SELF,
    );

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_CC' });
  });

  it('rejects with IDENTITY_PLUS_TAG when From carries a plus-tag and self is configured without one', () => {
    const result = checkIdentityC1(
      { from: ['bridge-user+tag@example.com'], to: [SELF], cc: [] },
      SELF,
    );

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_PLUS_TAG' });
  });

  it('rejects with IDENTITY_PLUS_TAG when To carries a plus-tag and self is configured without one', () => {
    const result = checkIdentityC1(
      { from: [SELF], to: ['bridge-user+tag@example.com'], cc: [] },
      SELF,
    );

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_PLUS_TAG' });
  });

  it('does NOT treat a + in the DOMAIN part as a plus-tag', () => {
    // The plus-tag rule is about local-part aliasing only; a "+" after the
    // "@" is not an alias mechanism and must not trip PLUS_TAG.
    const domainPlusSelf = 'user@ex+ample.com';

    const result = checkIdentityC1(
      { from: [domainPlusSelf], to: [domainPlusSelf], cc: [] },
      domainPlusSelf,
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects with IDENTITY_FROM when From does not match self', () => {
    const result = checkIdentityC1({ from: ['attacker@example.net'], to: [SELF], cc: [] }, SELF);

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_FROM' });
  });

  it('rejects with IDENTITY_TO when To does not match self', () => {
    const result = checkIdentityC1({ from: [SELF], to: ['attacker@example.net'], cc: [] }, SELF);

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_TO' });
  });

  it('rejects with IDENTITY_PLUS_TAG even when the configured self address itself carries a plus-tag', () => {
    // Misconfiguration edge case: if the OPERATOR configures selfAddress
    // with a "+" in it, a mail that matches it exactly must still fail
    // closed as PLUS_TAG rather than pass — v0.1 rejects plus-tags
    // unconditionally, it does not special-case "but that's what's configured".
    const misconfiguredSelf = 'bridge-user+tag@example.com';

    const result = checkIdentityC1(
      { from: [misconfiguredSelf], to: [misconfiguredSelf], cc: [] },
      misconfiguredSelf,
    );

    expect(result).toEqual({ ok: false, reason: 'IDENTITY_PLUS_TAG' });
  });

  // A blank configured self address is a config error, never a comparison
  // target: without the guard, '' === '' would let mail with empty-string
  // addresses pass the gate (fail open, found in review).
  describe('selfAddress config guard (fail closed on blank config)', () => {
    it('throws on an empty selfAddress instead of matching empty-string mail addresses', () => {
      // Exact fail-open repro from review: this returned { ok: true }.
      expect(() => checkIdentityC1({ from: [''], to: [''], cc: [] }, '')).toThrow(
        'selfAddress must not be blank',
      );
    });

    it('throws on a whitespace-only selfAddress', () => {
      expect(() => checkIdentityC1({ from: [SELF], to: [SELF], cc: [] }, '   ')).toThrow(
        'selfAddress must not be blank',
      );
    });

    it('validates selfAddress before any mail-shape check', () => {
      // A config error must surface loudly on the first call, not only for
      // mail that happens to reach the equality stage.
      expect(() => checkIdentityC1({ from: [], to: [], cc: [] }, '')).toThrow(
        'selfAddress must not be blank',
      );
    });

    it('rejects empty-string mail addresses via IDENTITY_FROM when self is valid', () => {
      const result = checkIdentityC1({ from: [''], to: [''], cc: [] }, SELF);

      expect(result).toEqual({ ok: false, reason: 'IDENTITY_FROM' });
    });

    it('trims surrounding whitespace off the configured selfAddress before comparing', () => {
      const result = checkIdentityC1(
        { from: [SELF], to: [SELF], cc: [] },
        '  Bridge-User@Example.COM  ',
      );

      expect(result).toEqual({ ok: true });
    });
  });

  // The following pin the EXACT priority order from D-P2-5 — each case is
  // built so two different failures both apply, and asserts which reason
  // wins. Getting this order wrong silently changes commands.status_reason
  // once Task 8 wires this gate into ingest.
  describe('reason priority order (D-P2-5: MULTI_RECIPIENT > CC > PLUS_TAG > FROM > TO)', () => {
    it('prioritizes IDENTITY_MULTI_RECIPIENT over IDENTITY_CC', () => {
      const result = checkIdentityC1(
        { from: [SELF, 'attacker@example.net'], to: [SELF], cc: ['observer@example.net'] },
        SELF,
      );

      expect(result).toEqual({ ok: false, reason: 'IDENTITY_MULTI_RECIPIENT' });
    });

    it('prioritizes IDENTITY_CC over IDENTITY_PLUS_TAG', () => {
      const result = checkIdentityC1(
        { from: ['bridge-user+tag@example.com'], to: [SELF], cc: ['observer@example.net'] },
        SELF,
      );

      expect(result).toEqual({ ok: false, reason: 'IDENTITY_CC' });
    });

    it('prioritizes IDENTITY_PLUS_TAG over IDENTITY_FROM', () => {
      const result = checkIdentityC1(
        { from: ['attacker+tag@example.net'], to: [SELF], cc: [] },
        SELF,
      );

      expect(result).toEqual({ ok: false, reason: 'IDENTITY_PLUS_TAG' });
    });

    it('prioritizes IDENTITY_FROM over IDENTITY_TO', () => {
      const result = checkIdentityC1(
        { from: ['attacker@example.net'], to: ['someone-else@example.net'], cc: [] },
        SELF,
      );

      expect(result).toEqual({ ok: false, reason: 'IDENTITY_FROM' });
    });
  });
});
