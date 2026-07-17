import { describe, expect, it } from 'vitest';

import { classifyEcho } from '../../src/domain/echo.js';
import { normalizeMessageId } from '../../src/domain/mail.js';

// Guards decision D-P2-4 / security control C3: the loop guard that stops
// the bridge's own outbound replies from being re-ingested as new commands.
describe('classifyEcho (D-P2-4, control C3)', () => {
  it('classifies as echo when the outbox header value matches a known outbox id', () => {
    const result = classifyEcho(
      { messageId: null, outboxHeaderValue: 'nonce-123' },
      {
        isKnownOutboxId: (id) => id === 'nonce-123',
        isKnownOutboxMessageId: () => false,
      },
    );

    expect(result).toBe(true);
  });

  it('classifies as echo when the normalized Message-ID matches a known outbox message id', () => {
    const result = classifyEcho(
      { messageId: normalizeMessageId('<reply@bridge>'), outboxHeaderValue: null },
      {
        isKnownOutboxId: () => false,
        isKnownOutboxMessageId: (messageId) => messageId === 'reply@bridge',
      },
    );

    expect(result).toBe(true);
  });

  it('classifies as not echo when neither factor matches', () => {
    const result = classifyEcho(
      { messageId: normalizeMessageId('unrelated@mail'), outboxHeaderValue: 'unrelated-nonce' },
      {
        isKnownOutboxId: () => false,
        isKnownOutboxMessageId: () => false,
      },
    );

    expect(result).toBe(false);
  });

  it('does not treat an unknown x-amb-outbox-id header as proof of echo', () => {
    // An attacker can forge this header on inbound mail; only a nonce we
    // ourselves recorded before sending counts. An unknown nonce must fail
    // closed to "not echo" — treating it as echo would let an
    // attacker-controlled header alone get mail silently dropped.
    const result = classifyEcho(
      { messageId: null, outboxHeaderValue: 'attacker-forged-nonce' },
      {
        isKnownOutboxId: () => false,
        isKnownOutboxMessageId: () => false,
      },
    );

    expect(result).toBe(false);
  });

  it('treats a null messageId as a non-matching factor without calling its predicate', () => {
    const result = classifyEcho(
      { messageId: null, outboxHeaderValue: null },
      {
        isKnownOutboxId: () => false,
        isKnownOutboxMessageId: () => {
          throw new Error('must not be called with null');
        },
      },
    );

    expect(result).toBe(false);
  });

  it('treats a null outboxHeaderValue as a non-matching factor without calling its predicate', () => {
    const result = classifyEcho(
      { messageId: normalizeMessageId('known@mail'), outboxHeaderValue: null },
      {
        isKnownOutboxId: () => {
          throw new Error('must not be called with null');
        },
        isKnownOutboxMessageId: (messageId) => messageId === 'known@mail',
      },
    );

    expect(result).toBe(true);
  });

  it('treats undefined factors like null (upstream parsers may yield either)', () => {
    // A headers map lookup for an absent header yields undefined, not null;
    // both must mean "factor does not match" and must never reach a lookup.
    const result = classifyEcho(
      { messageId: undefined, outboxHeaderValue: undefined },
      {
        isKnownOutboxId: () => {
          throw new Error('must not be called with undefined');
        },
        isKnownOutboxMessageId: () => {
          throw new Error('must not be called with undefined');
        },
      },
    );

    expect(result).toBe(false);
  });
});
