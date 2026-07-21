import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coordinateCommand } from '../../src/application/coordinatorOrchestrator.js';
import type {
  CoordinateDeps,
  CoordinateInput,
} from '../../src/application/coordinatorOrchestrator.js';
import type { ProjectEntry, ProjectIndex } from '../../src/application/projectIndex.js';
import type { CreateWorktreeInput } from '../../src/application/worktreeManager.js';
import type { CoordinatorDecision } from '../../src/domain/coordinatorDecision.js';
import type {
  CoordinatorRunInput,
  CoordinatorRunOutcome,
} from '../../src/drivers/coordinatorDriver.js';
import type { DriverEvent } from '../../src/drivers/types.js';
import { openDatabase } from '../../src/store/database.js';
import { CommandStore } from '../../src/store/commandStore.js';
import { IntentStore } from '../../src/store/intentStore.js';
import { SessionStore } from '../../src/store/sessionStore.js';
import { FakeAgentDriver } from '../helpers/fakeAgentDriver.js';

// The coordinator orchestrator (ADR-0006 batch E-c) turns one coordinator turn
// into a concrete action: build the prompt from redacted snapshots, run the
// injected read-only coordinator, then map the VALIDATED decision —
//   answer   -> a free-text meta-query reply outcome
//   clarify  -> a clarification outcome
//   dispatch -> resolveCoordinatorDispatch + executeDispatchVerdict (the E-a tail)
//   (turn failed) -> fall back so the daemon runs its deterministic path.
// Test style mirrors dispatch.test.ts: REAL in-memory stores (the intent state
// machine + the session first-write invariants stay armed) + injected fakes for
// all IO (a scripted RunCoordinatorTurn instead of codex, a FakeAgentDriver, a
// scripted createWorktree, a deterministic ticking clock). Fixture discipline
// (public repo): placeholder ids, synthetic /tmp/fixtures/* paths, low-entropy
// session ids.

type Db = ReturnType<typeof openDatabase>;

const INTENT_ID = 'intent-0001';
const THREAD_KEY = 'thread-key-0001';
const PROJECT_PATH = '/tmp/fixtures/roots/proj-a';
const PROJECT_B_PATH = '/tmp/fixtures/roots/proj-b';
const WORKTREES_ROOT = '/tmp/fixtures/worktrees';
const BASE_REF = 'main';
const MAIL_BODY = 'please run the quarterly cleanup in proj-a';
const TASK_PROMPT = 'run the quarterly cleanup task';
const DRIVER_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const SEEDED_WORKTREE_PATH = `${WORKTREES_ROOT}/amb-session-1`;
const COORD_SESSION_ID = '00000000-0000-4000-8000-0000000000c0';
const SEED_NOW = '2026-07-18T00:00:00.000Z';
const SCHEMA_PATH = '/tmp/fixtures/coord/schema.json';
const COORD_CWD = '/tmp/fixtures/coord/scratch';

const COMPLETED_EVENT: DriverEvent = { kind: 'completed', resultText: 'all done' };
const DEFAULT_SEGMENT: readonly DriverEvent[] = [
  { kind: 'agent-message', text: 'working on it' },
  { kind: 'tool-activity', summary: 'edited 2 files' },
  COMPLETED_EVENT,
];

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
  dryRun?: boolean;
  entries?: readonly ProjectEntry[];
  existingSession?: { driverSessionId: string | null; worktreePath: string | null };
  script?: readonly (readonly DriverEvent[])[];
  resumeSessionId?: string | null;
  /** The scripted coordinator turn result the injected driver returns. */
  turn: CoordinatorRunOutcome;
}

interface Harness {
  intentStore: IntentStore;
  sessionStore: SessionStore;
  fake: FakeAgentDriver;
  deps: CoordinateDeps;
  input: CoordinateInput;
  lookupTerms: string[];
  createWorktreeCalls: CreateWorktreeInput[];
  coordinatorRuns: CoordinatorRunInput[];
}

function setup(options: SetupOptions): Harness {
  const db = openDatabase(':memory:');
  openDbs.push(db);

  const commandStore = new CommandStore(db);
  const intentStore = new IntentStore(db);
  const sessionStore = new SessionStore(db);

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

  const fake = new FakeAgentDriver(options.script ?? [DEFAULT_SEGMENT]);

  const createWorktreeCalls: CreateWorktreeInput[] = [];
  const coordinatorRuns: CoordinatorRunInput[] = [];
  let tick = 0;

  const deps: CoordinateDeps = {
    intentStore,
    sessionStore,
    index,
    driver: fake,
    createWorktree: async (createInput) => {
      createWorktreeCalls.push(createInput);
      return {
        worktreePath: `${WORKTREES_ROOT}/${createInput.taskId}`,
        baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
    },
    directoryExists: async () => true,
    worktreesRoot: WORKTREES_ROOT,
    baseRef: BASE_REF,
    clock: () => new Date(Date.UTC(2026, 6, 19, 0, 0, tick++)).toISOString(),
    runCoordinatorTurn: async (runInput) => {
      coordinatorRuns.push(runInput);
      return options.turn;
    },
    coordinatorCwd: COORD_CWD,
    schemaPath: SCHEMA_PATH,
    coordinatorExtraArgs: ['--config', 'x'],
  };

  const input: CoordinateInput = {
    intentId: INTENT_ID,
    threadKey: THREAD_KEY,
    mailBody: MAIL_BODY,
    dryRun: options.dryRun ?? false,
    ...(options.resumeSessionId !== undefined
      ? { resumeSessionId: options.resumeSessionId }
      : {}),
  };

  return {
    intentStore,
    sessionStore,
    fake,
    deps,
    input,
    lookupTerms,
    createWorktreeCalls,
    coordinatorRuns,
  };
}

function decided(
  decision: CoordinatorDecision,
  sessionId: string | null = COORD_SESSION_ID,
): CoordinatorRunOutcome {
  return { kind: 'decided', decision, sessionId };
}

describe('coordinateCommand — decision mapping (ADR-0006 batch E-c)', () => {
  describe('answer', () => {
    it('returns an answer outcome with the coordinator text + session id, touching no dispatch machinery', async () => {
      const harness = setup({ turn: decided({ kind: 'answer', text: 'two sessions are active.' }) });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome).toEqual({
        kind: 'answer',
        text: 'two sessions are active.',
        coordinatorSessionId: COORD_SESSION_ID,
      });
      // A meta-query answer routes nothing and dispatches nothing.
      expect(harness.lookupTerms).toEqual([]);
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.fake.startTaskCalls).toEqual([]);
      // The intent is left PENDING for the daemon to finalize after the reply.
      expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('PENDING');
    });
  });

  describe('clarify', () => {
    it('passes the question through, options absent when the coordinator gave none', async () => {
      const harness = setup({
        turn: decided({ kind: 'clarify', question: 'which project did you mean?' }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome).toEqual({
        kind: 'clarify',
        question: 'which project did you mean?',
        options: undefined,
        coordinatorSessionId: COORD_SESSION_ID,
      });
      expect(harness.lookupTerms).toEqual([]);
      expect(harness.createWorktreeCalls).toEqual([]);
    });

    it('passes the coordinator-supplied options through verbatim', async () => {
      const harness = setup({
        turn: decided({ kind: 'clarify', question: 'which one?', options: ['proj-a', 'proj-b'] }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome).toEqual({
        kind: 'clarify',
        question: 'which one?',
        options: ['proj-a', 'proj-b'],
        coordinatorSessionId: COORD_SESSION_ID,
      });
    });
  });

  describe('dispatch', () => {
    it('mode=new on a clean thread: sole match -> DISPATCH_NEW -> executeDispatchVerdict runs the tail', async () => {
      const harness = setup({
        turn: decided({ kind: 'dispatch', projectAlias: 'proj-a', prompt: TASK_PROMPT, mode: 'new' }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome.kind).toBe('dispatched');
      if (outcome.kind !== 'dispatched') throw new Error('unreachable');
      expect(outcome.outcome).toEqual({
        kind: 'executed',
        verdict: 'DISPATCH_NEW',
        terminal: COMPLETED_EVENT,
        events: DEFAULT_SEGMENT,
      });
      expect(outcome.coordinatorSessionId).toBe(COORD_SESSION_ID);
      // The coordinator's alias was resolved through the trusted index.
      expect(harness.lookupTerms).toEqual(['proj-a']);
      // The task prompt fed to the driver is the coordinator's, NOT the mail body.
      expect(harness.fake.startTaskCalls).toEqual([
        { prompt: TASK_PROMPT, cwd: SEEDED_WORKTREE_PATH, dryRun: false },
      ]);
      expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('COMPLETED');
    });

    it('mode=new on a thread that already has a session: DISPATCH_NEW still opens a fresh row (旧线程换新任务)', async () => {
      const harness = setup({
        existingSession: { driverSessionId: DRIVER_SESSION_ID, worktreePath: SEEDED_WORKTREE_PATH },
        turn: decided({ kind: 'dispatch', projectAlias: 'proj-a', prompt: TASK_PROMPT, mode: 'new' }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome.kind).toBe('dispatched');
      // A second session row now exists on the same thread; findByThreadKey
      // returns the latest (migration 006 dropped the thread_key UNIQUE).
      expect(harness.sessionStore.listAll()).toHaveLength(2);
      expect(harness.sessionStore.findByThreadKey(THREAD_KEY)?.id).toBe(2);
      // A brand-new worktree was cut — the old session was NOT resumed.
      expect(harness.fake.resumeTaskCalls).toEqual([]);
      expect(harness.createWorktreeCalls).toHaveLength(1);
    });

    it('mode=continue with an existing session: CONTINUE_SESSION resumes, no new row/tree, index never consulted', async () => {
      const harness = setup({
        existingSession: { driverSessionId: DRIVER_SESSION_ID, worktreePath: SEEDED_WORKTREE_PATH },
        turn: decided({
          kind: 'dispatch',
          projectAlias: 'proj-a',
          prompt: TASK_PROMPT,
          mode: 'continue',
        }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome.kind).toBe('dispatched');
      if (outcome.kind !== 'dispatched') throw new Error('unreachable');
      expect(outcome.outcome.kind).toBe('executed');
      expect(harness.fake.resumeTaskCalls).toEqual([
        {
          sessionId: DRIVER_SESSION_ID,
          input: { prompt: TASK_PROMPT, cwd: SEEDED_WORKTREE_PATH, dryRun: false },
        },
      ]);
      expect(harness.createWorktreeCalls).toEqual([]);
      // continue routes off the existing session, never the alias.
      expect(harness.lookupTerms).toEqual([]);
    });

    it('mode=continue with NO existing session: fails closed to a clarification, never dispatches', async () => {
      const harness = setup({
        turn: decided({
          kind: 'dispatch',
          projectAlias: 'proj-a',
          prompt: TASK_PROMPT,
          mode: 'continue',
        }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome.kind).toBe('clarify');
      expect(harness.fake.resumeTaskCalls).toEqual([]);
      expect(harness.fake.startTaskCalls).toEqual([]);
      expect(harness.createWorktreeCalls).toEqual([]);
    });

    it('mode=new with an ambiguous alias: CLARIFY_AMBIGUOUS -> clarify listing the candidate names', async () => {
      const harness = setup({
        entries: [
          { name: 'proj-a', path: PROJECT_PATH, aliases: ['shared'] },
          { name: 'proj-b', path: PROJECT_B_PATH, aliases: ['shared'] },
        ],
        turn: decided({ kind: 'dispatch', projectAlias: 'shared', prompt: TASK_PROMPT, mode: 'new' }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome.kind).toBe('clarify');
      if (outcome.kind !== 'clarify') throw new Error('unreachable');
      expect(outcome.options).toEqual(['proj-a', 'proj-b']);
      expect(harness.createWorktreeCalls).toEqual([]);
    });

    it('mode=new with no matching alias: CLARIFY_NO_MATCH -> clarify, never dispatches', async () => {
      const harness = setup({
        turn: decided({ kind: 'dispatch', projectAlias: 'ghost', prompt: TASK_PROMPT, mode: 'new' }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome.kind).toBe('clarify');
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.fake.startTaskCalls).toEqual([]);
    });

    it('honors dry-run: the shared tail short-circuits to skipped-dry-run', async () => {
      const harness = setup({
        dryRun: true,
        turn: decided({ kind: 'dispatch', projectAlias: 'proj-a', prompt: TASK_PROMPT, mode: 'new' }),
      });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome.kind).toBe('dispatched');
      if (outcome.kind !== 'dispatched') throw new Error('unreachable');
      expect(outcome.outcome.kind).toBe('skipped-dry-run');
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('SKIPPED_DRY_RUN');
    });
  });

  describe('coordinator failure', () => {
    it('falls back with the driver reason, running no routing or dispatch', async () => {
      const harness = setup({ turn: { kind: 'failed', reason: 'codex crashed: no terminal' } });

      const outcome = await coordinateCommand(harness.input, harness.deps);

      expect(outcome).toEqual({ kind: 'fell-back', reason: 'codex crashed: no terminal' });
      expect(harness.lookupTerms).toEqual([]);
      expect(harness.createWorktreeCalls).toEqual([]);
      expect(harness.fake.startTaskCalls).toEqual([]);
      // Nothing ran — the intent is untouched for the deterministic fallback.
      expect(harness.intentStore.getById(INTENT_ID)?.status).toBe('PENDING');
    });
  });

  describe('turn wiring', () => {
    it('builds the prompt from the mail body and passes cwd/schemaPath/extraArgs/resume into the turn', async () => {
      const harness = setup({
        resumeSessionId: COORD_SESSION_ID,
        turn: decided({ kind: 'answer', text: 'ok' }),
      });

      await coordinateCommand(harness.input, harness.deps);

      expect(harness.coordinatorRuns).toHaveLength(1);
      const run = harness.coordinatorRuns[0]!;
      expect(run.cwd).toBe(COORD_CWD);
      expect(run.schemaPath).toBe(SCHEMA_PATH);
      expect(run.extraArgs).toEqual(['--config', 'x']);
      expect(run.resumeSessionId).toBe(COORD_SESSION_ID);
      // The untrusted mail body is present in the prompt (fenced as data by
      // buildCoordinatorPrompt), which is strictly larger than the body alone.
      expect(run.prompt).toContain(MAIL_BODY);
      expect(run.prompt.length).toBeGreaterThan(MAIL_BODY.length);
    });

    it('passes resumeSessionId=undefined into the turn when none was supplied', async () => {
      const harness = setup({ turn: decided({ kind: 'answer', text: 'ok' }) });

      await coordinateCommand(harness.input, harness.deps);

      expect(harness.coordinatorRuns[0]!.resumeSessionId).toBeUndefined();
    });
  });
});
