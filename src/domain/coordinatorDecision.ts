/**
 * Coordinator decision contract (ADR-0006 — 门后 codex 只读协调 agent,
 * coordination batch A). The协调 agent's ONLY structured output per
 * inbound mail is exactly one of three decisions:
 *
 *   - `dispatch`  — run a task: name an allowlisted project (by ALIAS, never
 *                   a path) + the task prompt + whether this starts a new
 *                   execution session or continues the thread's existing one;
 *   - `clarify`   — ask the user a question (optionally offering options);
 *   - `answer`    — reply in natural language WITHOUT executing anything
 *                   (the read-only meta-query exit: 查项目/查会话/查进度).
 *
 * `parseCoordinatorDecision` is the fail-closed boundary between codex and
 * the rest of the bridge. Even though the coordinator run is constrained by
 * `codex exec --output-schema` (see `COORDINATOR_DECISION_SCHEMA`), its
 * output is STILL untrusted: this validator re-checks it independently
 * (defense in depth), and anything malformed returns `{ ok: false }` rather
 * than a half-built decision — the caller then falls back to the
 * deterministic `routeCommand` + clarification (ADR-0006's fail-closed
 * fallback). Pure domain, no IO — same discipline as `routing.ts` /
 * `identity.ts`: a pure function over an already-JSON-parsed value.
 *
 * A `dispatch`'s `projectAlias` is deliberately NOT resolved to a path
 * here — that resolution (alias → allowlisted realpath, via
 * `projectIndex.lookup`) is a separate pure step so this module keeps the
 * `projectIndex`-free purity `routing.ts` also holds. `projectAlias` being
 * an alias/name (never anything path-shaped) is exactly why the coordinator
 * can never smuggle an arbitrary path through: the only path source stays
 * `projectIndex`'s allowlisted entries.
 */

export type CoordinatorDecision =
  | {
      readonly kind: 'dispatch';
      /** An allowlisted project's NAME or ALIAS — never a path. Resolved to
       * a real path later, only via `projectIndex.lookup`. */
      readonly projectAlias: string;
      /** The task text handed to the execution codex as its prompt. */
      readonly prompt: string;
      /** `new` starts a fresh execution session; `continue` resumes the
       * thread's existing one. */
      readonly mode: 'new' | 'continue';
    }
  | {
      readonly kind: 'clarify';
      readonly question: string;
      /** Optional candidate choices to present (e.g. ambiguous project
       * names). Absent entirely when the coordinator offers no options. */
      readonly options?: readonly string[];
    }
  | {
      readonly kind: 'answer';
      /** Natural-language reply for a read-only meta-query; no execution. */
      readonly text: string;
    };

export type ParseCoordinatorDecisionResult =
  | { readonly ok: true; readonly decision: CoordinatorDecision }
  | { readonly ok: false; readonly error: string };

/**
 * JSON Schema fed to `codex exec --output-schema` to shape the coordinator
 * run's final response. Three branches, one per decision kind, each locked
 * to `additionalProperties: false` so the model cannot smuggle extra
 * fields. NOTE: the exact on-the-wire form codex/its provider accepts
 * (strict-mode quirks around root-level `oneOf`) is pinned by the batch-D
 * carrier spike; `parseCoordinatorDecision` is the real safety boundary
 * and does not depend on the model perfectly honoring this schema.
 */
export const COORDINATOR_DECISION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { const: 'dispatch' },
        projectAlias: { type: 'string', minLength: 1 },
        prompt: { type: 'string', minLength: 1 },
        mode: { enum: ['new', 'continue'] },
      },
      required: ['kind', 'projectAlias', 'prompt', 'mode'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'clarify' },
        question: { type: 'string', minLength: 1 },
        options: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind', 'question'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'answer' },
        text: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
  ],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value that is a string with at least one non-whitespace character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(error: string): ParseCoordinatorDecisionResult {
  return { ok: false, error };
}

function parseDispatch(raw: Record<string, unknown>): ParseCoordinatorDecisionResult {
  if (!isNonEmptyString(raw.projectAlias)) {
    return fail('dispatch.projectAlias must be a non-empty string');
  }
  if (!isNonEmptyString(raw.prompt)) {
    return fail('dispatch.prompt must be a non-empty string');
  }
  const mode = raw.mode;
  if (mode !== 'new' && mode !== 'continue') {
    return fail(`dispatch.mode must be "new" or "continue", got ${JSON.stringify(mode)}`);
  }
  return {
    ok: true,
    decision: { kind: 'dispatch', projectAlias: raw.projectAlias, prompt: raw.prompt, mode },
  };
}

function parseClarify(raw: Record<string, unknown>): ParseCoordinatorDecisionResult {
  if (!isNonEmptyString(raw.question)) {
    return fail('clarify.question must be a non-empty string');
  }
  const options = raw.options;
  if (options === undefined) {
    return { ok: true, decision: { kind: 'clarify', question: raw.question } };
  }
  if (!Array.isArray(options)) {
    return fail('clarify.options must be an array of strings');
  }
  const stringOptions: string[] = [];
  for (const item of options) {
    if (typeof item !== 'string') {
      return fail('clarify.options must be an array of strings');
    }
    stringOptions.push(item);
  }
  return { ok: true, decision: { kind: 'clarify', question: raw.question, options: stringOptions } };
}

function parseAnswer(raw: Record<string, unknown>): ParseCoordinatorDecisionResult {
  if (!isNonEmptyString(raw.text)) {
    return fail('answer.text must be a non-empty string');
  }
  return { ok: true, decision: { kind: 'answer', text: raw.text } };
}

/**
 * Validates codex's raw (already-JSON-parsed) coordinator output into a
 * typed `CoordinatorDecision`, or fails closed with a reason. The first
 * failing check decides the error; unknown/missing `kind` is itself a
 * closed failure (never defaults to a decision).
 */
export function parseCoordinatorDecision(raw: unknown): ParseCoordinatorDecisionResult {
  if (!isRecord(raw)) {
    return fail('decision must be a JSON object');
  }
  const kind = raw.kind;
  switch (kind) {
    case 'dispatch':
      return parseDispatch(raw);
    case 'clarify':
      return parseClarify(raw);
    case 'answer':
      return parseAnswer(raw);
    default:
      return fail(`decision.kind must be one of dispatch|clarify|answer, got ${JSON.stringify(kind)}`);
  }
}
