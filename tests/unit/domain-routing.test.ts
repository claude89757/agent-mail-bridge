import { describe, expect, it } from 'vitest';

import {
  routeCommand,
  type RouteInput,
  type RoutingCandidate,
  type RoutingSessionView,
} from '../../src/domain/routing.js';

// Guards decision D-P4B7-1 (routing verdict pure function) from
// docs/superpowers/plans/2026-07-19-phase-4-batch7-router-core.md — the
// deterministic core of Phase 4 routing: extracted project term ->
// exact-lookup candidates -> one of four verdicts, with a FIXED priority
// order (existing session > unique match > multiple matches > everything
// else). Spec §6's "低置信永远澄清而不猜测" is the locked invariant here:
// the function never guesses, never fuzzy-matches — outside an exact
// existing-session or unique-candidate hit, every input clarifies.
//
// Fixture discipline: synthetic placeholder values only (fixture paths under
// /tmp/fixtures/, low-entropy synthetic UUID shape for driver session ids)
// — never a real local path or real identifier.

const PROJECT_A: RoutingCandidate = { name: 'proj-a', path: '/tmp/fixtures/proj-a' };
const PROJECT_B: RoutingCandidate = { name: 'proj-b', path: '/tmp/fixtures/proj-b' };
// Same name under a different root — projectIndex invariant 4 allows this;
// lookup returns both and picking "the" one is exactly what routeCommand
// must refuse to do (CLARIFY_AMBIGUOUS).
const PROJECT_A_OTHER_ROOT: RoutingCandidate = {
  name: 'proj-a',
  path: '/tmp/fixtures/other-root/proj-a',
};

const SESSION_WITH_DRIVER: RoutingSessionView = {
  projectPath: '/tmp/fixtures/proj-a',
  driverSessionId: '00000000-0000-4000-8000-000000000001',
};

const SESSION_BEFORE_THREAD_STARTED: RoutingSessionView = {
  projectPath: '/tmp/fixtures/proj-a',
  driverSessionId: null,
};

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    term: 'proj-a',
    existingSession: null,
    matches: [],
    ...overrides,
  };
}

describe('routeCommand (D-P4B7-1)', () => {
  describe('priority 1: CONTINUE_SESSION (thread continuity beats everything)', () => {
    it('existing session with a driver session id -> CONTINUE_SESSION carrying that exact view', () => {
      expect(
        routeCommand(input({ existingSession: SESSION_WITH_DRIVER, matches: [PROJECT_A] })),
      ).toEqual({
        kind: 'CONTINUE_SESSION',
        session: SESSION_WITH_DRIVER,
      });
    });

    it('existing session whose driverSessionId is still null (before thread.started) -> CONTINUE_SESSION', () => {
      expect(
        routeCommand(input({ existingSession: SESSION_BEFORE_THREAD_STARTED })),
      ).toEqual({
        kind: 'CONTINUE_SESSION',
        session: SESSION_BEFORE_THREAD_STARTED,
      });
    });

    it('existing session + a unique match -> CONTINUE_SESSION, not DISPATCH_NEW (session outranks the match)', () => {
      expect(
        routeCommand(
          input({ existingSession: SESSION_WITH_DRIVER, term: 'proj-b', matches: [PROJECT_B] }),
        ),
      ).toEqual({
        kind: 'CONTINUE_SESSION',
        session: SESSION_WITH_DRIVER,
      });
    });

    it('existing session + zero matches -> CONTINUE_SESSION, not CLARIFY_NO_MATCH', () => {
      expect(
        routeCommand(
          input({ existingSession: SESSION_WITH_DRIVER, term: 'no-such-proj', matches: [] }),
        ),
      ).toEqual({
        kind: 'CONTINUE_SESSION',
        session: SESSION_WITH_DRIVER,
      });
    });

    it('existing session + multiple matches -> CONTINUE_SESSION, not CLARIFY_AMBIGUOUS', () => {
      expect(
        routeCommand(
          input({
            existingSession: SESSION_WITH_DRIVER,
            matches: [PROJECT_A, PROJECT_A_OTHER_ROOT],
          }),
        ),
      ).toEqual({
        kind: 'CONTINUE_SESSION',
        session: SESSION_WITH_DRIVER,
      });
    });

    it('existing session + null term -> CONTINUE_SESSION (a bare reply on a known thread continues it)', () => {
      expect(
        routeCommand(input({ existingSession: SESSION_WITH_DRIVER, term: null })),
      ).toEqual({
        kind: 'CONTINUE_SESSION',
        session: SESSION_WITH_DRIVER,
      });
    });
  });

  describe('priority 2: DISPATCH_NEW (exactly one exact match)', () => {
    it('no session + exactly one match -> DISPATCH_NEW carrying that project', () => {
      expect(routeCommand(input({ matches: [PROJECT_A] }))).toEqual({
        kind: 'DISPATCH_NEW',
        project: PROJECT_A,
      });
    });
  });

  describe('priority 3: CLARIFY_AMBIGUOUS (more than one exact match — never pick one)', () => {
    it('no session + two same-name matches from different roots -> CLARIFY_AMBIGUOUS', () => {
      expect(
        routeCommand(input({ matches: [PROJECT_A, PROJECT_A_OTHER_ROOT] })),
      ).toEqual({
        kind: 'CLARIFY_AMBIGUOUS',
        candidates: [PROJECT_A, PROJECT_A_OTHER_ROOT],
      });
    });

    it('candidates pass through in input order verbatim (no sorting, no truncation)', () => {
      // proj-b sorts AFTER proj-a lexicographically, so feeding [B, A2, A]
      // and getting the same sequence back kills any mutant that re-sorts;
      // three entries also kill any mutant that truncates to a fixed two.
      const unsorted = [PROJECT_B, PROJECT_A_OTHER_ROOT, PROJECT_A];

      const verdict = routeCommand(input({ term: 'proj', matches: unsorted }));

      expect(verdict).toEqual({
        kind: 'CLARIFY_AMBIGUOUS',
        candidates: [PROJECT_B, PROJECT_A_OTHER_ROOT, PROJECT_A],
      });
    });
  });

  describe('priority 4: CLARIFY_NO_MATCH (fail closed — never guess)', () => {
    it('no session + a term that matched nothing -> CLARIFY_NO_MATCH', () => {
      expect(routeCommand(input({ term: 'no-such-proj', matches: [] }))).toEqual({
        kind: 'CLARIFY_NO_MATCH',
      });
    });

    it('null term (extraction failed/missing) + empty matches -> CLARIFY_NO_MATCH', () => {
      expect(routeCommand(input({ term: null, matches: [] }))).toEqual({
        kind: 'CLARIFY_NO_MATCH',
      });
    });
  });

  describe('null term with non-empty matches (a combination the caller contract says should not occur)', () => {
    // The caller passes matches = [] whenever term is null, so these inputs
    // should never be produced — but routeCommand's behavior must stay
    // deterministic anyway: the verdict follows the matches count, exactly
    // as if the term were present (term is never re-inspected once matches
    // are in hand).
    it('null term + one match -> DISPATCH_NEW (decided by matches count alone)', () => {
      expect(routeCommand(input({ term: null, matches: [PROJECT_B] }))).toEqual({
        kind: 'DISPATCH_NEW',
        project: PROJECT_B,
      });
    });

    it('null term + two matches -> CLARIFY_AMBIGUOUS (decided by matches count alone)', () => {
      expect(
        routeCommand(input({ term: null, matches: [PROJECT_A, PROJECT_B] })),
      ).toEqual({
        kind: 'CLARIFY_AMBIGUOUS',
        candidates: [PROJECT_A, PROJECT_B],
      });
    });
  });
});
