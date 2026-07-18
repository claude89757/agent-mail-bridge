import { describe, expect, it } from 'vitest';

import {
  checkDkimFactor,
  parseAllAuthenticationResults,
  parseAuthenticationResults,
} from '../../src/domain/authResults.js';
import type { ParsedAuthResults } from '../../src/domain/authResults.js';

// Guards decision D-P3P-1 / security control C2 (spec §3.3 control 2): the
// deterministic half of the DKIM provider-authentication factor. A forged
// `From: you@example.com` cannot obtain a valid DKIM signature for
// example.com; Gmail (and many providers) publish DMARC p=none, so nothing
// upstream rejects the forgery for us — this module's verdict is the check.
//
// Fixtures use placeholder domains only (example.com / example.net —
// RFC 2606 reserved), per the public-repo rule: no real mailbox addresses or
// domains in git. example.com plays "self"; example.net plays "some other
// real domain" (a relay/forwarder signer, not necessarily an attacker).
const SELF_DOMAIN = 'example.com';

describe('parseAuthenticationResults (D-P3P-1, control C2)', () => {
  it('extracts authservId and a dkim pass with header.d from a realistic Gmail-shaped header', () => {
    const raw =
      'mx.google.com;\n' +
      '       dkim=pass header.d=example.com header.i=@mail.example.com header.s=20230601 header.b=AbCd1234;\n' +
      '       spf=pass (google.com: domain of bridge-user@example.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=bridge-user@example.com;\n' +
      '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com';

    const result = parseAuthenticationResults(raw);

    expect(result.authservId).toBe('mx.google.com');
    expect(result.dkim).toEqual([{ result: 'pass', domain: 'example.com' }]);
  });

  it('falls back to the after-@ part of header.i when header.d is absent', () => {
    const raw = 'mx.google.com; dkim=pass header.i=@example.com header.s=20230601 header.b=AbCd1234';

    const result = parseAuthenticationResults(raw);

    expect(result.dkim).toEqual([{ result: 'pass', domain: 'example.com' }]);
  });

  it('prefers header.d over header.i when both are present on the same resinfo', () => {
    const raw = 'mx.example.com; dkim=pass header.d=example.com header.i=@mail.example.com';

    const result = parseAuthenticationResults(raw);

    expect(result.dkim).toEqual([{ result: 'pass', domain: 'example.com' }]);
  });

  it('extracts only dkim resinfos from a multi-method header (spf + dkim + dmarc)', () => {
    const raw =
      'mx.example.com; ' +
      'spf=pass smtp.mailfrom=bridge-user@example.com; ' +
      'dkim=pass header.d=example.com; ' +
      'dmarc=pass header.from=example.com';

    const result = parseAuthenticationResults(raw);

    expect(result.dkim).toEqual([{ result: 'pass', domain: 'example.com' }]);
  });

  it('parses multiple dkim signatures in one header with different domains', () => {
    const raw = 'mx.example.com; dkim=pass header.d=example.com; dkim=pass header.d=example.net';

    const result = parseAuthenticationResults(raw);

    expect(result.dkim).toEqual([
      { result: 'pass', domain: 'example.com' },
      { result: 'pass', domain: 'example.net' },
    ]);
  });

  it('normalizes method, result and header.d casing to lowercase', () => {
    const raw = 'mx.example.com; DKIM=PASS header.d=EXAMPLE.COM';

    const result = parseAuthenticationResults(raw);

    expect(result.dkim).toEqual([{ result: 'pass', domain: 'example.com' }]);
  });

  it('drops broken fragments (stray dkim=, garbage tokens, unterminated comment) without throwing, while well-formed parts still parse', () => {
    const raw =
      'mx.example.com; dkim=pass header.d=example.com; dkim=; garbage token here; ' +
      'spf=pass (this comment is never closed so it swallows the rest of the header';

    expect(() => parseAuthenticationResults(raw)).not.toThrow();

    const result = parseAuthenticationResults(raw);
    expect(result.authservId).toBe('mx.example.com');
    expect(result.dkim).toEqual([{ result: 'pass', domain: 'example.com' }]);
  });

  it('returns null authservId and an empty dkim array for an empty string', () => {
    const result = parseAuthenticationResults('');

    expect(result).toEqual({ authservId: null, dkim: [] });
  });

  it('returns an empty dkim array when the header has other methods but no dkim', () => {
    const raw =
      'mx.example.com; spf=pass smtp.mailfrom=bridge-user@example.com; dmarc=pass header.from=example.com';

    const result = parseAuthenticationResults(raw);

    expect(result.dkim).toEqual([]);
  });

  it('strips a single-level parenthesized comment before tokenizing', () => {
    const raw = 'mx.example.com; dkim=pass (good signature) header.d=example.com';

    const result = parseAuthenticationResults(raw);

    expect(result.dkim).toEqual([{ result: 'pass', domain: 'example.com' }]);
  });

  it('strips nested parenthesized comments in one pass', () => {
    const raw = 'mx.example.com; dkim=pass (outer (nested) comment) header.d=example.com';

    const result = parseAuthenticationResults(raw);

    expect(result.dkim).toEqual([{ result: 'pass', domain: 'example.com' }]);
  });
});

describe('parseAllAuthenticationResults (D-P3P-1)', () => {
  it('parses each raw header independently, preserving order', () => {
    const raws = [
      'mx.example.com; dkim=pass header.d=example.com',
      'relay.example.net; dkim=fail header.d=example.net',
    ];

    const result = parseAllAuthenticationResults(raws);

    expect(result).toEqual([
      { authservId: 'mx.example.com', dkim: [{ result: 'pass', domain: 'example.com' }] },
      { authservId: 'relay.example.net', dkim: [{ result: 'fail', domain: 'example.net' }] },
    ]);
  });

  it('returns an empty array for an empty input list', () => {
    expect(parseAllAuthenticationResults([])).toEqual([]);
  });
});

// checkDkimFactor tests construct ParsedAuthResults literals directly rather
// than routing through parseAuthenticationResults: the verdict's own logic
// (reason priority, exact-match alignment) is the unit under test here, kept
// independent of parser correctness (covered above).
describe('checkDkimFactor (D-P3P-1, control C2 verdict)', () => {
  it('rejects with NO_AUTH_RESULTS when there are no parsed headers at all', () => {
    const result = checkDkimFactor([], SELF_DOMAIN);

    expect(result).toEqual({ ok: false, reason: 'NO_AUTH_RESULTS' });
  });

  it('rejects with NO_DKIM_PASS when headers exist but no dkim result is pass', () => {
    const parsed: ParsedAuthResults[] = [
      { authservId: 'mx.example.com', dkim: [{ result: 'fail', domain: SELF_DOMAIN }] },
    ];

    const result = checkDkimFactor(parsed, SELF_DOMAIN);

    expect(result).toEqual({ ok: false, reason: 'NO_DKIM_PASS' });
  });

  it('rejects with DOMAIN_MISMATCH when a dkim pass exists but its domain differs from selfDomain', () => {
    const parsed: ParsedAuthResults[] = [
      { authservId: 'mx.example.net', dkim: [{ result: 'pass', domain: 'example.net' }] },
    ];

    const result = checkDkimFactor(parsed, SELF_DOMAIN);

    expect(result).toEqual({ ok: false, reason: 'DOMAIN_MISMATCH' });
  });

  it('passes with matchedDomain when a dkim pass aligns exactly with selfDomain', () => {
    const parsed: ParsedAuthResults[] = [
      { authservId: 'mx.example.com', dkim: [{ result: 'pass', domain: SELF_DOMAIN }] },
    ];

    const result = checkDkimFactor(parsed, SELF_DOMAIN);

    expect(result).toEqual({ ok: true, matchedDomain: SELF_DOMAIN });
  });

  it('matches selfDomain case-insensitively', () => {
    const parsed: ParsedAuthResults[] = [
      { authservId: 'mx.example.com', dkim: [{ result: 'pass', domain: 'example.com' }] },
    ];

    const result = checkDkimFactor(parsed, 'Example.COM');

    expect(result).toEqual({ ok: true, matchedDomain: 'example.com' });
  });

  // Central security regression this task exists to pin (spec §3.3 control 2 /
  // threat model §5 C2: "better to reject genuine than accept forged").
  // Exact string equality only — neither containment direction is accepted.
  it('rejects a subdomain resinfo domain as DOMAIN_MISMATCH (fail-closed regression pin)', () => {
    const parsed: ParsedAuthResults[] = [
      { authservId: 'mx.example.com', dkim: [{ result: 'pass', domain: 'mail.example.com' }] },
    ];

    const result = checkDkimFactor(parsed, 'example.com');

    expect(result).toEqual({ ok: false, reason: 'DOMAIN_MISMATCH' });
  });

  it('rejects when selfDomain is the more specific subdomain (still exact-match only)', () => {
    const parsed: ParsedAuthResults[] = [
      { authservId: 'mx.example.com', dkim: [{ result: 'pass', domain: 'example.com' }] },
    ];

    const result = checkDkimFactor(parsed, 'mail.example.com');

    expect(result).toEqual({ ok: false, reason: 'DOMAIN_MISMATCH' });
  });

  it('passes when only the second of several parsed headers has a qualifying resinfo (forwarding chain)', () => {
    const parsed: ParsedAuthResults[] = [
      { authservId: 'relay.example.net', dkim: [{ result: 'fail', domain: 'example.net' }] },
      { authservId: 'mx.example.com', dkim: [{ result: 'pass', domain: SELF_DOMAIN }] },
    ];

    const result = checkDkimFactor(parsed, SELF_DOMAIN);

    expect(result).toEqual({ ok: true, matchedDomain: SELF_DOMAIN });
  });

  it('rejects with NO_DKIM_PASS (not DOMAIN_MISMATCH) when multiple headers exist but none has a pass', () => {
    const parsed: ParsedAuthResults[] = [
      { authservId: 'relay.example.net', dkim: [] },
      { authservId: 'mx.example.com', dkim: [{ result: 'fail', domain: SELF_DOMAIN }] },
    ];

    const result = checkDkimFactor(parsed, SELF_DOMAIN);

    expect(result).toEqual({ ok: false, reason: 'NO_DKIM_PASS' });
  });
});
