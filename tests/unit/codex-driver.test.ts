import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { createCodexDriver } from '../../src/drivers/codexDriver.js';
import type { SpawnCodex, SpawnedCodex } from '../../src/drivers/codexDriver.js';
import type { AgentTaskInput, DriverEvent } from '../../src/drivers/types.js';

// Guards decisions D-P4B6-1..5 (plan docs/superpowers/plans/
// 2026-07-19-phase-4-batch6-codex-driver.md): the real `codex exec --json`
// driver on the batch-1 AgentDriver seam, driven ENTIRELY through a scripted
// `SpawnCodex` fake — zero real codex spawns, zero model quota (real-binary
// E2E is a separate user-gated step, AGENTS.md red line 5). The JSONL
// vocabulary the fixtures speak is ADR-0004's measured contract
// (docs/adr/0004-p0-2-codex-exec-session-semantics.md).
//
// Fixture hygiene: thread ids are LOW-ENTROPY placeholders
// (00000000-0000-4000-8000-...) so no high-entropy string ever lands in the
// repo for a secrets scanner to flag (AGENTS.md test-credentials section),
// and every cwd/stderr path is a placeholder like /tmp/amb-fake-worktree —
// the ONE real local path used anywhere here, os.homedir(), is computed at
// RUNTIME to prove scrubbing and never appears in this file's text
// (AGENTS.md red line 2).

const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const BOGUS_THREAD_ID = '00000000-0000-4000-8000-000000000002';
const SECOND_THREAD_ID = '00000000-0000-4000-8000-000000000003';
const FAKE_CWD = '/tmp/amb-fake-worktree';

// Handwritten JSONL fixture lines (D-P4B6-5): explicit strings, never
// round-tripped through JSON.stringify, so a parser bug cannot hide behind
// symmetric serialization.
const THREAD_STARTED_LINE = `{"type":"thread.started","thread_id":"${THREAD_ID}"}`;
const SECOND_THREAD_STARTED_LINE = `{"type":"thread.started","thread_id":"${SECOND_THREAD_ID}"}`;
const TURN_STARTED_LINE = '{"type":"turn.started"}';
const TURN_COMPLETED_LINE =
  '{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":0,"output_tokens":3}}';

function agentMessageLine(text: string): string {
  return `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"${text}"}}`;
}

const ERROR_ITEM_LINE =
  '{"type":"item.completed","item":{"id":"item_1","type":"error","message":"skills: context budget exceeded, skipping"}}';
const COMMAND_ITEM_LINE =
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"pnpm test"}}';
const UNKNOWN_ITEM_LINE =
  '{"type":"item.completed","item":{"id":"item_3","type":"mystery_future_item"}}';
const UNKNOWN_TOP_LEVEL_LINE = '{"type":"future.telemetry","payload":{"n":1}}';
const MALFORMED_JSON_LINE = '{"type":"item.completed","item":{{{ definitely not json';

function taskInput(overrides: Partial<AgentTaskInput> = {}): AgentTaskInput {
  return {
    prompt: 'fix the failing test',
    cwd: FAKE_CWD,
    dryRun: false,
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

/** Narrows to a `failed` event or throws with a readable message. */
function expectFailed(event: DriverEvent | undefined): { kind: 'failed'; errorText: string } {
  if (event === undefined || event.kind !== 'failed') {
    throw new Error(`expected a failed event, got ${JSON.stringify(event)}`);
  }
  return event;
}

// ---------------------------------------------------------------------------
// Scripted SpawnCodex fake
// ---------------------------------------------------------------------------

interface SpawnScript {
  /** When true the test drives the process by hand via the FakeSpawnedCodex
   *  instance (pushLine/exit/kill); the auto fields below are ignored. */
  manual?: boolean;
  stdoutLines?: readonly string[];
  /** Default 0. `null` models signal-terminated (same as `child_process`). */
  exitCode?: number | null;
  stderrText?: string;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Single-consumer push channel backing FakeSpawnedCodex.stdout. */
function lineChannel(): {
  iterable: AsyncIterable<string>;
  push: (line: string) => void;
  close: () => void;
} {
  const buffer: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    if (wake !== null) {
      const current = wake;
      wake = null;
      current();
    }
  };
  return {
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          async next(): Promise<IteratorResult<string>> {
            for (;;) {
              const line = buffer.shift();
              if (line !== undefined) {
                return { value: line, done: false };
              }
              if (closed) {
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          },
        };
      },
    },
    push(line) {
      buffer.push(line);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
  };
}

/**
 * Scripted stand-in for one spawned `codex` process. Auto mode pre-loads
 * stdout and pre-resolves the exit; manual mode leaves both open for the
 * test to drive. `kill()` behaves like SIGTERM on a live process: stdout
 * ends and the exit resolves `{ code: null }` (idempotent on an
 * already-finished process, like `child.kill()`).
 */
class FakeSpawnedCodex implements SpawnedCodex {
  readonly stdout: AsyncIterable<string>;
  readonly stderr: Promise<string>;
  readonly exited: Promise<{ code: number | null }>;
  killCalls = 0;

  private readonly channel = lineChannel();
  private readonly exitDeferred = deferred<{ code: number | null }>();

  constructor(script: SpawnScript) {
    this.stdout = this.channel.iterable;
    this.stderr = Promise.resolve(script.stderrText ?? '');
    this.exited = this.exitDeferred.promise;
    if (script.manual !== true) {
      for (const line of script.stdoutLines ?? []) {
        this.channel.push(line);
      }
      this.channel.close();
      this.exitDeferred.resolve({ code: script.exitCode ?? 0 });
    }
  }

  pushLine(line: string): void {
    this.channel.push(line);
  }

  exit(code: number | null): void {
    this.channel.close();
    this.exitDeferred.resolve({ code });
  }

  kill(): void {
    this.killCalls += 1;
    this.channel.close();
    this.exitDeferred.resolve({ code: null });
  }
}

interface SpawnHarness {
  spawnCodex: SpawnCodex;
  /** Every spawn, in call order — argv recorded verbatim for per-element
   *  full-equality assertions (worktreeManager fake-io test style). */
  calls: { argv: readonly string[]; cwd: string }[];
  spawned: FakeSpawnedCodex[];
}

/** One script per expected spawn; an unscripted spawn throws loudly. */
function spawnHarness(scripts: readonly SpawnScript[]): SpawnHarness {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  const spawned: FakeSpawnedCodex[] = [];
  const spawnCodex: SpawnCodex = (argv, opts) => {
    const script = scripts[calls.length];
    if (script === undefined) {
      throw new Error(`fake spawnCodex: unexpected spawn #${String(calls.length + 1)}`);
    }
    calls.push({ argv, cwd: opts.cwd });
    const proc = new FakeSpawnedCodex(script);
    spawned.push(proc);
    return proc;
  };
  return { spawnCodex, calls, spawned };
}

function spawnedAt(harness: SpawnHarness, index: number): FakeSpawnedCodex {
  const proc = harness.spawned[index];
  if (proc === undefined) {
    throw new Error(`no spawned process at index ${String(index)}`);
  }
  return proc;
}

const HAPPY_SCRIPT: SpawnScript = {
  stdoutLines: [
    THREAD_STARTED_LINE,
    TURN_STARTED_LINE,
    agentMessageLine('looking at the repo'),
    agentMessageLine('all tests pass now'),
    TURN_COMPLETED_LINE,
  ],
  exitCode: 0,
};

const HAPPY_EVENTS: DriverEvent[] = [
  { kind: 'agent-message', text: 'looking at the repo' },
  { kind: 'agent-message', text: 'all tests pass now' },
  { kind: 'completed', resultText: 'all tests pass now' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCodexDriver (D-P4B6-1..4, ADR-0004)', () => {
  describe('capabilities', () => {
    it('reports codex identity with resume support', () => {
      const harness = spawnHarness([]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      expect(driver.capabilities()).toEqual({ supportsResume: true, agentName: 'codex' });
    });
  });

  describe('argv construction (D-P4B6-2, C6 ceiling)', () => {
    it('startTask spawns exactly the locked exec argv, element for element', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      await driver.startTask(taskInput({ prompt: 'fix the failing test' }));

      expect(harness.calls).toEqual([
        {
          argv: [
            'exec',
            '--json',
            '--sandbox',
            'workspace-write',
            '-C',
            FAKE_CWD,
            'fix the failing test',
          ],
          cwd: FAKE_CWD,
        },
      ]);
    });

    it('resumeTask spawns exactly the locked resume argv — no --sandbox (ADR-0004 option asymmetry)', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      await driver.resumeTask(THREAD_ID, taskInput({ prompt: 'continue the task' }));

      expect(harness.calls).toEqual([
        {
          argv: ['exec', 'resume', THREAD_ID, '--json', 'continue the task'],
          cwd: FAKE_CWD,
        },
      ]);
    });

    // The full-equality assertions above already forbid any extra flag; this
    // spells the intent out so the forbidden names are grep-able next to the
    // red line they enforce (AGENTS.md: no --dangerously-bypass-*, no
    // danger-full-access; ADR-0004: --ephemeral breaks resume).
    it('never passes the forbidden flags in any argv', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT, HAPPY_SCRIPT]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      await driver.startTask(taskInput());
      await driver.resumeTask(THREAD_ID, taskInput());

      const allElements = harness.calls.flatMap((call) => [...call.argv]);
      expect(allElements).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(allElements).not.toContain('--ephemeral');
      for (const element of allElements) {
        expect(element).not.toMatch(/dangerously|danger-full-access|--ephemeral/);
      }
    });
  });

  describe('caller-bug rejection gates (synchronous throw, zero spawn)', () => {
    it('startTask throws on dryRun without spawning', () => {
      const harness = spawnHarness([]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      expect(() => driver.startTask(taskInput({ dryRun: true }))).toThrow(/dryRun/);
      expect(harness.calls).toEqual([]);
    });

    it('resumeTask throws on dryRun without spawning', () => {
      const harness = spawnHarness([]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      expect(() => driver.resumeTask(THREAD_ID, taskInput({ dryRun: true }))).toThrow(/dryRun/);
      expect(harness.calls).toEqual([]);
    });

    it('resumeTask rejects an uppercase UUID without spawning', () => {
      const harness = spawnHarness([]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      expect(() =>
        driver.resumeTask('00000000-0000-4000-8000-00000000000A', taskInput()),
      ).toThrow(/sessionId/);
      expect(harness.calls).toEqual([]);
    });

    it('resumeTask rejects an option-shaped sessionId (--last) without spawning', () => {
      const harness = spawnHarness([]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      expect(() => driver.resumeTask('--last', taskInput())).toThrow(/sessionId/);
      expect(harness.calls).toEqual([]);
    });

    it('resumeTask rejects a non-UUID string without spawning', () => {
      const harness = spawnHarness([]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      expect(() => driver.resumeTask('not-a-uuid', taskInput())).toThrow(/sessionId/);
      expect(harness.calls).toEqual([]);
    });
  });

  describe('session identity (ADR-0004 evidence 1/2)', () => {
    it('captures thread.started.thread_id as the handle sessionId', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());

      expect(handle.sessionId).toBe(THREAD_ID);
    });

    it('resolves startTask with a null sessionId when the process exits before thread.started', async () => {
      const harness = spawnHarness([{ stdoutLines: [], exitCode: 1, stderrText: 'boom' }]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(handle.sessionId).toBeNull();
      expect(events).toEqual([{ kind: 'failed', errorText: 'codex exited with code 1: boom' }]);
    });
  });

  describe('event mapping (ADR-0004 measured vocabulary)', () => {
    it('maps agent_message items to agent-message events and completes with the LAST message text', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual(HAPPY_EVENTS);
    });

    it('completes with an empty resultText when no agent_message ever arrived', async () => {
      const harness = spawnHarness([
        { stdoutLines: [THREAD_STARTED_LINE, TURN_COMPLETED_LINE], exitCode: 0 },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual([{ kind: 'completed', resultText: '' }]);
    });

    it('maps error items to tool-activity diagnostics and NEVER fails the run on them', async () => {
      const harness = spawnHarness([
        {
          stdoutLines: [THREAD_STARTED_LINE, TURN_STARTED_LINE, ERROR_ITEM_LINE, TURN_COMPLETED_LINE],
          exitCode: 0,
        },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual([
        { kind: 'tool-activity', summary: 'codex diagnostic: skills: context budget exceeded, skipping' },
        { kind: 'completed', resultText: '' },
      ]);
    });

    it('maps other/unknown item types to tool-activity with the type name and any short field', async () => {
      const harness = spawnHarness([
        {
          stdoutLines: [THREAD_STARTED_LINE, COMMAND_ITEM_LINE, UNKNOWN_ITEM_LINE, TURN_COMPLETED_LINE],
          exitCode: 0,
        },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual([
        { kind: 'tool-activity', summary: 'command_execution: pnpm test' },
        { kind: 'tool-activity', summary: 'mystery_future_item' },
        { kind: 'completed', resultText: '' },
      ]);
    });

    it('tolerates unknown top-level types, malformed JSON lines and blank lines (forward compatibility)', async () => {
      const harness = spawnHarness([
        {
          stdoutLines: [
            THREAD_STARTED_LINE,
            UNKNOWN_TOP_LEVEL_LINE,
            MALFORMED_JSON_LINE,
            '',
            agentMessageLine('still here'),
            TURN_COMPLETED_LINE,
          ],
          exitCode: 0,
        },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual([
        { kind: 'agent-message', text: 'still here' },
        { kind: 'completed', resultText: 'still here' },
      ]);
    });
  });

  describe('synthesized failed terminal (seam crash contract)', () => {
    it('synthesizes exactly one trailing failed event when the process exits 0 without turn.completed', async () => {
      const harness = spawnHarness([
        { stdoutLines: [THREAD_STARTED_LINE, agentMessageLine('partial')], exitCode: 0 },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual([
        { kind: 'agent-message', text: 'partial' },
        { kind: 'failed', errorText: 'codex exited with code 0' },
      ]);
    });

    it('synthesizes failed from exit code + stderr for a bogus resume (exit 1, empty stdout, ADR-0004 evidence 3)', async () => {
      const harness = spawnHarness([
        {
          stdoutLines: [],
          exitCode: 1,
          stderrText: `thread/resume failed: no rollout found for thread id ${BOGUS_THREAD_ID} (code -32600)\n`,
        },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.resumeTask(BOGUS_THREAD_ID, taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(handle.sessionId).toBeNull();
      expect(events).toEqual([
        {
          kind: 'failed',
          errorText:
            'codex exited with code 1: thread/resume failed: no rollout found for thread id ' +
            `${BOGUS_THREAD_ID} (code -32600)`,
        },
      ]);
    });

    it('scrubs the task cwd and the real home directory out of errorText (red line 2)', async () => {
      const realHome = homedir();
      const harness = spawnHarness([
        {
          stdoutLines: [],
          exitCode: 1,
          stderrText:
            `error: cannot write ${FAKE_CWD}/src/broken.ts\n` +
            `rollout at ${realHome}/.codex/sessions/rollout-1.jsonl was rejected\n`,
        },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      const failure = expectFailed(events.at(-1));
      expect(events).toHaveLength(1);
      expect(failure.errorText).toContain('<cwd>/src/broken.ts');
      expect(failure.errorText).toContain('<home>/.codex/sessions/rollout-1.jsonl');
      expect(failure.errorText).not.toContain(FAKE_CWD);
      expect(failure.errorText).not.toContain(realHome);
    });

    it('truncates an oversized stderr summary', async () => {
      const harness = spawnHarness([
        { stdoutLines: [], exitCode: 1, stderrText: 'x'.repeat(1000) },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      const failure = expectFailed(events.at(-1));
      expect(failure.errorText).toContain('codex exited with code 1: xxx');
      expect(failure.errorText.length).toBeLessThan(500);
      expect(failure.errorText.endsWith('[stderr truncated]')).toBe(true);
    });

    it('never retracts a completed terminal: late lines are dropped and a nonzero exit adds nothing', async () => {
      const harness = spawnHarness([
        {
          stdoutLines: [
            THREAD_STARTED_LINE,
            agentMessageLine('done'),
            TURN_COMPLETED_LINE,
            agentMessageLine('ghost after terminal'),
          ],
          exitCode: 3,
        },
      ]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual([
        { kind: 'agent-message', text: 'done' },
        { kind: 'completed', resultText: 'done' },
      ]);
    });
  });

  describe('streamEvents semantics (replay pin, same as fakeAgentDriver)', () => {
    it('replays the full buffered stream from the start on every call with the same handle', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });
      const handle = await driver.startTask(taskInput());

      const first = await collect(driver.streamEvents(handle));
      const second = await collect(driver.streamEvents(handle));

      expect(first).toEqual(HAPPY_EVENTS);
      expect(second).toEqual(HAPPY_EVENTS);
    });

    it('lets a second consumer starting mid-stream replay the buffer and catch up with later events', async () => {
      const harness = spawnHarness([{ manual: true }]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const startPromise = driver.startTask(taskInput());
      const proc = spawnedAt(harness, 0);
      proc.pushLine(THREAD_STARTED_LINE);
      const handle = await startPromise;

      const first = driver.streamEvents(handle)[Symbol.asyncIterator]();
      proc.pushLine(agentMessageLine('one'));
      await expect(first.next()).resolves.toEqual({
        done: false,
        value: { kind: 'agent-message', text: 'one' },
      });

      // 'one' is now buffered; a consumer starting NOW must replay it first,
      // then keep receiving whatever arrives later.
      const secondCollected = collect(driver.streamEvents(handle));

      proc.pushLine(agentMessageLine('two'));
      proc.pushLine(TURN_COMPLETED_LINE);
      proc.exit(0);

      const firstRest: DriverEvent[] = [];
      for (let step = await first.next(); step.done !== true; step = await first.next()) {
        firstRest.push(step.value);
      }
      expect(firstRest).toEqual([
        { kind: 'agent-message', text: 'two' },
        { kind: 'completed', resultText: 'two' },
      ]);
      await expect(secondCollected).resolves.toEqual([
        { kind: 'agent-message', text: 'one' },
        { kind: 'agent-message', text: 'two' },
        { kind: 'completed', resultText: 'two' },
      ]);
    });

    it('accepts a structurally equal handle carrying a known sessionId (value lookup, mirroring the fake)', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });
      await driver.startTask(taskInput());

      const events = await collect(driver.streamEvents({ sessionId: THREAD_ID }));

      expect(events).toEqual(HAPPY_EVENTS);
    });

    it('throws synchronously for a handle this instance never issued', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });
      await driver.startTask(taskInput());

      expect(() => driver.streamEvents({ sessionId: BOGUS_THREAD_ID })).toThrow(/no known task/);
      expect(() => driver.streamEvents({ sessionId: null })).toThrow(/no known task/);
    });
  });

  describe('close (kill running processes, keep buffered handles replayable)', () => {
    it('kills only the still-running process, synthesizes its failed terminal, keeps finished handles replayable, and is idempotent', async () => {
      const harness = spawnHarness([HAPPY_SCRIPT, { manual: true }]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      const finishedHandle = await driver.startTask(taskInput());
      // Draining the stream to its terminal parks until the task's consume
      // loop fully settled — THAT is what makes this task "finished" from
      // the driver's point of view (a process may exit microtasks before
      // the loop settles; close() kills by loop state, not exit state).
      await expect(collect(driver.streamEvents(finishedHandle))).resolves.toEqual(HAPPY_EVENTS);

      const runningPromise = driver.startTask(taskInput({ prompt: 'long running task' }));
      const runningProc = spawnedAt(harness, 1);
      runningProc.pushLine(SECOND_THREAD_STARTED_LINE);
      const runningHandle = await runningPromise;

      await driver.close();

      expect(spawnedAt(harness, 0).killCalls).toBe(0);
      expect(runningProc.killCalls).toBe(1);
      await expect(collect(driver.streamEvents(runningHandle))).resolves.toEqual([
        { kind: 'failed', errorText: 'codex exited with code null' },
      ]);
      // close-does-not-invalidate (fakeAgentDriver pin): buffered streams
      // stay fully replayable after close.
      await expect(collect(driver.streamEvents(finishedHandle))).resolves.toEqual(HAPPY_EVENTS);

      await driver.close();
      expect(runningProc.killCalls).toBe(1);
    });

    it('resolves immediately when no task was ever started', async () => {
      const harness = spawnHarness([]);
      const driver = createCodexDriver({ spawnCodex: harness.spawnCodex });

      await expect(driver.close()).resolves.toBeUndefined();
    });
  });
});
