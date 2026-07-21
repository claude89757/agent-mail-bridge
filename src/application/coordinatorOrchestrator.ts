/**
 * Coordinator orchestrator (ADR-0006, coordination batch E-c). One mail →
 * one coordinator turn → one concrete action. This is the application-layer
 * glue that the deterministic dispatch path lacked: it lets a conversational
 * codex agent (behind the identity gate) do the intent understanding that
 * `routeCommand` cannot, while every side-effecting step still flows through
 * the same audited tail (`executeDispatchVerdict`) and the same redaction
 * boundaries.
 *
 * Layering (mirrors `dispatchIntent` → `dispatchReadyCommand`): this function
 * RETURNS a `CoordinateOutcome`; it never composes or sends a reply and never
 * touches the transport. The daemon (batch E-d) maps the outcome onto the
 * reply composers + `sendReply`, finalizes the intent for the non-dispatch
 * branches, and — on `fell-back` — runs its own deterministic extraction path
 * (which needs the raw mail this layer never sees). The only side effects here
 * are the ones `executeDispatchVerdict` performs on the `dispatch` branch.
 *
 * Read-only by construction on every non-dispatch branch: `answer`/`clarify`
 * and a failed turn leave the intent PENDING and write nothing. The coordinator
 * itself runs in a read-only sandbox (see `coordinatorDriver.ts`); this layer
 * only ever forwards its VALIDATED decision.
 */
import { buildCoordinatorPrompt } from './coordinatorPrompt.js';
import { buildCoordinatorReadTools } from './coordinatorTools.js';
import { executeDispatchVerdict } from './dispatch.js';
import type { DispatchDeps, DispatchOutcome } from './dispatch.js';
import { resolveCoordinatorDispatch } from '../domain/coordinatorRouting.js';
import type { RunCoordinatorTurn } from '../drivers/coordinatorDriver.js';

/** Per-command inputs. `mailBody` is the extracted, untrusted body (fenced as
 *  data inside the prompt); `resumeSessionId` is the coordinator's OWN codex
 *  thread id for this mail thread, if one was persisted — distinct from the
 *  execution session's `driverSessionId`. */
export interface CoordinateInput {
  readonly intentId: string;
  readonly threadKey: string;
  readonly mailBody: string;
  readonly dryRun: boolean;
  readonly resumeSessionId?: string | null;
}

/**
 * `DispatchDeps` (the shared execution tail needs all of it) plus the
 * coordinator seam: an injected `runCoordinatorTurn` (the real read-only codex
 * driver in production, a scripted fake in tests) and the fixed per-daemon
 * coordinator config it is called with. `index` + `sessionStore` — already in
 * `DispatchDeps` — double as the read-tool snapshot source, so nothing extra
 * is threaded for the prompt.
 */
export interface CoordinateDeps extends DispatchDeps {
  readonly runCoordinatorTurn: RunCoordinatorTurn;
  /** Read-only scratch/meta cwd for the coordinator — never a worktree. */
  readonly coordinatorCwd: string;
  /** Temp file the decision output-schema was materialized to (batch E-d). */
  readonly schemaPath: string;
  /** MCP-config / resume-isolation argv the driver appends, if any. */
  readonly coordinatorExtraArgs?: readonly string[];
}

/**
 * What the coordinator turn resolved to, for the daemon to render + finalize:
 * - `dispatched`: a dispatch decision routed to an executable verdict and ran
 *   the shared tail; `outcome` is the very `DispatchOutcome` the deterministic
 *   path produces, so the daemon reuses its existing switch.
 * - `answer`: a read-only meta-query answer (free text) → RESULT reply.
 * - `clarify`: the coordinator asked for disambiguation, OR a dispatch alias
 *   failed to resolve (ambiguous / no match) and we fail closed to a question.
 * - `fell-back`: the coordinator turn failed; the daemon should run its
 *   deterministic extraction → dispatch path. Carries the (already redacted)
 *   driver reason for logging only.
 *
 * `coordinatorSessionId` is the codex thread id of the turn (may be null),
 * surfaced so the daemon can persist it for the next turn's resume.
 */
export type CoordinateOutcome =
  | {
      readonly kind: 'dispatched';
      readonly outcome: DispatchOutcome;
      readonly coordinatorSessionId: string | null;
    }
  | { readonly kind: 'answer'; readonly text: string; readonly coordinatorSessionId: string | null }
  | {
      readonly kind: 'clarify';
      readonly question: string;
      readonly options?: readonly string[];
      readonly coordinatorSessionId: string | null;
    }
  | { readonly kind: 'fell-back'; readonly reason: string };

export async function coordinateCommand(
  input: CoordinateInput,
  deps: CoordinateDeps,
): Promise<CoordinateOutcome> {
  const readTools = buildCoordinatorReadTools({ index: deps.index, sessionStore: deps.sessionStore });
  // One fetch, reused for the prompt's currentSessionRef AND the dispatch
  // branch's existing-row / existingSession inputs (after migration 006 this
  // is the LATEST row bound to the thread).
  const existing = deps.sessionStore.findByThreadKey(input.threadKey);

  const prompt = buildCoordinatorPrompt({
    projects: readTools.listProjects(),
    sessions: readTools.listSessions(),
    mailBody: input.mailBody,
    currentSessionRef: existing === undefined ? null : String(existing.id),
  });

  const turn = await deps.runCoordinatorTurn({
    prompt,
    cwd: deps.coordinatorCwd,
    schemaPath: deps.schemaPath,
    // Empty extraArgs is indistinguishable from absent at the driver (it just
    // appends them); `exactOptionalPropertyTypes` forbids passing `undefined`.
    extraArgs: deps.coordinatorExtraArgs ?? [],
    // resumeSessionId is `string` (never null) on the wire — omit the key
    // entirely when there is no coordinator thread to resume.
    ...(input.resumeSessionId != null ? { resumeSessionId: input.resumeSessionId } : {}),
  });

  if (turn.kind === 'failed') {
    return { kind: 'fell-back', reason: turn.reason };
  }

  const { decision, sessionId } = turn;
  switch (decision.kind) {
    case 'answer':
      return { kind: 'answer', text: decision.text, coordinatorSessionId: sessionId };

    case 'clarify':
      return {
        kind: 'clarify',
        question: decision.question,
        // Omit `options` when the coordinator gave none (exactOptional).
        ...(decision.options !== undefined ? { options: decision.options } : {}),
        coordinatorSessionId: sessionId,
      };

    case 'dispatch': {
      // `continue` routes off the thread's existing session, never the alias —
      // so the trusted index is consulted ONLY for `new`, keeping the lookup
      // side effect off the continue path.
      const matches =
        decision.mode === 'new'
          ? deps.index
              .lookup(decision.projectAlias)
              .map((entry) => ({ name: entry.name, path: entry.path }))
          : [];
      const verdict = resolveCoordinatorDispatch({
        mode: decision.mode,
        matches,
        existingSession:
          existing === undefined
            ? null
            : { projectPath: existing.projectPath, driverSessionId: existing.driverSessionId },
      });

      if (verdict.kind === 'CLARIFY_AMBIGUOUS') {
        return {
          kind: 'clarify',
          question: 'that name matched more than one project — which did you mean?',
          options: verdict.candidates.map((candidate) => candidate.name),
          coordinatorSessionId: sessionId,
        };
      }
      if (verdict.kind === 'CLARIFY_NO_MATCH') {
        return {
          kind: 'clarify',
          question: 'no project matched that name — which project should I use?',
          coordinatorSessionId: sessionId,
        };
      }

      // verdict is DISPATCH_NEW | CONTINUE_SESSION — the executable tail. On a
      // DISPATCH_NEW that lands on an already-bound thread (旧线程换新任务),
      // the tail opens a fresh row (migration 006 dropped thread_key UNIQUE)
      // and never resumes the old session.
      const outcome = await executeDispatchVerdict(
        verdict,
        { intentId: input.intentId, threadKey: input.threadKey, prompt: decision.prompt },
        { dryRun: input.dryRun },
        existing,
        deps,
      );
      return { kind: 'dispatched', outcome, coordinatorSessionId: sessionId };
    }
  }
}
