import { describe, expect, it } from 'vitest';

import { resolveCoordinatorDispatch } from '../../src/domain/coordinatorRouting.js';
import type { RoutingCandidate, RoutingSessionView } from '../../src/domain/routing.js';

// Guards the coordination layer's batch-A dispatch resolution (ADR-0006).
// The coordinator agent has already decided `dispatch` with a mode; this
// pure function maps that (mode + the alias's exact-lookup matches + the
// thread's existing session) onto the SAME `RouteVerdict` the existing
// dispatch pipeline consumes — but driven by the coordinator's `mode`, not
// by routeCommand's "existing session beats everything" priority.
//
// The safety envelope stays intact regardless of what the (injectable,
// prompt-reading) coordinator says: `continue` can only ever continue THIS
// thread's real session, and `new` can only ever dispatch to a UNIQUE
// allowlisted match — every other case fails closed to a clarification.
//
// Fixture discipline: synthetic placeholder values only.

const PROJECT_A: RoutingCandidate = { name: 'blog', path: '/tmp/fixtures/blog' };
const PROJECT_B: RoutingCandidate = { name: 'api', path: '/tmp/fixtures/api' };

const SESSION: RoutingSessionView = {
  projectPath: '/tmp/fixtures/blog',
  driverSessionId: '00000000-0000-4000-8000-000000000001',
};

describe('resolveCoordinatorDispatch (ADR-0006, coordination batch A/2)', () => {
  describe('mode=continue', () => {
    it('continues the thread session when one exists (term/matches ignored)', () => {
      expect(
        resolveCoordinatorDispatch({ mode: 'continue', matches: [PROJECT_B], existingSession: SESSION }),
      ).toEqual({ kind: 'CONTINUE_SESSION', session: SESSION });
    });

    it('fails closed to CLARIFY_NO_MATCH when the thread has no session', () => {
      expect(
        resolveCoordinatorDispatch({ mode: 'continue', matches: [PROJECT_A], existingSession: null }),
      ).toEqual({ kind: 'CLARIFY_NO_MATCH' });
    });
  });

  describe('mode=new', () => {
    it('dispatches on a unique match', () => {
      expect(
        resolveCoordinatorDispatch({ mode: 'new', matches: [PROJECT_A], existingSession: null }),
      ).toEqual({ kind: 'DISPATCH_NEW', project: PROJECT_A });
    });

    it('clarifies on multiple matches, preserving input order', () => {
      expect(
        resolveCoordinatorDispatch({ mode: 'new', matches: [PROJECT_A, PROJECT_B], existingSession: null }),
      ).toEqual({ kind: 'CLARIFY_AMBIGUOUS', candidates: [PROJECT_A, PROJECT_B] });
    });

    it('clarifies on no match (fail closed, never guesses)', () => {
      expect(
        resolveCoordinatorDispatch({ mode: 'new', matches: [], existingSession: null }),
      ).toEqual({ kind: 'CLARIFY_NO_MATCH' });
    });

    it('new overrides an existing thread session — 旧线程换新任务', () => {
      // KEY divergence from routeCommand (where existingSession beats
      // everything): the coordinator's explicit mode=new wins, so a reply on
      // an old thread can start a fresh task in ANOTHER project. Still safe:
      // it dispatches only to the unique allowlisted match, never elsewhere.
      expect(
        resolveCoordinatorDispatch({ mode: 'new', matches: [PROJECT_B], existingSession: SESSION }),
      ).toEqual({ kind: 'DISPATCH_NEW', project: PROJECT_B });
    });
  });
});
