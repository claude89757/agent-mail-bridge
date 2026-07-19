/**
 * Real `codex exec --json` driver on the batch-1 `AgentDriver` seam
 * (decisions D-P4B6-1..4, plan `docs/superpowers/plans/
 * 2026-07-19-phase-4-batch6-codex-driver.md`; measured subprocess contract:
 * ADR-0004, `docs/adr/0004-p0-2-codex-exec-session-semantics.md`).
 * `types.ts` stays untouched — everything here IMPLEMENTS the seam, never
 * extends it.
 *
 * Subprocess injection seam (D-P4B6-1): `SpawnCodex` below is the entire
 * surface this driver needs from the outside world. Unit tests script it
 * (`tests/unit/codex-driver.test.ts`), so the whole driver is testable with
 * ZERO model quota; driving the real binary is a separate, user-gated E2E
 * step (AGENTS.md red line 5). `buildDefaultSpawnCodex` at the bottom is
 * the ONLY place `node:child_process` appears (the `buildDefaultWorktreeIo`
 * / `buildDefaultDoctorIo` precedent) and is deliberately NOT unit-tested:
 * it is production wiring around `spawn` whose behavior only a real
 * subprocess can prove — the red-line-5 E2E covers it, fakes cannot.
 *
 * argv discipline (D-P4B6-2, threat-model C6 execution ceiling):
 *  - start: `exec --json --sandbox workspace-write -C <cwd> <prompt>` —
 *    `workspace-write` is the C6 ceiling; the prompt rides as ONE argv
 *    element and never crosses a shell (`shell: false` in the default
 *    wiring); `cwd` is a bridge-owned worktree (a real git repo), so no
 *    `--skip-git-repo-check`.
 *  - resume: `exec resume <sessionId> --json <prompt>` — NO `--sandbox`:
 *    ADR-0004 measured the option-surface asymmetry (the sandbox is fixed
 *    at session creation and rides along on resume). `sessionId` must match
 *    `CODEX_SESSION_ID_PATTERN` (lowercase-UUID whitelist) BEFORE it may
 *    enter the argv — the `COMMIT_SHA_PATTERN` precedent from
 *    `src/application/worktreeManager.ts`: the id is the only
 *    caller-supplied argv string that is not pure prompt data, so it is
 *    whitelisted to the one shape codex itself mints. A non-matching id
 *    (including `--last`, which the real CLI would happily option-scan)
 *    throws synchronously with ZERO spawn.
 *  - Forbidden flags never appear: `--dangerously-bypass-*` /
 *    `danger-full-access` (AGENTS.md red line) and `--ephemeral` (ADR-0004:
 *    it skips session persistence, which would silently break resume — the
 *    daemon's dispatches must never use it). The tests pin both argvs per
 *    element, so ANY extra flag is a red test, plus an explicit
 *    not-contains assertion documenting the intent.
 *
 * `dryRun` fails closed (D-P4B6-2): a dry-run request reaching a REAL
 * driver is an upstream bug — dry-run semantics belong to `application/`'s
 * intent handling (SKIPPED_DRY_RUN), which must short-circuit before any
 * driver call. Both entry points throw synchronously (caller-bug class,
 * like the sessionId whitelist) and never spawn.
 *
 * Event mapping (D-P4B6-3 = ADR-0004's measured JSONL vocabulary):
 *  - `thread.started` → capture `thread_id` as the handle's `sessionId`
 *    (stable across resumes, ADR-0004 evidence 2; first one wins);
 *  - `item.completed` + `agent_message` → `agent-message`, text also cached
 *    as the eventual `completed.resultText` (LAST message wins);
 *  - `item.completed` + `error` → `tool-activity` ("codex diagnostic: …"):
 *    ADR-0004 measured these as config/deprecation noise, NEVER grounds
 *    for `failed`;
 *  - any other `item.type` → `tool-activity` (type name plus the first
 *    short string field available) — forward tolerance for future item
 *    kinds;
 *  - `turn.completed` → terminal `completed`;
 *  - unknown top-level types (incl. `turn.started`) are skipped (forward
 *    compatibility, ADR-0004 Consequences); malformed JSON lines are
 *    skipped and counted (fail closed, never crash).
 *
 * Terminal synthesis — the seam module doc's crash contract, binding here:
 * "a real driver whose underlying process ends without ever emitting a
 * terminal event (crash, kill, EOF mid-stream) MUST synthesize a `failed`
 * event carrying the observed cause as `errorText`". Process exit without
 * `turn.completed` (bogus resume ids produce exactly this: exit 1, EMPTY
 * stdout, ADR-0004 evidence 3) ⇒ one synthesized `failed` ends the stream.
 * The reverse never happens: once `turn.completed` produced the `completed`
 * terminal, a later nonzero exit code does NOT retract it, and stray stdout
 * lines after the terminal are dropped — the seam promises exactly one
 * terminal event, last in the stream, so an outcome once produced never
 * changes.
 *
 * errorText hygiene (AGENTS.md red line 2): stderr may quote real local
 * paths (worktree files, `~/.codex` internals), and `errorText` flows into
 * text upper layers may print or mail. Before stderr enters `errorText`,
 * every occurrence of the task's `cwd` and of `os.homedir()` is replaced
 * with `<cwd>`/`<home>` placeholders — cwd FIRST, because a worktree under
 * the home directory would otherwise have its occurrences split in two by
 * the home replacement — and only THEN is the summary length-capped
 * (truncation before scrubbing could bisect a path and leave a live prefix
 * standing).
 *
 * streamEvents semantics: all of a task's events are buffered for the
 * task's lifetime, and EVERY `streamEvents` call replays them from the
 * start, then live-follows until the terminal event. This is deliberately
 * the SAME replay semantics `tests/helpers/fakeAgentDriver.ts` pins
 * ("replays the segment from the start … each call builds an independent
 * generator with its own cursor"): the fake's doc calls replay "a fake-only
 * affordance" because a subprocess stream cannot generally be replayed —
 * THIS driver closes that gap by buffering, so code exercised against the
 * fake meets the same behavior here. Buffers are retained until the driver
 * itself is dropped; an eviction policy is the daemon batch's lifecycle
 * concern (out of scope per the plan). `startTask`/`resumeTask` resolve
 * when `thread.started` arrives OR the process ends first — then with
 * `sessionId: null`, which the seam's `AgentTaskHandle` doc explicitly
 * allows. Subprocess failures NEVER reject the start promise; they are
 * delivered as the stream's `failed` terminal, so consumers rely on ONE
 * error path: the event stream. Only caller bugs (dryRun, malformed
 * sessionId, unknown handle) throw at the call site.
 *
 * close(): kills every still-running subprocess and awaits each task's
 * consume loop — the kill then surfaces as that task's synthesized `failed`
 * terminal. Existing handles stay fully replayable afterwards (the fake's
 * close-does-not-invalidate pin holds here for buffered streams), and the
 * instance itself stays usable, mirroring the fake. Idempotent: a second
 * close finds nothing left running.
 *
 * Layering (D-P4B6-4): imports nothing from `application/`, `store/` or
 * `transports/`; no console anywhere; `node:child_process` only inside
 * `buildDefaultSpawnCodex`.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

import type {
  AgentDriver,
  AgentTaskHandle,
  AgentTaskInput,
  DriverCapabilities,
  DriverEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Locked injection shape (D-P4B6-1)
// ---------------------------------------------------------------------------

/** Minimal subprocess surface — production is a `child_process.spawn`
 *  wrapper (`buildDefaultSpawnCodex`), tests script it. */
export interface SpawnedCodex {
  /** JSONL stdout as a LINE stream (the fake feeds string lines directly;
   *  production splits on newlines via readline). */
  stdout: AsyncIterable<string>;
  /** Aggregated stderr text — raw material for the synthesized `failed`
   *  errorText (scrubbed before use, red line 2). Must never reject. */
  stderr: Promise<string>;
  /** Process exit: `{ code }`, `null` when signal-terminated. */
  exited: Promise<{ code: number | null }>;
  kill(): void;
}

export type SpawnCodex = (argv: readonly string[], opts: { cwd: string }) => SpawnedCodex;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The one shape codex itself mints for `thread.started.thread_id`
 * (ADR-0004): a lowercase hex UUID. Everything else — uppercase, braces,
 * `--last`, arbitrary strings — is rejected BEFORE it may enter a resume
 * argv (argv-injection defense, `COMMIT_SHA_PATTERN` precedent).
 */
const CODEX_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Cap on the scrubbed stderr summary inside a synthesized errorText —
 *  enough to carry codex's own diagnostics (ADR-0004's "no rollout found"
 *  line is ~90 chars) without letting a runaway stderr flood mail bodies. */
const STDERR_SUMMARY_MAX_CHARS = 400;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** First string among `values`, or undefined — used to pick a short,
 *  human-meaningful field off an unknown item shape without trusting it. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/**
 * Literal (non-regex) global replacement. Needles shorter than 2 chars are
 * skipped as degenerate: an empty needle would match everywhere and a
 * one-char needle like `/` (a pathological homedir) would shred the text —
 * scrubbing is safety-over-fidelity, but not at the cost of destroying the
 * summary outright.
 */
function replaceAllLiteral(text: string, needle: string, placeholder: string): string {
  if (needle.length < 2) {
    return text;
  }
  return text.split(needle).join(placeholder);
}

/** Red line 2: cwd first, then home — see the module doc comment. */
function scrubLocalPaths(text: string, cwd: string, home: string): string {
  return replaceAllLiteral(replaceAllLiteral(text, cwd, '<cwd>'), home, '<home>');
}

function truncateSummary(text: string): string {
  if (text.length <= STDERR_SUMMARY_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, STDERR_SUMMARY_MAX_CHARS)}… [stderr truncated]`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Per-task bookkeeping. `handle` doubles as the identity key into
 *  `CodexDriver.statesByHandle`; its `sessionId` is mutated exactly once,
 *  when `thread.started` arrives — before the start promise resolves. */
interface TaskState {
  readonly handle: AgentTaskHandle;
  readonly spawned: SpawnedCodex;
  /** Full event buffer — replayed from index 0 by every streamEvents call. */
  readonly events: DriverEvent[];
  /** Consumers parked until the next push/finish. */
  waiters: (() => void)[];
  /** True once the consume loop finished (terminal event is buffered). */
  done: boolean;
  /** True once a terminal event was pushed — later pushes are dropped
   *  (single-terminal contract: nothing may follow the terminal event). */
  sawTerminal: boolean;
  lastAgentMessageText: string;
  /** Malformed JSONL lines tolerated so far (fail-closed accounting; not
   *  surfaced on the seam — a future diagnostics batch may expose it). */
  skippedLineCount: number;
  resolveStart: (handle: AgentTaskHandle) => void;
  /** The consume loop's completion — what close() awaits. */
  settled: Promise<void>;
}

class CodexDriver implements AgentDriver {
  /** Identity lookup: the exact handle objects start/resume returned. */
  private readonly statesByHandle = new Map<AgentTaskHandle, TaskState>();
  /**
   * Value lookup for structurally re-created handles, mirroring the fake's
   * value-keyed streamEvents. On repeated resumes of one session the id
   * re-emits unchanged (ADR-0004 evidence 2), so this index points at the
   * MOST RECENT task for that id; identity lookup still reaches the older
   * ones.
   */
  private readonly statesBySessionId = new Map<string, TaskState>();

  constructor(private readonly spawnCodex: SpawnCodex) {}

  capabilities(): DriverCapabilities {
    return { supportsResume: true, agentName: 'codex' };
  }

  startTask(input: AgentTaskInput): Promise<AgentTaskHandle> {
    this.assertNotDryRun(input, 'startTask');
    return this.launch(
      ['exec', '--json', '--sandbox', 'workspace-write', '-C', input.cwd, input.prompt],
      input.cwd,
    );
  }

  resumeTask(sessionId: string, input: AgentTaskInput): Promise<AgentTaskHandle> {
    this.assertNotDryRun(input, 'resumeTask');
    if (!CODEX_SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(
        `CodexDriver.resumeTask: sessionId ${JSON.stringify(sessionId)} is not a lowercase ` +
          `UUID — rejected before it could enter the codex argv (argv-injection guard)`,
      );
    }
    return this.launch(['exec', 'resume', sessionId, '--json', input.prompt], input.cwd);
  }

  /**
   * Validates the handle synchronously (throws on an unknown handle before
   * any iteration happens) and only THEN returns the replay generator —
   * the same split, for the same reason, as the fake's streamEvents: a
   * caller that never iterates still gets the "this handle is bogus"
   * failure right at the call site.
   */
  streamEvents(handle: AgentTaskHandle): AsyncIterable<DriverEvent> {
    const state =
      this.statesByHandle.get(handle) ??
      (handle.sessionId === null ? undefined : this.statesBySessionId.get(handle.sessionId));
    if (state === undefined) {
      throw new Error(
        `CodexDriver.streamEvents: no known task for sessionId ${String(handle.sessionId)} — ` +
          `pass back a handle this same instance's startTask/resumeTask returned.`,
      );
    }
    return this.replay(state);
  }

  /** See the module doc comment: kill still-running processes, await every
   *  consume loop, keep buffered handles replayable. Idempotent. */
  async close(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const state of this.statesByHandle.values()) {
      if (!state.done) {
        state.spawned.kill();
      }
      pending.push(state.settled);
    }
    await Promise.all(pending);
  }

  // -- internals ------------------------------------------------------------

  private assertNotDryRun(input: AgentTaskInput, method: string): void {
    if (input.dryRun) {
      throw new Error(
        `CodexDriver.${method}: dryRun task reached the real driver — dry-run semantics are ` +
          `application/'s intent handling (SKIPPED_DRY_RUN); a dry run must never spawn codex.`,
      );
    }
  }

  private launch(argv: readonly string[], cwd: string): Promise<AgentTaskHandle> {
    const spawned = this.spawnCodex(argv, { cwd });
    const handle: AgentTaskHandle = { sessionId: null };
    let resolveStart: (resolved: AgentTaskHandle) => void = () => undefined;
    const started = new Promise<AgentTaskHandle>((resolve) => {
      resolveStart = resolve;
    });
    const state: TaskState = {
      handle,
      spawned,
      events: [],
      waiters: [],
      done: false,
      sawTerminal: false,
      lastAgentMessageText: '',
      skippedLineCount: 0,
      resolveStart,
      settled: Promise.resolve(),
    };
    this.statesByHandle.set(handle, state);
    state.settled = this.consume(state, cwd);
    return started;
  }

  /**
   * The single stdout consumer for one task: parse lines until EOF, then
   * settle the outcome. A throwing stdout stream (spawn failure, mid-stream
   * IO error) is NOT itself an outcome — it falls through to the same
   * exit-code accounting, which synthesizes `failed` iff no terminal event
   * was seen (seam crash contract).
   */
  private async consume(state: TaskState, cwd: string): Promise<void> {
    try {
      for await (const line of state.spawned.stdout) {
        this.handleLine(state, line);
      }
    } catch {
      // Broken stdout stream — the exit/terminal accounting below decides.
    }
    const { code } = await state.spawned.exited;
    if (!state.sawTerminal) {
      let stderrText = '';
      try {
        stderrText = await state.spawned.stderr;
      } catch {
        // stderr unavailable — synthesize from the exit code alone.
      }
      const summary = truncateSummary(scrubLocalPaths(stderrText.trim(), cwd, homedir()));
      const errorText =
        summary === ''
          ? `codex exited with code ${String(code)}`
          : `codex exited with code ${String(code)}: ${summary}`;
      this.pushEvent(state, { kind: 'failed', errorText });
    }
    state.done = true;
    this.wake(state);
    state.resolveStart(state.handle);
  }

  /** ADR-0004 vocabulary mapping — see the module doc comment. */
  private handleLine(state: TaskState, line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      state.skippedLineCount += 1;
      return;
    }
    if (!isRecord(parsed)) {
      state.skippedLineCount += 1;
      return;
    }
    const eventType = parsed['type'];
    if (typeof eventType !== 'string') {
      state.skippedLineCount += 1;
      return;
    }

    switch (eventType) {
      case 'thread.started': {
        const threadId = parsed['thread_id'];
        if (state.handle.sessionId === null && typeof threadId === 'string') {
          state.handle.sessionId = threadId;
          this.statesBySessionId.set(threadId, state);
          state.resolveStart(state.handle);
        }
        return;
      }
      case 'item.completed': {
        this.handleItem(state, parsed['item']);
        return;
      }
      case 'turn.completed': {
        this.pushEvent(state, { kind: 'completed', resultText: state.lastAgentMessageText });
        return;
      }
      default:
        // Unknown top-level type (turn.started included): skipped, forward
        // compatible (ADR-0004 Consequences).
        return;
    }
  }

  private handleItem(state: TaskState, item: unknown): void {
    if (!isRecord(item)) {
      state.skippedLineCount += 1;
      return;
    }
    const itemType = item['type'];
    if (typeof itemType !== 'string') {
      state.skippedLineCount += 1;
      return;
    }
    if (itemType === 'agent_message') {
      const text = typeof item['text'] === 'string' ? item['text'] : '';
      state.lastAgentMessageText = text;
      this.pushEvent(state, { kind: 'agent-message', text });
      return;
    }
    if (itemType === 'error') {
      // ADR-0004: non-terminal config/deprecation noise — a diagnostic,
      // NEVER grounds for failing the run.
      const message = firstString(item['message'], item['text']) ?? '';
      this.pushEvent(state, { kind: 'tool-activity', summary: `codex diagnostic: ${message}` });
      return;
    }
    const detail = firstString(item['command'], item['message'], item['text']);
    this.pushEvent(state, {
      kind: 'tool-activity',
      summary: detail === undefined ? itemType : `${itemType}: ${detail}`,
    });
  }

  /** Single append point: enforces "nothing follows the terminal event" by
   *  dropping anything pushed after it (module doc comment). */
  private pushEvent(state: TaskState, event: DriverEvent): void {
    if (state.sawTerminal) {
      return;
    }
    state.events.push(event);
    if (event.kind === 'completed' || event.kind === 'failed') {
      state.sawTerminal = true;
    }
    this.wake(state);
  }

  private wake(state: TaskState): void {
    const waiters = state.waiters;
    state.waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  /**
   * Replay-from-the-start generator with live follow: each call owns an
   * independent cursor over the shared buffer (the fake's replay semantics),
   * and a cursor that reaches the end of a still-running task parks on the
   * waiter list until the consume loop pushes more or finishes. The
   * check-then-park sequence is safe without locks: JS runs it atomically
   * between awaits, and `wake` runs strictly after both `done = true` and
   * every push.
   */
  private async *replay(state: TaskState): AsyncGenerator<DriverEvent> {
    let index = 0;
    for (;;) {
      const event = state.events[index];
      if (event !== undefined) {
        index += 1;
        yield event;
        continue;
      }
      if (state.done) {
        return;
      }
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    }
  }
}

/** Locked factory (D-P4B6-1): the only constructor the rest of the bridge
 *  sees. `application`/`daemon` callers inject `buildDefaultSpawnCodex()`;
 *  tests inject a scripted fake. */
export function createCodexDriver(deps: { spawnCodex: SpawnCodex }): AgentDriver {
  return new CodexDriver(deps.spawnCodex);
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/**
 * Real `codex` subprocess behind `SpawnCodex` (D-P4B6-1's locked spawn
 * shape): argv array, `shell: false` (no shell ever sees the prompt),
 * `stdio: ['ignore', 'pipe', 'pipe']` — stdin closed because ADR-0004
 * measured that codex announces reading stdin when it is not a TTY; the
 * prompt travels as an argv element instead. Deliberately NOT unit-tested
 * (module doc comment): this is the one function whose correctness only a
 * real subprocess can demonstrate — covered by the user-gated red-line-5
 * E2E, like `buildDefaultWorktreeIo`'s real-git half.
 *
 * Failure shape without codex installed: `spawn` emits 'error' (no
 * process), `exited` resolves `{ code: null }`, the line stream errors and
 * ends — so the driver synthesizes the standard `failed` terminal instead
 * of throwing anywhere.
 */
export function buildDefaultSpawnCodex(): SpawnCodex {
  return (argv, opts) => {
    const child = spawn('codex', [...argv], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      // Unreachable with the 'pipe' stdio above; guards the nullable type.
      throw new Error('buildDefaultSpawnCodex: child process pipes were not created');
    }
    const stdout = createInterface({ input: childStdout, crlfDelay: Infinity });
    const stderr = new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      childStderr.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const settle = (): void => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      };
      // Resolve on either path; never reject (SpawnedCodex.stderr contract).
      childStderr.once('end', settle);
      childStderr.once('error', settle);
    });
    const exited = new Promise<{ code: number | null }>((resolve) => {
      child.once('close', (code) => {
        resolve({ code });
      });
      child.once('error', () => {
        resolve({ code: null });
      });
    });
    return {
      stdout,
      stderr,
      exited,
      kill: () => {
        child.kill();
      },
    };
  };
}
