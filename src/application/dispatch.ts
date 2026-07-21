/**
 * `dispatchIntent` use case (decisions D-P4B8-2/3, Phase 4 batch 8 plan
 * docs/superpowers/plans/2026-07-19-phase-4-batch8-dispatch-pipeline.md):
 * takes one PENDING dispatch intent plus the ALREADY-EXTRACTED command
 * inputs (term/prompt — extraction rules await the real-device
 * walkthrough, spec line 213), obtains a routing verdict from
 * `routeCommand`, executes it against the injected worktree/driver seams,
 * writes the intent's terminal status back, and returns a structured
 * `DispatchOutcome` for the reply-assembly batch to render. Injection
 * style follows `ingest.ts`: every collaborator (stores, project index,
 * driver, a NARROWED worktree-creation function, a directory-existence
 * probe, the clock) arrives via `DispatchDeps`, so unit tests drive the
 * whole orchestration with a real in-memory store and zero IO.
 *
 * Orchestration order (D-P4B8-3, NORMATIVE — each step is pinned by
 * tests/unit/dispatch.test.ts, including a full call-sequence assertion):
 *
 *   1. `intentStore.getById`: missing or non-PENDING THROWS — the daemon
 *      feeds this use case PENDING intents only. A RUNNING leftover from a
 *      crash is the daemon's INTERRUPTED_BY_RESTART recovery contract
 *      (`domain/intentState.ts`), never quietly "resumed" here.
 *   2. Verdict (pure segment, zero side effects): look up the thread's
 *      session mapping, project the pieces `routeCommand` needs, decide.
 *      When `term` is null the index lookup is NOT performed at all
 *      (test-pinned zero calls) — `routeCommand`'s input contract asks for
 *      `[]` matches in that case, and skipping the call outright means no
 *      code path exists in which a null term can still probe the index.
 *      `ProjectEntry` is projected down to `RoutingCandidate` ({name,
 *      path}); aliases never enter the verdict.
 *   3. `CLARIFY_*` short-circuits: outcome `clarification-needed`, intent
 *      REMAINS PENDING, zero side effects. Creating the clarification
 *      record + token is deliberately NOT done here — the token must go
 *      into the clarification mail, so record creation is designed
 *      together with mail assembly in the clarification batch; the intent
 *      only leaves PENDING once that lifecycle resolves (or the daemon
 *      expires it). Clarification beats dry-run when both hold: a
 *      clarification is not an execution, so there is nothing for dry-run
 *      to skip.
 *   4. Executable verdict + `intent.dryRun` ⇒ PENDING→SKIPPED_DRY_RUN and
 *      outcome `skipped-dry-run` — no session row, no worktree, no driver
 *      call. The driver's own `dryRun: true` throw-guard stays UNREACHABLE
 *      from this pipeline (defense in depth: `startTask`/`resumeTask` are
 *      only ever called with `dryRun: false` below).
 *   5. PENDING→RUNNING lands FIRST, before any committing side effect —
 *      the transition's read-assert re-checks PENDING one more time, so a
 *      caller-bug race trips the state machine before anything external
 *      has happened.
 *   6. DISPATCH_NEW: session row first (`sessionStore.create` — the row IS
 *      the dispatch commitment marker, deliberately ahead of every
 *      external side effect so a crash leaves a discoverable marker, not
 *      an orphan worktree); then `taskId = 'amb-session-' + row id` — the
 *      row id is a positive integer rendered in decimal, and
 *      `'amb-session-' + digits` is lowercase-alphanumeric-with-hyphens
 *      well under 64 chars, so it ALWAYS matches `worktreeManager.ts`'s
 *      TASK_ID_PATTERN by construction; then `createWorktree` (repoRoot is
 *      the matched project's index path — the only trusted path source,
 *      `projectIndex.ts`'s core invariant); then `recordWorktreePath`;
 *      then `driver.startTask`. A non-null `handle.sessionId` is recorded
 *      via `recordDriverSessionId`; a null one (driver exited before
 *      thread.started) records nothing — the stream contract obliges the
 *      driver to synthesize `failed`, which step 8 then persists.
 *   7. CONTINUE_SESSION: no new row, no new tree. A session row missing
 *      `driverSessionId` or `worktreePath` is partial-dispatch residue ⇒
 *      FAILED `'SESSION_STATE_INCOMPLETE'` (stage SESSION_STATE); a
 *      persisted worktree directory that no longer exists ⇒ FAILED
 *      `'WORKTREE_MISSING'` (stage WORKTREE) — both FAIL CLOSED with zero
 *      driver calls, never auto-rebuild (recovery policy is the daemon
 *      batch's). Otherwise `driver.resumeTask(driverSessionId, ...)` with
 *      cwd = the PERSISTED worktree path: a codex session's working state
 *      lives in that tree (D-P4B8-1), resume must return to it.
 *   8. Consume `streamEvents` to the terminal event (the seam contract —
 *      `drivers/types.ts` — guarantees exactly one, last; a stream ending
 *      without one is a driver-implementation bug and throws, fail
 *      closed): `completed` ⇒ RUNNING→COMPLETED, `failed` ⇒ RUNNING→FAILED
 *      with `reason = errorText`; outcome `executed` carries the terminal
 *      plus the FULL buffered event list (buffering caps are the daemon
 *      batch's concern).
 *   9. Sync-throw fallback for 6c/6e/7-resume: caught ⇒ RUNNING→FAILED
 *      with a stage-prefixed `describeError` reason and outcome
 *      `dispatch-failed` (stage WORKTREE / DRIVER_START).
 *
 * `dispatch_intents.status_reason` is LOCAL DB runtime state and may
 * legitimately contain real filesystem paths (red line 2 governs
 * git/logs/mail, not the local store) — no scrubbing happens here.
 * Rendering any of this into a reply mail carries threat-model C9's scrub
 * obligation and belongs to the reply-assembly batch; that batch must
 * treat `DispatchOutcome` (events, reasons) as unscrubbed input.
 *
 * No console, no `Date.now()`/`new Date()`: time only ever arrives through
 * `deps.clock` so the orchestration stays deterministic under test.
 */
import type { AgentDriver, AgentTaskHandle, DriverEvent } from '../drivers/types.js';
import { routeCommand } from '../domain/routing.js';
import type { RouteVerdict, RoutingCandidate, RoutingSessionView } from '../domain/routing.js';
import type { IntentStore } from '../store/intentStore.js';
import type { SessionStore, SessionSummary } from '../store/sessionStore.js';
import type { ProjectIndex } from './projectIndex.js';
import type { CreateWorktreeInput } from './worktreeManager.js';

export interface DispatchInput {
  /** Must point at a PENDING intent; anything else throws (caller bug,
   *  fail closed — see step 1 in the module doc comment). */
  intentId: string;
  threadKey: string;
  /** The already-extracted project term; extraction failed/absent = null. */
  term: string | null;
  /** The already-extracted task text (the prompt fed to the driver). */
  prompt: string;
}

export interface DispatchDeps {
  intentStore: IntentStore;
  sessionStore: SessionStore;
  index: ProjectIndex;
  driver: AgentDriver;
  /** Narrowed injection: production binds `createTaskWorktree` +
   *  `buildDefaultWorktreeIo`; tests inject a fake. */
  createWorktree(input: CreateWorktreeInput): Promise<{ worktreePath: string; baseCommit: string }>;
  /** Pre-resume check that the persisted worktree directory still exists
   *  (fail closed — step 7). */
  directoryExists(path: string): Promise<boolean>;
  worktreesRoot: string;
  baseRef: string;
  /** ISO clock (production binding: `() => new Date().toISOString()`). */
  clock(): string;
}

export type DispatchOutcome =
  | {
      kind: 'executed';
      verdict: 'DISPATCH_NEW' | 'CONTINUE_SESSION';
      terminal: Extract<DriverEvent, { kind: 'completed' | 'failed' }>;
      /** Full event stream (terminal included, last); buffering caps are
       *  the daemon batch's concern. */
      events: readonly DriverEvent[];
    }
  | {
      kind: 'clarification-needed';
      verdict: Extract<RouteVerdict, { kind: 'CLARIFY_AMBIGUOUS' | 'CLARIFY_NO_MATCH' }>;
    }
  | { kind: 'skipped-dry-run'; verdict: RouteVerdict }
  | { kind: 'dispatch-failed'; stage: 'SESSION_STATE' | 'WORKTREE' | 'DRIVER_START'; reason: string };

/** Duplicated per-file by convention (see `worktreeManager.ts`,
 * `projectIndex.ts`, `src/cli/doctor.ts`) rather than shared. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatchIntent(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  // Step 1: only a PENDING intent may be dispatched — anything else is a
  // caller bug, surfaced loudly before any side effect at all.
  const intent = deps.intentStore.getById(input.intentId);
  if (intent === undefined) {
    throw new Error(`dispatchIntent: no intent with id ${input.intentId} — refusing to dispatch`);
  }
  if (intent.status !== 'PENDING') {
    throw new Error(
      `dispatchIntent: intent ${input.intentId} has status ${intent.status}, expected PENDING — ` +
        `the daemon feeds this use case PENDING intents only (a RUNNING leftover is the daemon's ` +
        `INTERRUPTED_BY_RESTART recovery contract, see domain/intentState.ts)`,
    );
  }

  // Step 2: verdict — pure segment, zero side effects. Null term ⇒ the
  // index is never consulted (test-pinned; see module doc comment).
  const existing = deps.sessionStore.findByThreadKey(input.threadKey);
  const existingSession: RoutingSessionView | null = existing
    ? { projectPath: existing.projectPath, driverSessionId: existing.driverSessionId }
    : null;
  const matches: readonly RoutingCandidate[] =
    input.term === null
      ? []
      : deps.index.lookup(input.term).map((entry) => ({ name: entry.name, path: entry.path }));
  const verdict = routeCommand({ term: input.term, existingSession, matches });

  // Step 3: clarification short-circuits — intent stays PENDING, zero side
  // effects; beats dry-run (a clarification is not an execution).
  if (verdict.kind === 'CLARIFY_AMBIGUOUS' || verdict.kind === 'CLARIFY_NO_MATCH') {
    return { kind: 'clarification-needed', verdict };
  }

  // Steps 4-9: the shared execution tail. The coordinator layer (ADR-0006,
  // batch E) reuses it directly with its own resolved verdict + the same
  // threadKey-fetched session row, so both callers drive ONE committing
  // pipeline. `existing` is passed through (not re-fetched) so the committing
  // call sequence is identical whichever caller drives it.
  return executeDispatchVerdict(verdict, input, intent, existing, deps);
}

/** The two executable verdicts. Reaching `executeDispatchVerdict` with a
 *  `DISPATCH_NEW` whose `existing` is non-null is legitimate — it is the
 *  coordinator's 旧线程换新任务 (a reply on an old thread that kicks off a
 *  fresh task), which `routeCommand` structurally cannot produce because it
 *  gives thread continuity absolute priority. The DISPATCH_NEW arm never
 *  reads `existing`; it always creates a fresh row + tree. */
type ExecutableVerdict = Extract<RouteVerdict, { kind: 'DISPATCH_NEW' | 'CONTINUE_SESSION' }>;

/**
 * The execution tail (D-P4B8-3 steps 4-9), factored out of `dispatchIntent`
 * so BOTH the deterministic router and the coordinator layer (ADR-0006,
 * batch E) drive the SAME committing pipeline: dry-run short-circuit,
 * PENDING→RUNNING, DISPATCH_NEW / CONTINUE_SESSION execution, stream
 * consumption, terminal persistence.
 *
 * The caller supplies the EXECUTABLE `verdict`, `intent.dryRun`, and the
 * ALREADY-fetched `existing` session row (looked up by threadKey upstream,
 * never model-supplied). The tail performs no `findByThreadKey` of its own,
 * so the committing call sequence is identical whichever caller drives it.
 *
 * PENDING is assumed (the caller checked it — `dispatchIntent` in step 1, the
 * coordinator orchestrator before it resolves a verdict); step 5's transition
 * re-asserts PENDING and fails closed on a race regardless. `dispatchIntent`'s
 * module doc comment remains the normative description of steps 4-9.
 */
export async function executeDispatchVerdict(
  verdict: ExecutableVerdict,
  input: { readonly intentId: string; readonly threadKey: string; readonly prompt: string },
  intent: { readonly dryRun: boolean },
  existing: SessionSummary | undefined,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  // Step 4: dry-run short-circuits an executable verdict — no session row,
  // no worktree, no driver call.
  if (intent.dryRun) {
    deps.intentStore.transition(input.intentId, 'SKIPPED_DRY_RUN', null, deps.clock());
    return { kind: 'skipped-dry-run', verdict };
  }

  // Step 5: the execution marker lands FIRST — transition's read-assert
  // re-checks PENDING before any committing side effect below.
  deps.intentStore.transition(input.intentId, 'RUNNING', null, deps.clock());

  // Step 9's shared landing: RUNNING→FAILED with a stage-tagged reason.
  const failDispatch = (
    stage: 'SESSION_STATE' | 'WORKTREE' | 'DRIVER_START',
    reason: string,
  ): DispatchOutcome => {
    deps.intentStore.transition(input.intentId, 'FAILED', reason, deps.clock());
    return { kind: 'dispatch-failed', stage, reason };
  };

  let handle: AgentTaskHandle;
  if (verdict.kind === 'DISPATCH_NEW') {
    // Step 6a: the session row is the dispatch commitment marker — created
    // before every external side effect.
    const session = deps.sessionStore.create({
      threadKey: input.threadKey,
      projectPath: verdict.project.path,
      now: deps.clock(),
    });

    // Step 6b: decimal row id ⇒ 'amb-session-<digits>' always satisfies
    // worktreeManager's TASK_ID_PATTERN by construction (module doc).
    const taskId = `amb-session-${String(session.id)}`;

    // Step 6c (+9): bridge-owned worktree off the trusted index path.
    let worktreePath: string;
    try {
      const created = await deps.createWorktree({
        repoRoot: verdict.project.path,
        baseRef: deps.baseRef,
        worktreesRoot: deps.worktreesRoot,
        taskId,
      });
      worktreePath = created.worktreePath;
    } catch (error) {
      return failDispatch('WORKTREE', `WORKTREE: ${describeError(error)}`);
    }

    // Step 6d: persist the tree location before the driver ever runs —
    // resume must be able to find its way back (D-P4B8-1).
    deps.sessionStore.recordWorktreePath(session.id, worktreePath, deps.clock());

    // Step 6e (+9): hand the task to the driver, inside the new tree.
    try {
      handle = await deps.driver.startTask({
        prompt: input.prompt,
        cwd: worktreePath,
        dryRun: false,
      });
    } catch (error) {
      return failDispatch('DRIVER_START', `DRIVER_START: ${describeError(error)}`);
    }

    // Step 6f: record the driver's session id when it exposed one; a null
    // id means the driver exited before thread.started — nothing to
    // record, and step 8 persists the synthesized failure.
    if (handle.sessionId !== null) {
      deps.sessionStore.recordDriverSessionId(session.id, handle.sessionId, deps.clock());
    }
  } else {
    // Step 7: CONTINUE_SESSION — no new row, no new tree, fail closed on
    // partial-dispatch residue (recovery policy is the daemon batch's).
    if (existing === undefined) {
      // routeCommand only returns CONTINUE_SESSION when an existing session
      // view was supplied, and that view came from this very row; the
      // coordinator path fails a session-less `continue` closed to a
      // clarification BEFORE it reaches here (resolveCoordinatorDispatch).
      // So a CONTINUE_SESSION with no row is always a caller bug: throw.
      throw new Error(
        `dispatchIntent: CONTINUE_SESSION verdict without a session row for thread ` +
          `${input.threadKey} (unexpected)`,
      );
    }
    if (existing.driverSessionId === null || existing.worktreePath === null) {
      return failDispatch('SESSION_STATE', 'SESSION_STATE_INCOMPLETE');
    }
    if (!(await deps.directoryExists(existing.worktreePath))) {
      return failDispatch('WORKTREE', 'WORKTREE_MISSING');
    }
    try {
      handle = await deps.driver.resumeTask(existing.driverSessionId, {
        prompt: input.prompt,
        cwd: existing.worktreePath,
        dryRun: false,
      });
    } catch (error) {
      return failDispatch('DRIVER_START', `DRIVER_START: ${describeError(error)}`);
    }
  }

  // Step 8: consume the stream to its single trailing terminal event and
  // persist the intent's terminal status accordingly.
  const events: DriverEvent[] = [];
  let terminal: Extract<DriverEvent, { kind: 'completed' | 'failed' }> | null = null;
  for await (const event of deps.driver.streamEvents(handle)) {
    events.push(event);
    if (event.kind === 'completed' || event.kind === 'failed') {
      terminal = event;
    }
  }
  if (terminal === null) {
    // The seam contract (drivers/types.ts) obliges every driver — real or
    // fake — to end with exactly one terminal event, synthesizing `failed`
    // if the subprocess died silently. A stream that still ends without
    // one is a driver-implementation bug: throw rather than guess an
    // outcome (the intent stays RUNNING; the daemon's restart contract is
    // what eventually fails it).
    throw new Error(
      'dispatchIntent: driver event stream ended without a terminal event — ' +
        'seam-contract violation (see drivers/types.ts)',
    );
  }
  if (terminal.kind === 'completed') {
    deps.intentStore.transition(input.intentId, 'COMPLETED', null, deps.clock());
  } else {
    deps.intentStore.transition(input.intentId, 'FAILED', terminal.errorText, deps.clock());
  }
  return { kind: 'executed', verdict: verdict.kind, terminal, events };
}
