import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { deriveIntentId, normalizeMessageId, syntheticMessageKey } from '../../src/domain/mail.js';
import type { NormalizedMessageId } from '../../src/domain/mail.js';

// The single sanctioned bridge from a raw test fixture to the branded type:
// always through the real normalizer, never a bare cast.
function normalized(raw: string): NormalizedMessageId {
  const id = normalizeMessageId(raw);
  if (id === null) {
    throw new Error(`test fixture is not a normalizable Message-ID: ${JSON.stringify(raw)}`);
  }
  return id;
}

// Guards decision D-P2-1: Message-ID normalization is the idempotency key
// for inbound mail ingest — get this wrong and duplicate delivery creates
// duplicate commands.
describe('normalizeMessageId (D-P2-1)', () => {
  it('strips a single pair of angle brackets', () => {
    expect(normalizeMessageId('<a@b>')).toBe('a@b');
  });

  it('trims surrounding whitespace before stripping brackets', () => {
    expect(normalizeMessageId('  <a@b>  ')).toBe('a@b');
  });

  it('leaves an already-bare id untouched', () => {
    expect(normalizeMessageId('a@b')).toBe('a@b');
  });

  it('preserves case', () => {
    expect(normalizeMessageId('<Foo.Bar@Example.COM>')).toBe('Foo.Bar@Example.COM');
  });

  it('rejects an empty string', () => {
    expect(normalizeMessageId('')).toBeNull();
  });

  it('rejects whitespace-only input', () => {
    expect(normalizeMessageId('   ')).toBeNull();
    expect(normalizeMessageId('\t\n')).toBeNull();
  });

  it('rejects an empty angle-bracket pair', () => {
    expect(normalizeMessageId('<>')).toBeNull();
  });

  it('rejects a value with no @', () => {
    expect(normalizeMessageId('no-at')).toBeNull();
  });

  it('rejects degenerate ids whose @ lacks content on either side', () => {
    // Accepting these would collapse DISTINCT malformed-but-real mails onto
    // one shared idempotency key, silently swallowing later commands as
    // "duplicates" — they must fall through to the synthetic per-UID key.
    expect(normalizeMessageId('@')).toBeNull();
    expect(normalizeMessageId('<@>')).toBeNull();
    expect(normalizeMessageId('a@')).toBeNull();
    expect(normalizeMessageId('@b')).toBeNull();
    expect(normalizeMessageId(' @ ')).toBeNull();
  });

  it('strips only ONE outer angle-bracket pair', () => {
    expect(normalizeMessageId('<<a@b>>')).toBe('<a@b>');
  });

  it('leaves unpaired outer brackets untouched', () => {
    expect(normalizeMessageId('<a@b')).toBe('<a@b');
    expect(normalizeMessageId('a@b>')).toBe('a@b>');
  });

  it('leaves mid-string brackets untouched', () => {
    expect(normalizeMessageId('a<b@c>d')).toBe('a<b@c>d');
  });

  it('passes null through as null', () => {
    expect(normalizeMessageId(null)).toBeNull();
  });

  it('treats undefined like null (upstream parsers may yield either)', () => {
    expect(normalizeMessageId(undefined)).toBeNull();
  });
});

// Guards the synthetic fallback key used when inbound mail has no usable
// Message-ID, so rejected mail is still idempotent per UID (D-P2-1).
describe('syntheticMessageKey (D-P2-1 fallback)', () => {
  it('formats as synthetic:<uidValidity>:<uid>', () => {
    expect(syntheticMessageKey('12345', 67)).toBe('synthetic:12345:67');
  });

  it('keeps uidValidity and uid in the documented order (does not transpose them)', () => {
    expect(syntheticMessageKey('67', 12345)).toBe('synthetic:67:12345');
  });
});

// Guards deterministic dispatch-intent id derivation: creating an intent
// twice for the same normalized Message-ID must be idempotent.
describe('deriveIntentId', () => {
  it('returns "di-" followed by 16 hex characters', () => {
    expect(deriveIntentId(normalized('a@b'))).toMatch(/^di-[0-9a-f]{16}$/);
  });

  it('matches the externally verified sha256 vector for "a@b"', () => {
    // Verified out-of-band: printf 'a@b' | shasum -a 256 | cut -c1-16
    expect(deriveIntentId(normalized('a@b'))).toBe('di-7508d8b5018ea640');
  });

  it('matches "di-" + first 16 hex chars of the sha256 digest of the input', () => {
    const expected = `di-${createHash('sha256').update('a@b').digest('hex').slice(0, 16)}`;

    expect(deriveIntentId(normalized('a@b'))).toBe(expected);
  });

  it('is deterministic: the same input yields the same id', () => {
    expect(deriveIntentId(normalized('same@id'))).toBe(deriveIntentId(normalized('same@id')));
  });

  it('produces different ids for different input', () => {
    expect(deriveIntentId(normalized('one@id'))).not.toBe(deriveIntentId(normalized('two@id')));
  });

  it('rejects raw strings and synthetic keys at the type level (brand)', () => {
    // @ts-expect-error a raw, un-normalized string must not reach deriveIntentId
    const fromRaw: string = deriveIntentId('raw@string');
    // @ts-expect-error synthetic per-UID keys are not Message-IDs and derive no intent
    const fromSynthetic: string = deriveIntentId(syntheticMessageKey('123', 45));

    // The brand is compile-time only; runtime stays well-defined.
    expect(fromRaw).toMatch(/^di-[0-9a-f]{16}$/);
    expect(fromSynthetic).toMatch(/^di-[0-9a-f]{16}$/);
  });
});
