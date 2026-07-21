/**
 * Coordinator driver (ADR-0006 — 门后 codex 只读协调 agent, coordination
 * batch C). Runs exactly ONE read-only codex turn as the mail coordinator and
 * returns a structured `CoordinatorDecision`, or fails closed so the caller
 * can fall back to the deterministic router (`routeCommand` + clarification).
 * This is the model-facing carrier of the conversational layer; unlike the
 * task-execution `CodexDriver` (`codexDriver.ts`) it:
 *
 *   - runs `--sandbox read-only` (NEVER `workspace-write`): the coordinator
 *     READS the bridge's state and the mail, it never mutates a project — one
 *     of the three walls of the injection defense (ADR-0006);
 *   - passes `--output-schema` so codex's final response is shaped by
 *     `COORDINATOR_DECISION_SCHEMA`, then re-validates it independently via
 *     `parseCoordinatorDecision` (defense in depth — the schema is a nudge,
 *     the parser is the boundary);
 *   - is ONE-SHOT: it consumes the JSONL stream to the terminal event, takes
 *     the final `agent_message`, and decides — no streaming-with-replay
 *     handle machinery, because a coordination turn yields a single decision.
 *
 * Injection seam: reuses `CodexDriver`'s `SpawnCodex` type (a `child_process`
 * wrapper in production, a scripted process in tests), so every branch —
 * happy decision, unparseable output, invalid decision, empty turn, crash —
 * unit-tests with ZERO model quota. The real carrier questions (whether
 * read-only + MCP + `--output-schema` compose; whether the decision arrives
 * cleanly on the stream vs needs `-o/--output-last-message`; the exact
 * read-only config key on resume) are the batch-D spike, gated on red line 5.
 *
 * new vs resume argv (ADR-0004 asymmetry, re-measured on codex 0.144.6):
 * `exec` accepts `--sandbox`, but `exec resume` does NOT — so the new-turn
 * path positively asserts `--sandbox read-only`, while the resume path omits
 * it and the read-only enforcement rides on `extraArgs` config the wiring
 * layer resolves (pinned in batch D). Either way this driver NEVER emits
 * `workspace-write` or any `--dangerously-bypass-*` flag, and a resume id is
 * whitelisted against `CODEX_SESSION_ID_PATTERN` BEFORE it may enter an argv
 * (argv-injection defense, mirroring `CodexDriver.resumeTask`).
 *
 * Red line 2: stderr is scrubbed of the local cwd/home before it may enter a
 * failure reason. Layering: imports only `domain/` (the decision parser) and
 * a type from a sibling driver; no `application/`/`store/`/`transports/`, no
 * console.
 */
import { homedir } from 'node:os';

import { parseCoordinatorDecisionEnvelope, type CoordinatorDecision } from '../domain/coordinatorDecision.js';
import type { SpawnCodex } from './codexDriver.js';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface CoordinatorRunInput {
  /** The full coordinator prompt: system instructions + the inbound mail
   *  body (assembled by the wiring layer, batch E). */
  readonly prompt: string;
  /** Read-only working dir codex runs in — a meta/scratch dir, never a
   *  project worktree (the coordinator never mutates anything). */
  readonly cwd: string;
  /** Path to the decision JSON Schema file passed as `--output-schema`
   *  (`COORDINATOR_DECISION_SCHEMA` written to a temp file by the caller). */
  readonly schemaPath: string;
  /** Extra argv injected before the trailing prompt — carries the
   *  coordinator MCP-server config (e.g. `-c mcp_servers.amb-coordinator…`)
   *  and, on the resume path, the read-only enforcement; resolved by the
   *  wiring layer so this driver stays mechanism-agnostic. Each element is
   *  ONE argv token. */
  readonly extraArgs?: readonly string[];
  /** When continuing a prior coordination turn, its codex thread id. MUST be
   *  a lowercase-UUID (whitelisted before use). Absent starts a new turn. */
  readonly resumeSessionId?: string;
}

export type CoordinatorRunOutcome =
  | { readonly kind: 'decided'; readonly decision: CoordinatorDecision; readonly sessionId: string | null }
  | { readonly kind: 'failed'; readonly reason: string };

export type RunCoordinatorTurn = (input: CoordinatorRunInput) => Promise<CoordinatorRunOutcome>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The coordinator ALWAYS runs read-only — it reads state and mail, never
 *  writes. Exported so the argv-discipline is assertable and the wiring layer
 *  can reuse the same literal for the resume config override. */
export const COORDINATOR_SANDBOX_MODE = 'read-only';

/**
 * Fixed exec flags every coordination turn carries (batch-D spike, ADR-0007):
 *   - `--skip-git-repo-check`: the coordinator cwd is a meta/scratch dir, not
 *     a git repo, which codex otherwise refuses to run in;
 *   - `--ignore-user-config`: run against a clean config — do NOT inherit the
 *     operator's global `~/.codex/config.toml` (its `approvals_reviewer` and
 *     unrelated MCP servers otherwise leak in as approval routing / noise);
 *     auth still resolves from `CODEX_HOME`, so no credential is touched;
 *   - `-c approval_policy="never"`: headless, so never block on an approval
 *     prompt (execution failures return to the model instead).
 * Under the prompt-injection context model (ADR-0007) the coordinator calls
 * NO tools, so these only make the run headless and isolated — they never
 * relax the sandbox; `--sandbox read-only` still stands on the new-turn path.
 */
export const COORDINATOR_ISOLATION_ARGS: readonly string[] = [
  '--skip-git-repo-check',
  '--ignore-user-config',
  '-c',
  'approval_policy="never"',
];

/**
 * The one shape codex mints for `thread.started.thread_id` (ADR-0004): a
 * lowercase hex UUID. Anything else — uppercase, braces, `--last`, arbitrary
 * strings — is rejected BEFORE it may enter a resume argv (argv-injection
 * defense; duplicated per-file by convention, `CodexDriver` precedent).
 */
const CODEX_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Cap on the scrubbed stderr summary inside a failure reason — enough for
 *  codex's own diagnostics without letting a runaway stderr flood a mail. */
const STDERR_SUMMARY_MAX_CHARS = 400;

// ---------------------------------------------------------------------------
// Small pure helpers (duplicated per-file by convention, not shared)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Literal (non-regex) global replacement, skipping degenerate needles that
 *  would shred the text — scrubbing is safety-over-fidelity, but not at the
 *  cost of destroying the summary. */
function replaceAllLiteral(text: string, needle: string, placeholder: string): string {
  if (needle.length < 2) {
    return text;
  }
  return text.split(needle).join(placeholder);
}

/** Red line 2: cwd first, then home. */
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
// Stream event extraction (the coordinator only needs three signals)
// ---------------------------------------------------------------------------

type CoordinatorStreamEvent =
  | { readonly kind: 'thread-started'; readonly threadId: string }
  | { readonly kind: 'agent-message'; readonly text: string }
  | { readonly kind: 'terminal' };

/** ADR-0004 vocabulary, narrowed to what a one-shot coordination turn needs:
 *  the thread id, the last agent message, and turn completion. Everything
 *  else (turn.started, tool activity, diagnostics) is irrelevant here and
 *  skipped — forward compatible. Unparseable/foreign lines return null. */
function parseEventLine(rawLine: string): CoordinatorStreamEvent | null {
  const trimmed = rawLine.trim();
  if (trimmed === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const eventType = parsed['type'];
  if (typeof eventType !== 'string') {
    return null;
  }
  if (eventType === 'thread.started') {
    const threadId = parsed['thread_id'];
    return typeof threadId === 'string' ? { kind: 'thread-started', threadId } : null;
  }
  if (eventType === 'turn.completed') {
    return { kind: 'terminal' };
  }
  if (eventType === 'item.completed') {
    const item = parsed['item'];
    if (isRecord(item) && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
      return { kind: 'agent-message', text: item['text'] };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// argv assembly
// ---------------------------------------------------------------------------

function buildArgv(input: CoordinatorRunInput): readonly string[] {
  const extra = input.extraArgs ?? [];
  if (input.resumeSessionId !== undefined) {
    if (!CODEX_SESSION_ID_PATTERN.test(input.resumeSessionId)) {
      throw new Error(
        'coordinatorDriver: refusing to resume a coordination turn with a non-UUID session id ' +
          '(argv-injection guard — ADR-0004)',
      );
    }
    // `exec resume` does not accept `--sandbox` (codex 0.144.6). The read-only
    // enforcement for the resume path must ride on config, whose exact key is
    // still to be pinned by a resume-specific spike (batch E/F) — until then
    // the wiring layer supplies it via `extraArgs`, and multi-turn resume stays
    // gated on that spike. (The new-turn path below is fully spike-verified.)
    return [
      'exec',
      'resume',
      input.resumeSessionId,
      '--json',
      ...COORDINATOR_ISOLATION_ARGS,
      ...extra,
      '--output-schema',
      input.schemaPath,
      input.prompt,
    ];
  }
  return [
    'exec',
    '--json',
    '--sandbox',
    COORDINATOR_SANDBOX_MODE,
    ...COORDINATOR_ISOLATION_ARGS,
    '-C',
    input.cwd,
    ...extra,
    '--output-schema',
    input.schemaPath,
    input.prompt,
  ];
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Builds a `RunCoordinatorTurn` over an injected `spawnCodex`. The returned
 * function runs one read-only coordination turn and settles to `decided` (a
 * validated decision + the codex thread id) or `failed` (a scrubbed reason
 * the caller maps to a deterministic-router fallback). It NEVER throws for a
 * model/runtime outcome — the only throw is the synchronous argv-injection
 * guard on a tainted resume id, which is a hard invariant, not a decision.
 */
export function createCoordinatorDriver(deps: { spawnCodex: SpawnCodex }): RunCoordinatorTurn {
  return async function runCoordinatorTurn(input) {
    const argv = buildArgv(input); // throws synchronously on a tainted resume id
    const spawned = deps.spawnCodex(argv, { cwd: input.cwd });

    let sessionId: string | null = null;
    let lastAgentMessageText: string | null = null;
    let sawTerminal = false;

    try {
      for await (const rawLine of spawned.stdout) {
        const event = parseEventLine(rawLine);
        if (event === null) {
          continue;
        }
        if (event.kind === 'thread-started') {
          if (sessionId === null) {
            sessionId = event.threadId;
          }
        } else if (event.kind === 'agent-message') {
          lastAgentMessageText = event.text;
        } else {
          sawTerminal = true;
        }
      }
    } catch {
      // Broken stdout stream — the exit/terminal accounting below decides.
    }

    const { code } = await spawned.exited;

    if (!sawTerminal) {
      // No terminal event: a crash (spawn failure, bogus resume, mid-stream
      // break). Synthesize a scrubbed reason from stderr + exit code.
      let stderrText = '';
      try {
        stderrText = await spawned.stderr;
      } catch {
        // stderr unavailable — synthesize from the exit code alone.
      }
      const summary = truncateSummary(scrubLocalPaths(stderrText.trim(), input.cwd, homedir()));
      const reason =
        summary === ''
          ? `coordinator run exited with code ${String(code)} before completing`
          : `coordinator run exited with code ${String(code)} before completing: ${summary}`;
      return { kind: 'failed', reason };
    }

    if (lastAgentMessageText === null) {
      return { kind: 'failed', reason: 'coordinator completed its turn without a final message' };
    }

    let rawEnvelope: unknown;
    try {
      rawEnvelope = JSON.parse(lastAgentMessageText);
    } catch {
      return { kind: 'failed', reason: 'coordinator final message was not valid JSON' };
    }
    // The final message is the `{"decision": {...}}` envelope (ADR-0007);
    // unwrap + re-validate, failing closed to the deterministic router.
    const parsed = parseCoordinatorDecisionEnvelope(rawEnvelope);
    if (!parsed.ok) {
      return { kind: 'failed', reason: `coordinator decision invalid: ${parsed.error}` };
    }
    return { kind: 'decided', decision: parsed.decision, sessionId };
  };
}
