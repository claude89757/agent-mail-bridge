import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { deriveIntentId, normalizeMessageId, syntheticMessageKey } from '../../src/domain/mail.js';

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

  it('rejects an empty angle-bracket pair', () => {
    expect(normalizeMessageId('<>')).toBeNull();
  });

  it('rejects a value with no @', () => {
    expect(normalizeMessageId('no-at')).toBeNull();
  });

  it('strips only ONE outer angle-bracket pair', () => {
    expect(normalizeMessageId('<<a@b>>')).toBe('<a@b>');
  });

  it('passes null through as null', () => {
    expect(normalizeMessageId(null)).toBeNull();
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
    expect(deriveIntentId('a@b')).toMatch(/^di-[0-9a-f]{16}$/);
  });

  it('matches "di-" + first 16 hex chars of the sha256 digest of the input', () => {
    const expected = `di-${createHash('sha256').update('a@b').digest('hex').slice(0, 16)}`;

    expect(deriveIntentId('a@b')).toBe(expected);
  });

  it('is deterministic: the same input yields the same id', () => {
    expect(deriveIntentId('same@id')).toBe(deriveIntentId('same@id'));
  });

  it('produces different ids for different input', () => {
    expect(deriveIntentId('one@id')).not.toBe(deriveIntentId('two@id'));
  });
});
