import { describe, expect, it } from 'vitest';

import { IllegalTransitionError } from '../../src/domain/errors.js';
import {
  assertIntentTransition,
  INTENT_STATUSES,
  INTENT_TRANSITIONS,
  type IntentStatus,
} from '../../src/domain/intentState.js';

// Guards decision D-P3P-4 (intent lifecycle, Phase 3 prework plan batch 1):
// the third state machine in this bridge, isomorphic in verification
// strategy to domain-state-machines.test.ts's command (D-P2-2) and outbox
// (D-P2-3) machines — same IllegalTransitionError shape, same
// map-as-data + full-matrix-scan test structure. Kept in its own file (per
// the Phase 3 prework plan's task breakdown) rather than folded into
// domain-state-machines.test.ts.

describe('intent state machine (D-P3P-4)', () => {
  it('INTENT_STATUSES contains exactly the six intent statuses', () => {
    expect(new Set(INTENT_STATUSES)).toEqual(
      new Set<IntentStatus>([
        'PENDING',
        'RUNNING',
        'COMPLETED',
        'FAILED',
        'SKIPPED_DRY_RUN',
        'RESOLVED',
      ]),
    );
  });

  describe('legal edges (D-P3P-4)', () => {
    it('PENDING -> RUNNING does not throw (dispatch starts)', () => {
      expect(() => assertIntentTransition('PENDING', 'RUNNING')).not.toThrow();
    });

    it('PENDING -> SKIPPED_DRY_RUN does not throw (dry run never actually dispatches)', () => {
      expect(() => assertIntentTransition('PENDING', 'SKIPPED_DRY_RUN')).not.toThrow();
    });

    it('PENDING -> RESOLVED does not throw (coordinator answered/clarified without dispatching — ADR-0006)', () => {
      expect(() => assertIntentTransition('PENDING', 'RESOLVED')).not.toThrow();
    });

    it('RUNNING -> COMPLETED does not throw', () => {
      expect(() => assertIntentTransition('RUNNING', 'COMPLETED')).not.toThrow();
    });

    it('RUNNING -> FAILED does not throw', () => {
      expect(() => assertIntentTransition('RUNNING', 'FAILED')).not.toThrow();
    });
  });

  describe('illegal transitions', () => {
    it('throws on PENDING -> COMPLETED (must pass through RUNNING first)', () => {
      expect(() => assertIntentTransition('PENDING', 'COMPLETED')).toThrow(IllegalTransitionError);
    });

    it('throws on PENDING -> FAILED (must pass through RUNNING first)', () => {
      expect(() => assertIntentTransition('PENDING', 'FAILED')).toThrow(IllegalTransitionError);
    });

    it('throws on RUNNING -> SKIPPED_DRY_RUN (dry-run skip only from PENDING)', () => {
      expect(() => assertIntentTransition('RUNNING', 'SKIPPED_DRY_RUN')).toThrow(
        IllegalTransitionError,
      );
    });

    it('throws on RUNNING -> PENDING (no retreat)', () => {
      expect(() => assertIntentTransition('RUNNING', 'PENDING')).toThrow(IllegalTransitionError);
    });

    it('throws on COMPLETED -> anything (terminal state, loop guard hit)', () => {
      expect(() => assertIntentTransition('COMPLETED', 'RUNNING')).toThrow(IllegalTransitionError);
      expect(() => assertIntentTransition('COMPLETED', 'PENDING')).toThrow(IllegalTransitionError);
    });

    it('throws on FAILED -> anything (terminal state — no silent retry, see the crash-recovery doc comment)', () => {
      expect(() => assertIntentTransition('FAILED', 'RUNNING')).toThrow(IllegalTransitionError);
      expect(() => assertIntentTransition('FAILED', 'PENDING')).toThrow(IllegalTransitionError);
    });

    it('throws on SKIPPED_DRY_RUN -> anything (terminal state)', () => {
      expect(() => assertIntentTransition('SKIPPED_DRY_RUN', 'RUNNING')).toThrow(
        IllegalTransitionError,
      );
      expect(() => assertIntentTransition('SKIPPED_DRY_RUN', 'PENDING')).toThrow(
        IllegalTransitionError,
      );
    });

    it('throws on RUNNING -> RESOLVED (RESOLVED is a no-agent terminal, reachable only straight from PENDING)', () => {
      expect(() => assertIntentTransition('RUNNING', 'RESOLVED')).toThrow(IllegalTransitionError);
    });

    it('throws on RESOLVED -> anything (terminal state)', () => {
      expect(() => assertIntentTransition('RESOLVED', 'RUNNING')).toThrow(IllegalTransitionError);
      expect(() => assertIntentTransition('RESOLVED', 'PENDING')).toThrow(IllegalTransitionError);
    });

    it('carries machine/from/to fields and the exact "illegal <machine> transition: <from> -> <to>" message', () => {
      let caught: unknown;
      try {
        assertIntentTransition('PENDING', 'COMPLETED');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(IllegalTransitionError);
      const illegal = caught as IllegalTransitionError;
      expect(illegal.machine).toBe('intent');
      expect(illegal.from).toBe('PENDING');
      expect(illegal.to).toBe('COMPLETED');
      expect(illegal.message).toBe('illegal intent transition: PENDING -> COMPLETED');
    });
  });

  // Property test over INTENT_TRANSITIONS as DATA (same shape as the
  // command/outbox sweeps in domain-state-machines.test.ts): for every
  // (from, to) pair drawn from INTENT_STATUSES (6x6 = 36 pairs), it must
  // throw an IllegalTransitionError IFF `to` is absent from
  // INTENT_TRANSITIONS[from]. The individual-edge tests above exist for
  // readable failure messages, but this full sweep is what guarantees no
  // pair is missed.
  it('assertIntentTransition agrees with INTENT_TRANSITIONS for every (from, to) pair', () => {
    const mismatches: string[] = [];

    for (const from of INTENT_STATUSES) {
      for (const to of INTENT_STATUSES) {
        const shouldBeLegal = INTENT_TRANSITIONS[from].includes(to);
        let threw = false;
        try {
          assertIntentTransition(from, to);
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
