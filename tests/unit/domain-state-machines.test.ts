import { describe, expect, it } from 'vitest';

import {
  assertCommandTransition,
  COMMAND_STATUSES,
  COMMAND_TRANSITIONS,
  type CommandStatus,
} from '../../src/domain/commandState.js';
import { IllegalTransitionError } from '../../src/domain/errors.js';
import {
  assertOutboxTransition,
  OUTBOX_STATUSES,
  OUTBOX_TRANSITIONS,
  type OutboxStatus,
} from '../../src/domain/outboxState.js';

// Guards decisions D-P2-2 (command states) and D-P2-3 (outbox states): the
// two Phase 2 state machines that will gate every status write in
// src/store/commandStore.ts / src/store/outboxStore.ts (Task 6). Both share
// one IllegalTransitionError shape (src/domain/errors.ts) so a rejected
// transition can always be told apart from an ordinary Error via
// `instanceof`, regardless of which machine (or later, which store) threw it.

describe('command state machine (D-P2-2)', () => {
  // Guards the property test further down against silently under-covering:
  // if a status were missing from this list, the sweep would never exercise
  // transitions to/from it. Set-based (order-independent) on purpose — order
  // carries no meaning for this union.
  it('COMMAND_STATUSES contains exactly the five Phase 2 statuses', () => {
    expect(new Set(COMMAND_STATUSES)).toEqual(
      new Set<CommandStatus>([
        'RECEIVED',
        'SYSTEM_ECHO',
        'REJECTED',
        'QUEUED_WINDOW',
        'READY_FOR_DISPATCH',
      ]),
    );
  });

  describe('legal edges (D-P2-2)', () => {
    it('RECEIVED -> SYSTEM_ECHO does not throw (loop guard hit)', () => {
      expect(() => assertCommandTransition('RECEIVED', 'SYSTEM_ECHO')).not.toThrow();
    });

    it('RECEIVED -> REJECTED does not throw (a gate rejected the mail)', () => {
      expect(() => assertCommandTransition('RECEIVED', 'REJECTED')).not.toThrow();
    });

    it('RECEIVED -> QUEUED_WINDOW does not throw (outside the configured time window)', () => {
      expect(() => assertCommandTransition('RECEIVED', 'QUEUED_WINDOW')).not.toThrow();
    });

    it('RECEIVED -> READY_FOR_DISPATCH does not throw (all gates passed)', () => {
      expect(() => assertCommandTransition('RECEIVED', 'READY_FOR_DISPATCH')).not.toThrow();
    });

    it('QUEUED_WINDOW -> READY_FOR_DISPATCH does not throw (window opens later)', () => {
      expect(() => assertCommandTransition('QUEUED_WINDOW', 'READY_FOR_DISPATCH')).not.toThrow();
    });
  });

  describe('illegal transitions', () => {
    it('throws on SYSTEM_ECHO -> READY_FOR_DISPATCH (terminal state, loop guard hit)', () => {
      expect(() => assertCommandTransition('SYSTEM_ECHO', 'READY_FOR_DISPATCH')).toThrow(
        IllegalTransitionError,
      );
    });

    it('throws on REJECTED -> READY_FOR_DISPATCH (terminal state, gate rejection)', () => {
      expect(() => assertCommandTransition('REJECTED', 'READY_FOR_DISPATCH')).toThrow(
        IllegalTransitionError,
      );
    });

    it('carries machine/from/to fields and the exact "illegal <machine> transition: <from> -> <to>" message', () => {
      let caught: unknown;
      try {
        assertCommandTransition('REJECTED', 'READY_FOR_DISPATCH');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(IllegalTransitionError);
      const illegal = caught as IllegalTransitionError;
      expect(illegal.machine).toBe('command');
      expect(illegal.from).toBe('REJECTED');
      expect(illegal.to).toBe('READY_FOR_DISPATCH');
      expect(illegal.message).toBe('illegal command transition: REJECTED -> READY_FOR_DISPATCH');
    });
  });

  // Property test over COMMAND_TRANSITIONS as DATA, not a hardcoded notion of
  // "terminal": for every (from, to) pair drawn from COMMAND_STATUSES,
  // assertCommandTransition must throw an IllegalTransitionError IFF `to` is
  // absent from COMMAND_TRANSITIONS[from]. A status whose array is empty
  // (SYSTEM_ECHO/REJECTED — terminal by design; READY_FOR_DISPATCH — Phase
  // 2's frontier, see the doc comment in commandState.ts) therefore has NO
  // legal `to` at all, for every possible target including itself: exactly
  // "terminal states have no outgoing edges", derived from the map rather
  // than asserted as a separate hardcoded list.
  it('assertCommandTransition agrees with COMMAND_TRANSITIONS for every (from, to) pair', () => {
    const mismatches: string[] = [];

    for (const from of COMMAND_STATUSES) {
      for (const to of COMMAND_STATUSES) {
        const shouldBeLegal = COMMAND_TRANSITIONS[from].includes(to);
        let threw = false;
        try {
          assertCommandTransition(from, to);
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

describe('outbox state machine (D-P2-3)', () => {
  it('OUTBOX_STATUSES contains exactly the four Phase 2 statuses', () => {
    expect(new Set(OUTBOX_STATUSES)).toEqual(
      new Set<OutboxStatus>(['PENDING', 'SENDING', 'SENT', 'UNCERTAIN']),
    );
  });

  describe('legal edges (D-P2-3)', () => {
    it('PENDING -> SENDING does not throw', () => {
      expect(() => assertOutboxTransition('PENDING', 'SENDING')).not.toThrow();
    });

    it('SENDING -> SENT does not throw', () => {
      expect(() => assertOutboxTransition('SENDING', 'SENT')).not.toThrow();
    });

    it('SENDING -> UNCERTAIN does not throw (send outcome unknown)', () => {
      expect(() => assertOutboxTransition('SENDING', 'UNCERTAIN')).not.toThrow();
    });

    it('UNCERTAIN -> SENT does not throw (reconciled)', () => {
      expect(() => assertOutboxTransition('UNCERTAIN', 'SENT')).not.toThrow();
    });
  });

  describe('illegal transitions', () => {
    it('throws on SENT -> PENDING (terminal state)', () => {
      expect(() => assertOutboxTransition('SENT', 'PENDING')).toThrow(IllegalTransitionError);
    });

    it('throws on PENDING -> UNCERTAIN (must pass through SENDING first — no blind-resend shortcut)', () => {
      expect(() => assertOutboxTransition('PENDING', 'UNCERTAIN')).toThrow(
        IllegalTransitionError,
      );
    });

    it('carries machine/from/to fields and the exact "illegal <machine> transition: <from> -> <to>" message', () => {
      let caught: unknown;
      try {
        assertOutboxTransition('SENT', 'PENDING');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(IllegalTransitionError);
      const illegal = caught as IllegalTransitionError;
      expect(illegal.machine).toBe('outbox');
      expect(illegal.from).toBe('SENT');
      expect(illegal.to).toBe('PENDING');
      expect(illegal.message).toBe('illegal outbox transition: SENT -> PENDING');
    });
  });

  // Same property test as the command machine above, over OUTBOX_TRANSITIONS.
  it('assertOutboxTransition agrees with OUTBOX_TRANSITIONS for every (from, to) pair', () => {
    const mismatches: string[] = [];

    for (const from of OUTBOX_STATUSES) {
      for (const to of OUTBOX_STATUSES) {
        const shouldBeLegal = OUTBOX_TRANSITIONS[from].includes(to);
        let threw = false;
        try {
          assertOutboxTransition(from, to);
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
