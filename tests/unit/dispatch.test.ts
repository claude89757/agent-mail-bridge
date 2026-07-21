import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatchIntent, executeDispatchVerdict } from '../../src/application/dispatch.js';
import type { DispatchDeps, DispatchInput } from '../../src/application/dispatch.js';
import type { ProjectEntry, ProjectIndex } from '../../src/application/projectIndex.js';
import type { CreateWorktreeInput } from '../../src/application/worktreeManager.js';
import type { AgentDriver, AgentTaskInput, DriverEvent } from '../../src/drivers/types.js';
import { openDatabase } from '../../src/store/database.js';
import { CommandStore } from '../../src/store/commandStore.js';
import { IntentStore } from '../../src/store/intentStore.js';
import { SessionStore } from '../../src/store/sessionStore.js';
import { FakeAgentDriver } from '../helpers/fakeAgentDriver.js';

// Guards D-P4B8-2 (dispatch use-case shape) and D-P4B8-3 (normative
// orchestration order, pinned step by step below) from the Phase 4 batch 8
// plan (docs/superpowers/plans/2026-07-19-phase-4-batch8-dispatch-pipeline.md).
// Test style follows ingest.test.ts: REAL in-memory stores (never store
// mocks — the intent state machine and the two session first-write
// invariants stay armed under test) + injected fakes for everything that
// would otherwise do IO (FakeAgentDriver / hand-rolled driver stubs where
// the fake deliberately cannot model a behavior, a scripted createWorktree,
// a scripted directoryExists, a deterministic ticking clock). A shared
// `calls` log wraps store/driver/worktree entry points so ORDER — not just
// occurrence — is assertable (RUNNING lands before any committing side
// effect; session row precedes worktree precedes driver).
//
// Fixture discipline (public repo): placeholder message ids, synthetic
// /tmp/fixtures/* paths (never a real local path), low-entropy driver
// session ids.

type Db = ReturnType<typeof openDatabase>;

const INTENT_ID = 'intent-0001';
const THREAD_KEY = 'thread-key-0001';
const PROJECT_PATH = '/tmp/fixtures/roots/proj-a';
const WORKTREES_ROOT = '/tmp/fixtures/worktrees';
const BASE_REF = 'main';
const PROMPT = 'run the quarterly cleanup task';
const DRIVER_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const SEEDED_WORKTREE_PATH = `${WORKTREES_ROOT}/amb-session-1`;

/** Fixed instants for rows seeded by setup(), deliberately BEFORE every
 *  value the ticking clock below can produce — a seeded timestamp showing
 *  up where a dispatch-written one belongs is then visible in asserts. */
const SEED_NOW = '2026-07-18T00:00:00.000Z';

const AGENT_MESSAGE: DriverEvent = { kind: 'agent-message', text: 'working on it' };
const TOOL_ACTIVITY: DriverEvent = { kind: 'tool-activity', summary: 'edited 2 files' };
const COMPLETED_EVENT: DriverEvent = { kind: 'completed', resultText: 'all done' };
const DEFAULT_SEGMENT: readonly DriverEvent[] = [AGENT_MESSAGE, TOOL_ACTIVITY, COMPLETED_EVENT];

let openDbs: Db[];

beforeEach(() => {
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
});

interface SetupOptions {
  /** Default true; false for the missing-intent caller-bug test. */
  seedIntent?: boolean;
  dryRun?: boolean;
  /** Pre-transitions the seeded intent (before instrumentation) for the
   *  non-PENDING caller-bug test. */
  intentStatus?: 'RUNNING';
  entries?: readonly ProjectEntry[];
  script?: readonly (readonly DriverEvent[])[];
  /** Hand-rolled AgentDriver stub; when set, no FakeAgentDriver is built
   *  (harness.fake is null). */
  driver?: AgentDriver;
  existingSession?: { driverSessionId: string | null; worktreePath: string | null };
  createWorktreeError?: Error;
  directoryExistsResult?: boolean;
}

interface Harness {
  intentStore: IntentStore;
  sessionStore: SessionStore;
  /** Null iff a hand-rolled `driver` stub was injected via options. */
  fake: FakeAgentDriver | null;
  deps: DispatchDeps;
  /** Cross-object call log (stores + worktree + driver), in call order. */
  calls: string[];
  lookupTerms: string[];
  createWorktreeCalls: CreateWorktreeInput[];
  directoryExistsCalls: string[];
}

function setup(options: SetupOptions = {}): Harness {
  const db = openDatabase(':memory:');
  openDbs.push(db);

  const commandStore = new CommandStore(db);
  const intentStore = new IntentStore(db);
  const sessionStore = new SessionStore(db);

  if (options.seedIntent ?? true) {
    const { record } = commandStore.insertIfAbsent({
      messageId: 'msg-1@example.com',
      status: 'RECEIVED',
      statusReason: null,
      internalDate: SEED_NOW,
      uid: 1,
      uidValidity: '1690000000',
      now: SEED_NOW,
    });
    intentStore.createForCommand(INTENT_ID, record.id, options.dryRun ?? false, SEED_NOW);
    if (options.intentStatus === 'RUNNING') {
      intentStore.transition(INTENT_ID, 'RUNNING', null, SEED_NOW);
    }
  }

  if (options.existingSession) {
    const created = sessionStore.create({
      threadKey: THREAD_KEY,
      projectPath: PROJECT_PATH,
      now: SEED_NOW,
    });
    if (options.existingSession.worktreePath !== null) {
      sessionStore.recordWorktreePath(created.id, options.existingSession.worktreePath, SEED_NOW);
    }
    if (options.existingSession.driverSessionId !== null) {
      sessionStore.recordDriverSessionId(
        created.id,
        options.existingSession.driverSessionId,
        SEED_NOW,
      );
    }
  }

  // Instrumentation happens AFTER seeding, so the log only ever contains
  // what dispatchIntent itself did.
  const calls: string[] = [];

  const originalTransition = intentStore.transition.bind(intentStore);
  intentStore.transition = (id, next, reason, now): void => {
    calls.push(`intent.transition:${next}`);
    originalTransition(id, next, reason, now);
  };
  const originalSessionCreate = sessionStore.create.bind(sessionStore);
  sessionStore.create = (createInput) => {
    calls.push('session.create');
    return originalSessionCreate(createInput);
  };
  const originalRecordWorktreePath = sessionStore.recordWorktreePath.bind(sessionStore);
  sessionStore.recordWorktreePath = (id, worktreePath, now): void => {
    calls.push('session.recordWorktreePath');
    originalRecordWorktreePath(id, worktreePath, now);
  };
  const originalRecordDriverSessionId = sessionStore.recordDriverSessionId.bind(sessionStore);
  sessionStore.recordDriverSessionId = (id, driverSessionId, now): void => {
    calls.push('session.recordDriverSessionId');
    originalRecordDriverSessionId(id, driverSessionId, now);
  };

  const lookupTerms: string[] = [];
  const entries: readonly ProjectEntry[] = options.entries ?? [
    { name: 'proj-a', path: PROJECT_PATH, aliases: ['alpha'] },
  ];
  const index: ProjectIndex = {
    entries,
    lookup(term) {
      lookupTerms.push(term);
      const normalized = term.trim().toLowerCase();
      return entries.filter(
        (entry) => entry.name === normalized || entry.aliases.includes(normalized),
      );
    },
  };

  let fake: FakeAgentDriver | null = null;
  let innerDriver: AgentDriver;
  if (options.driver === undefined) {
    fake = new FakeAgentDriver(options.script ?? [DEFAULT_SEGMENT]);
    innerDriver = fake;
  } else {
    innerDriver = options.driver;
  }
  const driver: AgentDriver = {
    capabilities: () => innerDriver.capabilities(),
    startTask: (taskInput) => {
      calls.push('driver.startTask');
      return innerDriver.startTask(taskInput);
    },
    resumeTask: (sessionId, taskInput) => {
      calls.push('driver.resumeTask');
      return innerDriver.resumeTask(sessionId, taskInput);
    },
    streamEvents: (handle) => innerDriver.streamEvents(handle),
    close: () => innerDriver.close(),
  };

  const createWorktreeCalls: CreateWorktreeInput[] = [];
  const directoryExistsCalls: string[] = [];
  let tick = 0;

  const deps: DispatchDeps = {
    intentStore,
    sessionStore,
    index,
    driver,
    createWorktree: async (createInput) => {
      calls.push('createWorktree');
      createWorktreeCalls.push(createInput);
      if (options.createWorktreeError) {
        throw options.createWorktreeError;
      }
      return {
        worktreePath: `${WORKTREES_ROOT}/${createInput.taskId}`,
        baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
    },
    directoryExists: async (path) => {
      directoryExistsCalls.push(path);
      return options.directoryExistsResult ?? true;
    },
    worktreesRoot: WORKTREES_ROOT,
    baseRef: BASE_REF,
    // Deterministic ticking ISO clock: first call 2026-07-19T00:00:00.000Z,
    // then +1s per call — timestamp asserts below pin WHICH clock draw
    // landed in which column.
    clock: () => new Date(Date.UTC(2026, 6, 19, 0, 0, tick++)).toISOString(),
  };

  return {
    intentStore,
    sessionStore,
    fake,
    deps,
    calls,
    lookupTerms,
    createWorktreeCalls,
    directoryExistsCalls,
  };
}

function input(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    intentId: INTENT_ID,
    threadKey: THREAD_KEY,
    term: 'proj-a',
    prompt: PROMPT,
    ...overrides,
  };
}

describe('dispatchIntent (D-P4B8-2/3)', () => {
  describe('DISPATCH_NEW', () => {
    it('happy path: session row fully filled, intent COMPLETED, outcome executed with the full event stream', async () => {
      const harness = setup();

      const outcome = await dispatchIntent(input(), harness.deps);

      expect(outcome).toEqual({
        kind: 'executed',
        verdict: 'DISPATCH_NEW',
        terminal: COMPLETED_EVENT,
        events: [AGENT_MESSAGE, TOOL_ACTIVITY, COMPLETED_EVENT],
      });
      // Intent reached COMPLETED — and because intentStore.transition
      // re-enforces the PENDING→RUNNING→COMPLETED state machine on every
      // write, arriving here at all proves RUNNING happened in between.
      expect(harness.intentStore.getById(INTENT_ID)).toEqual({
        id: INTENT_ID,
        // The seeded command is the first row in a fresh :memory: db.
        commandId: 1,
        status: 'COMPLETED',
        dryRun: false,
        statusReason: null,
        updatedAt: '2026-07-19T00:00:04.000Z',
      });
      // Full-row session assert: worktree_path AND driver_session_id landed,
      // created_at is the create-step clock draw (tick 1), updated_at the
      // recordDriverSessionId draw (tick 3).
      expect(harness.sessionStore.findByThreadKey(THREAD_KEY)).toEqual({
        id: 1,
        threadKey: THREAD_KEY,
        projectPath: PROJECT_PATH,
        driverSessionId: 'fake-session-1',
        worktreePath: `${WORKTREES_ROOT}/amb-session-1`,
        createdAt: '2026-07-19T00:00:01.000Z',
        updatedAt: '2026-07-19T00:00:03.000Z',
      });
      expect(harness.fake!.startTaskCalls).toEqual([
        { prompt: PROMPT, cwd: `${WORKTREES_ROOT}/amb-session-1`, dryRun: false },
      ]);
      expect(harness.lookupTerms).toEqual(['proj-a']);
    });

    it('call order pin (D-P4B8-3 steps 5-6): RUNNING → session.create → createWorktree → recordWorktreePath → startTask → recordDriverSessionId → COMPLETED', async () => {
      const harness = setup();

      await dispatchIntent(input(), harness.deps);

      expect(harness.calls).toEqual([
        'intent.transition:RUNNING',
        'session.create',
        'createWorktree',
        'session.recordWorktreePath',
        'driver.startTask',
        'session.recordDriverSessionId',
        'intent.transition:COMPLETED',
      ]);
    });

    it('createWorktree input equality: repoRoot = the matched project path, baseRef/worktreesRoot from deps, taskId = amb-session-<row id>', async () => {
      const harness = setup();

      await dispatchIntent(input(), harness.deps);

      expect(harness.createWorktreeCalls).toEqual([
        {
          repoRoot: PROJECT_PATH,
          baseRef: BASE_REF,
          worktreesRoot: WORKTREES_ROOT,
          taskId: 'amb-session-1',
        },
      ]);
    });

    it('terminal failed ⇒ intent FAILED with reason === errorText, outcome executed carrying the failed terminal', async () => {
      const harness = setup({
        script: [[AGENT_MESSAGE, { kind: 'failed', errorText: 'task blew up' }]],
      });

      const outcome = await dispatchIntent(input(), harness.deps);

      expect(outcome).toEqual({
        kind: 'executed',
        verdict: 'DISPATCH_NEW',
        terminal: { kind: 'failed', errorText: 'task blew up' },
        events: [AGENT_MESSAGE, { kind: 'failed', errorText: 'task blew up' }],
      });
      const intent = harness.intentStore.getById(INTENT_ID);
      expect(intent?.status).toBe('FAILED');
      expect(intent?.statusReason).toBe('task blew up');
    });

    it('handle.sessionId null (early exit before thread.started) ⇒ recordDriverSessionId never called, driver_session_id stays NULL, the synthesized failed lands as FAILED', async () => {
      const startTaskCalls: AgentTaskInput[] = [];
      // Hand-rolled stub, not FakeAgentDriver: the fake always mints a
      // session id, and its own doc says runtime shapes it cannot model
      // need a stub. Per the drivers/types.ts stream contract, a driver
      // whose subprocess dies before thread.started synthesizes `failed`.
      const nullSessionDriver: AgentDriver = {
        capabilities: () => ({ supportsResume: true, agentName: 'stub-null-session' }),
        startTask: async (taskInput) => {
          startTaskCalls.push(taskInput);
          return { sessionId: null };
        },
        resumeTask: () => {
          throw new Error('stub: resumeTask must not be called in this test');
        },
        streamEvents: () =>
          (async function* (): AsyncGenerator<DriverEvent> {
            yield { kind: 'failed', errorText: 'agent exited before thread.started' };
          })(),
        close: () => Promise.resolve(),
      };
      const harness = setup({ driver: nullSessionDriver });

      const outcome = await dispatchIntent(input(), harness.deps);

      expect(outcome).toEqual({
        kind: 'executed',
        verdict: 'DISPATCH_NEW',
        terminal: { kind: 'failed', errorText: 'agent exited before thread.started' },
        events: [{ kind: 'failed', errorText: 'agent exited before thread.started' }],
      });
      expect(startTaskCalls).toHaveLength(1);
      expect(harness.calls).not.toContain('session.recordDriverSessionId');
      const session = harness.sessionStore.findByThreadKey(THREAD_KEY);
      expect(session?.driverSessionId).toBeNull();
      expect(session?.worktreePath).toBe(`${WORKTREES_ROOT}/amb-session-1`);
      const intent = harness.intentStore.getById(INTENT_ID);
      expect(intent?.status).toBe('FAILED');
      expect(intent?.statusReason).toBe('agent exited before thread.started');
    });

    it('createWorktree rejection ⇒ RUNNING→FAILED with stage WORKTREE, prefixed reason, and the driver never starts', async () => {
      const harness = setup({ createWorktreeError: new Error('git worktree add exploded') });

      const outcome = await dispatchIntent(input(), harness.deps);

      expect(outcome).toEqual({
        kind: 'dispatch-failed',
        stage: 'WORKTREE',
        reason: 'WORKTREE: git worktree add exploded',
      });
      const intent = harness.intentStore.getById(INTENT_ID);
      expect(intent?.status).toBe('FAILED');
      expect(intent?.statusReason).toBe('WORKTREE: git worktree add exploded');
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.calls).not.toContain('session.recordWorktreePath');
      // The session row itself REMAINS (commitment marker; partial-dispatch
      // recovery is the daemon batch's) — with both fill-ins still NULL.
      expect(harness.sessionStore.findByThreadKey(THREAD_KEY)?.worktreePath).toBeNull();
    });

    it('startTask rejection (failOnStart) ⇒ stage DRIVER_START, prefixed reason, session row keeps worktree_path with driver_session_id NULL', async () => {
      const failingFake = new FakeAgentDriver([], { failOnStart: true });
      const harness = setup({ driver: failingFake });

      const outcome = await dispatchIntent(input(), harness.deps);

      expect(outcome).toEqual({
        kind: 'dispatch-failed',
        stage: 'DRIVER_START',
        reason: 'DRIVER_START: FakeAgentDriver: startTask failed (failOnStart option is set)',
      });
      const intent = harness.intentStore.getById(INTENT_ID);
      expect(intent?.status).toBe('FAILED');
      expect(intent?.statusReason).toBe(
        'DRIVER_START: FakeAgentDriver: startTask failed (failOnStart option is set)',
      );
      const session = harness.sessionStore.findByThreadKey(THREAD_KEY);
      expect(session?.worktreePath).toBe(`${WORKTREES_ROOT}/amb-session-1`);
      expect(session?.driverSessionId).toBeNull();
    });
  });

  describe('CONTINUE_SESSION', () => {
    it('happy path: resumeTask gets the persisted driver session id and cwd = persisted worktree path; no new session row, zero createWorktree', async () => {
      const harness = setup({
        existingSession: {
          driverSessionId: DRIVER_SESSION_ID,
          worktreePath: SEEDED_WORKTREE_PATH,
        },
      });

      const outcome = await dispatchIntent(input({ term: null }), harness.deps);

      expect(outcome).toEqual({
        kind: 'executed',
        verdict: 'CONTINUE_SESSION',
        terminal: COMPLETED_EVENT,
        events: [AGENT_MESSAGE, TOOL_ACTIVITY, COMPLETED_EVENT],
      });
      expect(harness.fake!.resumeTaskCalls).toEqual([
        {
          sessionId: DRIVER_SESSION_ID,
          input: { prompt: PROMPT, cwd: SEEDED_WORKTREE_PATH, dryRun: false },
        },
      ]);
      expect(harness.directoryExistsCalls).toEqual([SEEDED_WORKTREE_PATH]);
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.sessionStore.listByProject(PROJECT_PATH)).toHaveLength(1);
      // Resume records NOTHING back onto the session row (the driver id is
      // already pinned first-write; the fake even mints a DIFFERENT id on
      // resume, so a mutant that re-records it would throw right here).
      expect(harness.calls).toEqual([
        'intent.transition:RUNNING',
        'driver.resumeTask',
        'intent.transition:COMPLETED',
      ]);
      expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('COMPLETED');
    });

    it('driverSessionId NULL ⇒ FAILED SESSION_STATE_INCOMPLETE (stage SESSION_STATE), zero driver calls, directoryExists never consulted', async () => {
      const harness = setup({
        existingSession: { driverSessionId: null, worktreePath: SEEDED_WORKTREE_PATH },
      });

      const outcome = await dispatchIntent(input({ term: null }), harness.deps);

      expect(outcome).toEqual({
        kind: 'dispatch-failed',
        stage: 'SESSION_STATE',
        reason: 'SESSION_STATE_INCOMPLETE',
      });
      const intent = harness.intentStore.getById(INTENT_ID);
      expect(intent?.status).toBe('FAILED');
      expect(intent?.statusReason).toBe('SESSION_STATE_INCOMPLETE');
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.fake!.resumeTaskCalls).toEqual([]);
      expect(harness.directoryExistsCalls).toEqual([]);
    });

    it('worktreePath NULL ⇒ FAILED SESSION_STATE_INCOMPLETE (stage SESSION_STATE), zero driver calls, directoryExists never consulted', async () => {
      const harness = setup({
        existingSession: { driverSessionId: DRIVER_SESSION_ID, worktreePath: null },
      });

      const outcome = await dispatchIntent(input({ term: null }), harness.deps);

      expect(outcome).toEqual({
        kind: 'dispatch-failed',
        stage: 'SESSION_STATE',
        reason: 'SESSION_STATE_INCOMPLETE',
      });
      expect(harness.intentStore.getById(INTENT_ID)?.statusReason).toBe(
        'SESSION_STATE_INCOMPLETE',
      );
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.fake!.resumeTaskCalls).toEqual([]);
      expect(harness.directoryExistsCalls).toEqual([]);
    });

    it('persisted worktree directory gone ⇒ FAILED WORKTREE_MISSING (stage WORKTREE), zero driver calls — fail closed, never auto-recreate', async () => {
      const harness = setup({
        existingSession: {
          driverSessionId: DRIVER_SESSION_ID,
          worktreePath: SEEDED_WORKTREE_PATH,
        },
        directoryExistsResult: false,
      });

      const outcome = await dispatchIntent(input({ term: null }), harness.deps);

      expect(outcome).toEqual({
        kind: 'dispatch-failed',
        stage: 'WORKTREE',
        reason: 'WORKTREE_MISSING',
      });
      const intent = harness.intentStore.getById(INTENT_ID);
      expect(intent?.status).toBe('FAILED');
      expect(intent?.statusReason).toBe('WORKTREE_MISSING');
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.fake!.resumeTaskCalls).toEqual([]);
      expect(harness.createWorktreeCalls).toEqual([]);
    });

    it('resumeTask sync throw ⇒ stage DRIVER_START with prefixed reason (D-P4B8-3 step 9 covers the resume arm too)', async () => {
      const resumeThrowingDriver: AgentDriver = {
        capabilities: () => ({ supportsResume: true, agentName: 'stub-resume-throw' }),
        startTask: () => Promise.reject(new Error('stub: startTask must not be called')),
        resumeTask: () => Promise.reject(new Error('resume exploded')),
        streamEvents: () => {
          throw new Error('stub: streamEvents must not be called');
        },
        close: () => Promise.resolve(),
      };
      const harness = setup({
        driver: resumeThrowingDriver,
        existingSession: {
          driverSessionId: DRIVER_SESSION_ID,
          worktreePath: SEEDED_WORKTREE_PATH,
        },
      });

      const outcome = await dispatchIntent(input({ term: null }), harness.deps);

      expect(outcome).toEqual({
        kind: 'dispatch-failed',
        stage: 'DRIVER_START',
        reason: 'DRIVER_START: resume exploded',
      });
      expect(harness.intentStore.getById(INTENT_ID)?.statusReason).toBe(
        'DRIVER_START: resume exploded',
      );
    });
  });

  describe('driver stream anomalies (D-P4B8-3 step 8 — seam-contract reliance, fail closed)', () => {
    it('stream ending WITHOUT a terminal event ⇒ throws (never guesses an outcome), intent left RUNNING for the daemon restart contract', async () => {
      // Hand-rolled stub: FakeAgentDriver's constructor REJECTS a
      // terminal-less script by design (its own doc says runtime contract
      // violations need a stub) — this is exactly that named case.
      const terminalLessDriver: AgentDriver = {
        capabilities: () => ({ supportsResume: true, agentName: 'stub-no-terminal' }),
        startTask: async () => ({ sessionId: 'stub-session-1' }),
        resumeTask: () => {
          throw new Error('stub: resumeTask must not be called in this test');
        },
        streamEvents: () =>
          (async function* (): AsyncGenerator<DriverEvent> {
            yield AGENT_MESSAGE;
            yield TOOL_ACTIVITY;
          })(),
        close: () => Promise.resolve(),
      };
      const harness = setup({ driver: terminalLessDriver });

      await expect(dispatchIntent(input(), harness.deps)).rejects.toThrow(
        /driver event stream ended without a terminal event/,
      );

      // Fail closed means NO terminal status was guessed: the intent stays
      // RUNNING — reason still null, updated_at still the RUNNING draw
      // (tick 0) — and the daemon's INTERRUPTED_BY_RESTART contract is
      // what eventually fails it, never this use case inventing an ending.
      expect(harness.intentStore.getById(INTENT_ID)).toEqual({
        id: INTENT_ID,
        // The seeded command is the first row in a fresh :memory: db.
        commandId: 1,
        status: 'RUNNING',
        dryRun: false,
        statusReason: null,
        updatedAt: '2026-07-19T00:00:00.000Z',
      });
    });

    it('stream REJECTING mid-iteration propagates VERBATIM (not an enumerated catch point in D-P4B8-3 step 9), intent left RUNNING', async () => {
      const midStreamError = new Error('stream connection lost');
      const rejectingDriver: AgentDriver = {
        capabilities: () => ({ supportsResume: true, agentName: 'stub-mid-stream-reject' }),
        startTask: async () => ({ sessionId: 'stub-session-1' }),
        resumeTask: () => {
          throw new Error('stub: resumeTask must not be called in this test');
        },
        streamEvents: () =>
          (async function* (): AsyncGenerator<DriverEvent> {
            yield AGENT_MESSAGE;
            throw midStreamError;
          })(),
        close: () => Promise.resolve(),
      };
      const harness = setup({ driver: rejectingDriver });

      // Identity assert: the rejection IS the stub's own error object —
      // nothing wrapped it, nothing swallowed it.
      await expect(dispatchIntent(input(), harness.deps)).rejects.toBe(midStreamError);

      expect(harness.intentStore.getById(INTENT_ID)).toEqual({
        id: INTENT_ID,
        // The seeded command is the first row in a fresh :memory: db.
        commandId: 1,
        status: 'RUNNING',
        dryRun: false,
        statusReason: null,
        updatedAt: '2026-07-19T00:00:00.000Z',
      });
    });
  });

  describe('clarification short-circuit (D-P4B8-3 step 3)', () => {
    const AMBIGUOUS_ENTRIES: readonly ProjectEntry[] = [
      { name: 'api', path: '/tmp/fixtures/roots/work/api', aliases: ['backend'] },
      { name: 'api', path: '/tmp/fixtures/roots/personal/api', aliases: [] },
    ];

    it('CLARIFY_AMBIGUOUS: outcome carries the PROJECTED candidates ({name, path} only — aliases dropped), intent row untouched, zero side effects', async () => {
      const harness = setup({ entries: AMBIGUOUS_ENTRIES });
      const before = harness.intentStore.getById(INTENT_ID);

      const outcome = await dispatchIntent(input({ term: 'api' }), harness.deps);

      // toEqual fails on extra properties, so this also pins the
      // ProjectEntry→RoutingCandidate projection (no `aliases` key).
      expect(outcome).toEqual({
        kind: 'clarification-needed',
        verdict: {
          kind: 'CLARIFY_AMBIGUOUS',
          candidates: [
            { name: 'api', path: '/tmp/fixtures/roots/work/api' },
            { name: 'api', path: '/tmp/fixtures/roots/personal/api' },
          ],
        },
      });
      expect(harness.intentStore.getById(INTENT_ID)).toEqual(before);
      expect(harness.calls).toEqual([]);
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.directoryExistsCalls).toEqual([]);
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.fake!.resumeTaskCalls).toEqual([]);
      expect(harness.sessionStore.findByThreadKey(THREAD_KEY)).toBeUndefined();
    });

    it('CLARIFY_NO_MATCH: outcome shape, intent stays PENDING with the row untouched, zero side effects', async () => {
      const harness = setup();
      const before = harness.intentStore.getById(INTENT_ID);

      const outcome = await dispatchIntent(input({ term: 'no-such-project' }), harness.deps);

      expect(outcome).toEqual({
        kind: 'clarification-needed',
        verdict: { kind: 'CLARIFY_NO_MATCH' },
      });
      expect(harness.intentStore.getById(INTENT_ID)).toEqual(before);
      expect(before?.status).toBe('PENDING');
      expect(harness.calls).toEqual([]);
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.directoryExistsCalls).toEqual([]);
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.fake!.resumeTaskCalls).toEqual([]);
    });

    it('clarification BEATS dry-run: a dry-run intent with an ambiguous term still clarifies and stays PENDING (never SKIPPED_DRY_RUN)', async () => {
      const harness = setup({ dryRun: true, entries: AMBIGUOUS_ENTRIES });

      const outcome = await dispatchIntent(input({ term: 'api' }), harness.deps);

      expect(outcome.kind).toBe('clarification-needed');
      const intent = harness.intentStore.getById(INTENT_ID);
      expect(intent?.status).toBe('PENDING');
      expect(harness.calls).toEqual([]);
    });
  });

  describe('dry-run short-circuit (D-P4B8-3 step 4)', () => {
    it('DISPATCH_NEW verdict + dryRun ⇒ SKIPPED_DRY_RUN with the full verdict in the outcome, zero session/worktree/driver', async () => {
      const harness = setup({ dryRun: true });

      const outcome = await dispatchIntent(input(), harness.deps);

      expect(outcome).toEqual({
        kind: 'skipped-dry-run',
        verdict: { kind: 'DISPATCH_NEW', project: { name: 'proj-a', path: PROJECT_PATH } },
      });
      expect(harness.intentStore.getById(INTENT_ID)).toEqual({
        id: INTENT_ID,
        // The seeded command is the first row in a fresh :memory: db.
        commandId: 1,
        status: 'SKIPPED_DRY_RUN',
        dryRun: true,
        statusReason: null,
        updatedAt: '2026-07-19T00:00:00.000Z',
      });
      expect(harness.calls).toEqual(['intent.transition:SKIPPED_DRY_RUN']);
      expect(harness.sessionStore.findByThreadKey(THREAD_KEY)).toBeUndefined();
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.fake!.resumeTaskCalls).toEqual([]);
    });

    it('CONTINUE_SESSION verdict + dryRun ⇒ SKIPPED_DRY_RUN, session row untouched, zero driver calls', async () => {
      const harness = setup({
        dryRun: true,
        existingSession: {
          driverSessionId: DRIVER_SESSION_ID,
          worktreePath: SEEDED_WORKTREE_PATH,
        },
      });
      const sessionBefore = harness.sessionStore.findByThreadKey(THREAD_KEY);

      const outcome = await dispatchIntent(input({ term: null }), harness.deps);

      // The verdict's session view is the RoutingSessionView PROJECTION of
      // the stored row ({projectPath, driverSessionId} — no worktreePath
      // key), pinned by toEqual's extra-property check.
      expect(outcome).toEqual({
        kind: 'skipped-dry-run',
        verdict: {
          kind: 'CONTINUE_SESSION',
          session: { projectPath: PROJECT_PATH, driverSessionId: DRIVER_SESSION_ID },
        },
      });
      expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('SKIPPED_DRY_RUN');
      expect(harness.calls).toEqual(['intent.transition:SKIPPED_DRY_RUN']);
      expect(harness.sessionStore.findByThreadKey(THREAD_KEY)).toEqual(sessionBefore);
      expect(harness.directoryExistsCalls).toEqual([]);
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.fake!.resumeTaskCalls).toEqual([]);
    });
  });

  describe('caller-bug fail closed (D-P4B8-3 step 1)', () => {
    it('missing intent ⇒ throws, zero side effects', async () => {
      const harness = setup({ seedIntent: false });

      await expect(dispatchIntent(input(), harness.deps)).rejects.toThrow(
        /no intent with id intent-0001/,
      );
      expect(harness.calls).toEqual([]);
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.fake!.startTaskCalls).toEqual([]);
      expect(harness.sessionStore.findByThreadKey(THREAD_KEY)).toBeUndefined();
    });

    it('non-PENDING intent ⇒ throws naming the status, row untouched, zero side effects', async () => {
      const harness = setup({ intentStatus: 'RUNNING' });
      const before = harness.intentStore.getById(INTENT_ID);

      await expect(dispatchIntent(input(), harness.deps)).rejects.toThrow(/expected PENDING/);
      expect(harness.intentStore.getById(INTENT_ID)).toEqual(before);
      expect(before?.status).toBe('RUNNING');
      expect(harness.calls).toEqual([]);
      expect(harness.fake!.startTaskCalls).toEqual([]);
    });
  });

  it('term null ⇒ index.lookup is NEVER called (D-P4B8-3 step 2), and with no session the verdict falls through to CLARIFY_NO_MATCH', async () => {
    const harness = setup();

    const outcome = await dispatchIntent(input({ term: null }), harness.deps);

    expect(harness.lookupTerms).toEqual([]);
    expect(outcome).toEqual({
      kind: 'clarification-needed',
      verdict: { kind: 'CLARIFY_NO_MATCH' },
    });
  });
});

// executeDispatchVerdict is the execution tail (steps 4-9) that dispatchIntent
// now delegates to. The coordinator layer (ADR-0006 batch E) drives it
// DIRECTLY with a verdict it resolved itself (resolveCoordinatorDispatch) plus
// the threadKey-fetched session row — never through routeCommand. These pin
// that reuse (including that the router is never consulted — lookupTerms stays
// empty); the exhaustive step 4-9 branch coverage stays above (same code).
describe('executeDispatchVerdict (ADR-0006 batch E — the coordinator reuses the tail)', () => {
  it('drives DISPATCH_NEW on a clean thread: fresh row + tree + startTask, intent COMPLETED, router never consulted', async () => {
    const harness = setup();

    const outcome = await executeDispatchVerdict(
      { kind: 'DISPATCH_NEW', project: { name: 'proj-a', path: PROJECT_PATH } },
      { intentId: INTENT_ID, threadKey: THREAD_KEY, prompt: PROMPT },
      { dryRun: false },
      undefined,
      harness.deps,
    );

    expect(outcome).toEqual({
      kind: 'executed',
      verdict: 'DISPATCH_NEW',
      terminal: COMPLETED_EVENT,
      events: DEFAULT_SEGMENT,
    });
    expect(harness.calls).toEqual([
      'intent.transition:RUNNING',
      'session.create',
      'createWorktree',
      'session.recordWorktreePath',
      'driver.startTask',
      'session.recordDriverSessionId',
      'intent.transition:COMPLETED',
    ]);
    // the tail did NOT re-derive the verdict — no index lookup happened here
    expect(harness.lookupTerms).toEqual([]);
    expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('COMPLETED');
  });

  it('drives CONTINUE_SESSION from a caller-supplied verdict + existing row: resumeTask, no new row/tree', async () => {
    const harness = setup({
      existingSession: {
        driverSessionId: DRIVER_SESSION_ID,
        worktreePath: SEEDED_WORKTREE_PATH,
      },
    });
    const existing = harness.sessionStore.findByThreadKey(THREAD_KEY);

    const outcome = await executeDispatchVerdict(
      {
        kind: 'CONTINUE_SESSION',
        session: { projectPath: PROJECT_PATH, driverSessionId: DRIVER_SESSION_ID },
      },
      { intentId: INTENT_ID, threadKey: THREAD_KEY, prompt: PROMPT },
      { dryRun: false },
      existing,
      harness.deps,
    );

    expect(outcome).toEqual({
      kind: 'executed',
      verdict: 'CONTINUE_SESSION',
      terminal: COMPLETED_EVENT,
      events: [AGENT_MESSAGE, TOOL_ACTIVITY, COMPLETED_EVENT],
    });
    expect(harness.fake!.resumeTaskCalls).toEqual([
      {
        sessionId: DRIVER_SESSION_ID,
        input: { prompt: PROMPT, cwd: SEEDED_WORKTREE_PATH, dryRun: false },
      },
    ]);
    expect(harness.directoryExistsCalls).toEqual([SEEDED_WORKTREE_PATH]);
    expect(harness.createWorktreeCalls).toEqual([]);
    expect(harness.lookupTerms).toEqual([]);
    expect(harness.calls).toEqual([
      'intent.transition:RUNNING',
      'driver.resumeTask',
      'intent.transition:COMPLETED',
    ]);
    expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('COMPLETED');
  });

  it('honors dry-run without consulting the router: SKIPPED_DRY_RUN, zero session/worktree/driver', async () => {
    const harness = setup({ dryRun: true });

    const outcome = await executeDispatchVerdict(
      { kind: 'DISPATCH_NEW', project: { name: 'proj-a', path: PROJECT_PATH } },
      { intentId: INTENT_ID, threadKey: THREAD_KEY, prompt: PROMPT },
      { dryRun: true },
      undefined,
      harness.deps,
    );

    expect(outcome).toEqual({
      kind: 'skipped-dry-run',
      verdict: { kind: 'DISPATCH_NEW', project: { name: 'proj-a', path: PROJECT_PATH } },
    });
    expect(harness.calls).toEqual(['intent.transition:SKIPPED_DRY_RUN']);
    expect(harness.lookupTerms).toEqual([]);
    expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('SKIPPED_DRY_RUN');
  });
});
