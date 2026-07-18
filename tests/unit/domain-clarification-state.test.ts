import { describe, expect, it } from 'vitest';

import {
  assertClarificationTransition,
  checkClarificationBinding,
  CLARIFICATION_STATUSES,
  CLARIFICATION_TRANSITIONS,
  type ClarificationRecordView,
  type ClarificationStatus,
  type ExtractedReplyBinding,
} from '../../src/domain/clarificationState.js';
import { IllegalTransitionError } from '../../src/domain/errors.js';

// Guards decisions D-P4B4-1 (state machine) and D-P4B4-2 (four-factor
// binding check) from
// docs/superpowers/plans/2026-07-19-phase-4-batch4-clarification-binding.md
// — the deterministic half of threat-model control C8 ("clarification
// replies must match token + thread + candidate-set version and TTL",
// docs/threat-model.md). The state-machine half is isomorphic in
// verification strategy to domain-state-machines.test.ts's command/outbox
// machines and domain-intent-state.test.ts's intent machine: same
// IllegalTransitionError shape, same map-as-data + full-matrix-scan test
// structure — this is the fourth machine in the bridge.

describe('clarification state machine (D-P4B4-1)', () => {
  it('CLARIFICATION_STATUSES contains exactly the four clarification statuses', () => {
    expect(new Set(CLARIFICATION_STATUSES)).toEqual(
      new Set<ClarificationStatus>(['PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED']),
    );
  });

  describe('legal edges (D-P4B4-1)', () => {
    it('PENDING -> CONSUMED does not throw (a valid reply bound)', () => {
      expect(() => assertClarificationTransition('PENDING', 'CONSUMED')).not.toThrow();
    });

    it('PENDING -> EXPIRED does not throw (TTL passed)', () => {
      expect(() => assertClarificationTransition('PENDING', 'EXPIRED')).not.toThrow();
    });

    it('PENDING -> SUPERSEDED does not throw (a newer candidate set was issued)', () => {
      expect(() => assertClarificationTransition('PENDING', 'SUPERSEDED')).not.toThrow();
    });
  });

  describe('illegal transitions', () => {
    it('throws on PENDING -> PENDING (no self-transitions are modeled)', () => {
      expect(() => assertClarificationTransition('PENDING', 'PENDING')).toThrow(
        IllegalTransitionError,
      );
    });

    it('throws on CONSUMED -> anything (terminal state, a bound reply never unbinds)', () => {
      expect(() => assertClarificationTransition('CONSUMED', 'PENDING')).toThrow(
        IllegalTransitionError,
      );
      expect(() => assertClarificationTransition('CONSUMED', 'EXPIRED')).toThrow(
        IllegalTransitionError,
      );
      expect(() => assertClarificationTransition('CONSUMED', 'SUPERSEDED')).toThrow(
        IllegalTransitionError,
      );
    });

    it('throws on EXPIRED -> anything (terminal state, an expired record never revives)', () => {
      expect(() => assertClarificationTransition('EXPIRED', 'PENDING')).toThrow(
        IllegalTransitionError,
      );
      expect(() => assertClarificationTransition('EXPIRED', 'CONSUMED')).toThrow(
        IllegalTransitionError,
      );
      expect(() => assertClarificationTransition('EXPIRED', 'SUPERSEDED')).toThrow(
        IllegalTransitionError,
      );
    });

    it('throws on SUPERSEDED -> anything (terminal state, a retired record stays retired)', () => {
      expect(() => assertClarificationTransition('SUPERSEDED', 'PENDING')).toThrow(
        IllegalTransitionError,
      );
      expect(() => assertClarificationTransition('SUPERSEDED', 'CONSUMED')).toThrow(
        IllegalTransitionError,
      );
      expect(() => assertClarificationTransition('SUPERSEDED', 'EXPIRED')).toThrow(
        IllegalTransitionError,
      );
    });

    it('carries machine/from/to fields and the exact "illegal <machine> transition: <from> -> <to>" message', () => {
      let caught: unknown;
      try {
        assertClarificationTransition('CONSUMED', 'PENDING');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(IllegalTransitionError);
      const illegal = caught as IllegalTransitionError;
      expect(illegal.machine).toBe('clarification');
      expect(illegal.from).toBe('CONSUMED');
      expect(illegal.to).toBe('PENDING');
      expect(illegal.message).toBe('illegal clarification transition: CONSUMED -> PENDING');
    });
  });

  // Property test over CLARIFICATION_TRANSITIONS as DATA (same shape as the
  // command/outbox/intent sweeps): for every (from, to) pair drawn from
  // CLARIFICATION_STATUSES (4x4 = 16 pairs — 3 legal, 13 illegal), it must
  // throw an IllegalTransitionError IFF `to` is absent from
  // CLARIFICATION_TRANSITIONS[from]. The individual-edge tests above exist
  // for readable failure messages, but this full sweep is what guarantees no
  // pair is missed.
  it('assertClarificationTransition agrees with CLARIFICATION_TRANSITIONS for every (from, to) pair', () => {
    const mismatches: string[] = [];

    for (const from of CLARIFICATION_STATUSES) {
      for (const to of CLARIFICATION_STATUSES) {
        const shouldBeLegal = CLARIFICATION_TRANSITIONS[from].includes(to);
        let threw = false;
        try {
          assertClarificationTransition(from, to);
        } catch (error) {
          threw = true;
          if (!(error instanceof IllegalTransitionError)) {
            mismatches.push(`${from} -> ${to}: threw a non-IllegalTransitionError`);
          }
        }
        if (threw === shouldBeLegal) {
          mismatches.push(`${from} -> ${to}: expected ${shouldBeLegal ? 'no throw' : 'a throw'}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});

describe('checkClarificationBinding (D-P4B4-2)', () => {
  // Fixture values (deterministic literals, no randomness): a PENDING record
  // that expires at 2026-07-19T00:10:00.000Z, and a reply that matches it on
  // every factor. Individual tests clone-and-mutate this base via spread so
  // each test only varies the ONE factor it's pinning.
  const record: ClarificationRecordView = {
    token: 'amb-tok-0001',
    threadKey: 'thread-0001',
    candidateSetVersion: 2,
    expiresAt: '2026-07-19T00:10:00.000Z',
    status: 'PENDING',
  };

  const matchingReply: ExtractedReplyBinding = {
    token: 'amb-tok-0001',
    threadKey: 'thread-0001',
    candidateSetVersion: 2,
  };

  const NOW_BEFORE_EXPIRY = '2026-07-19T00:00:00.000Z';

  it('all factors correct -> { ok: true }', () => {
    expect(checkClarificationBinding(record, matchingReply, NOW_BEFORE_EXPIRY)).toEqual({
      ok: true,
    });
  });

  describe('NOT_PENDING (record already left PENDING)', () => {
    it('record status CONSUMED -> NOT_PENDING', () => {
      const consumedRecord: ClarificationRecordView = { ...record, status: 'CONSUMED' };
      expect(checkClarificationBinding(consumedRecord, matchingReply, NOW_BEFORE_EXPIRY)).toEqual({
        ok: false,
        reason: 'NOT_PENDING',
      });
    });

    it('record status EXPIRED -> NOT_PENDING', () => {
      const expiredRecord: ClarificationRecordView = { ...record, status: 'EXPIRED' };
      expect(checkClarificationBinding(expiredRecord, matchingReply, NOW_BEFORE_EXPIRY)).toEqual({
        ok: false,
        reason: 'NOT_PENDING',
      });
    });

    it('record status SUPERSEDED -> NOT_PENDING', () => {
      const supersededRecord: ClarificationRecordView = { ...record, status: 'SUPERSEDED' };
      expect(
        checkClarificationBinding(supersededRecord, matchingReply, NOW_BEFORE_EXPIRY),
      ).toEqual({
        ok: false,
        reason: 'NOT_PENDING',
      });
    });
  });

  describe('TOKEN_MISMATCH (strict ===, case-sensitive, no trimming)', () => {
    it('wrong token -> TOKEN_MISMATCH', () => {
      const wrongTokenReply: ExtractedReplyBinding = { ...matchingReply, token: 'amb-tok-9999' };
      expect(checkClarificationBinding(record, wrongTokenReply, NOW_BEFORE_EXPIRY)).toEqual({
        ok: false,
        reason: 'TOKEN_MISMATCH',
      });
    });

    it('null token (extraction failed) -> TOKEN_MISMATCH', () => {
      const nullTokenReply: ExtractedReplyBinding = { ...matchingReply, token: null };
      expect(checkClarificationBinding(record, nullTokenReply, NOW_BEFORE_EXPIRY)).toEqual({
        ok: false,
        reason: 'TOKEN_MISMATCH',
      });
    });

    it('token differing only by case -> TOKEN_MISMATCH (case-sensitive, no normalization)', () => {
      const upperCaseReply: ExtractedReplyBinding = { ...matchingReply, token: 'AMB-TOK-0001' };
      expect(checkClarificationBinding(record, upperCaseReply, NOW_BEFORE_EXPIRY)).toEqual({
        ok: false,
        reason: 'TOKEN_MISMATCH',
      });
    });

    it('token with a leading space -> TOKEN_MISMATCH (no trimming)', () => {
      const paddedReply: ExtractedReplyBinding = { ...matchingReply, token: ' amb-tok-0001' };
      expect(checkClarificationBinding(record, paddedReply, NOW_BEFORE_EXPIRY)).toEqual({
        ok: false,
        reason: 'TOKEN_MISMATCH',
      });
    });
  });

  describe('VERSION_STALE', () => {
    it('reply version 1 vs record version 2 -> VERSION_STALE', () => {
      const staleVersionReply: ExtractedReplyBinding = {
        ...matchingReply,
        candidateSetVersion: 1,
      };
      expect(checkClarificationBinding(record, staleVersionReply, NOW_BEFORE_EXPIRY)).toEqual({
        ok: false,
        reason: 'VERSION_STALE',
      });
    });

    it('null version (extraction failed) -> VERSION_STALE', () => {
      const nullVersionReply: ExtractedReplyBinding = {
        ...matchingReply,
        candidateSetVersion: null,
      };
      expect(checkClarificationBinding(record, nullVersionReply, NOW_BEFORE_EXPIRY)).toEqual({
        ok: false,
        reason: 'VERSION_STALE',
      });
    });
  });

  describe('EXPIRED_AT_REPLY (lexicographic ISO comparison, same convention as the readyAt fence in src/application/ingest.ts)', () => {
    it('now past expiresAt -> EXPIRED_AT_REPLY', () => {
      const nowAfterExpiry = '2026-07-19T00:20:00.000Z';
      expect(checkClarificationBinding(record, matchingReply, nowAfterExpiry)).toEqual({
        ok: false,
        reason: 'EXPIRED_AT_REPLY',
      });
    });

    it('now === expiresAt exactly -> EXPIRED_AT_REPLY (fail closed at the boundary)', () => {
      expect(checkClarificationBinding(record, matchingReply, record.expiresAt)).toEqual({
        ok: false,
        reason: 'EXPIRED_AT_REPLY',
      });
    });

    it('now one millisecond before expiresAt -> ok (proves the boundary sits exactly at >=, not >)', () => {
      const oneMsBeforeExpiry = '2026-07-19T00:09:59.999Z';
      expect(checkClarificationBinding(record, matchingReply, oneMsBeforeExpiry)).toEqual({
        ok: true,
      });
    });
  });

  describe('reject-reason priority (fixed enum order — NOT_PENDING > TOKEN_MISMATCH > VERSION_STALE > EXPIRED_AT_REPLY)', () => {
    // Each combo below strips exactly one layer off the "everything is
    // wrong" fixture to prove the NEXT reason down the priority list takes
    // over — not a different, arbitrarily-chosen reason.
    const allWrongReply: ExtractedReplyBinding = {
      token: 'wrong-token',
      threadKey: 'thread-0001',
      candidateSetVersion: 99,
    };
    const wayPastExpiry = '2099-01-01T00:00:00.000Z';

    it('non-PENDING + wrong token + stale version + expired -> NOT_PENDING (highest priority)', () => {
      const worstRecord: ClarificationRecordView = { ...record, status: 'SUPERSEDED' };
      expect(checkClarificationBinding(worstRecord, allWrongReply, wayPastExpiry)).toEqual({
        ok: false,
        reason: 'NOT_PENDING',
      });
    });

    it('PENDING + wrong token + stale version + expired -> TOKEN_MISMATCH (NOT_PENDING layer stripped)', () => {
      expect(checkClarificationBinding(record, allWrongReply, wayPastExpiry)).toEqual({
        ok: false,
        reason: 'TOKEN_MISMATCH',
      });
    });

    it('PENDING + right token + stale version + expired -> VERSION_STALE (TOKEN_MISMATCH layer also stripped)', () => {
      const rightTokenStaleVersionReply: ExtractedReplyBinding = {
        ...allWrongReply,
        token: record.token,
      };
      expect(
        checkClarificationBinding(record, rightTokenStaleVersionReply, wayPastExpiry),
      ).toEqual({
        ok: false,
        reason: 'VERSION_STALE',
      });
    });
  });
});
