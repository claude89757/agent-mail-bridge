/**
 * Coordinator decision contract (ADR-0006 — 门后 codex 只读协调 agent,
 * coordination batch A). The coordinator agent's ONLY structured output
 * per inbound mail is exactly one of three decisions:
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
 * run's final response. Its exact shape was pinned by the batch-D carrier
 * spike against the real provider (ADR-0007), which rejected the naive
 * root-level union:
 *
 *   - the root MUST be `type: object` — a root-level `oneOf`/`anyOf` returns
 *     `400 invalid_json_schema` — so the actual decision is nested under a
 *     single `decision` property (the `{"decision": {...}}` ENVELOPE; unwrap
 *     with `parseCoordinatorDecisionEnvelope`);
 *   - the union uses `anyOf`, not `oneOf` (the provider does not permit
 *     `oneOf`);
 *   - every object is strict: `additionalProperties: false` and EVERY
 *     property listed in `required` (structured-output strict mode) — so the
 *     optional `clarify.options` becomes required-but-nullable
 *     (`type: ["array","null"]`), not an absent key;
 *   - no `minLength` (kept out of the wire schema; non-emptiness is
 *     re-checked by the parser below).
 *
 * `parseCoordinatorDecision` remains the real safety boundary: it re-validates
 * independently and does not depend on the model perfectly honoring this
 * schema.
 */
export const COORDINATOR_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['dispatch'] },
            projectAlias: { type: 'string' },
            prompt: { type: 'string' },
            mode: { type: 'string', enum: ['new', 'continue'] },
          },
          required: ['kind', 'projectAlias', 'prompt', 'mode'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['clarify'] },
            question: { type: 'string' },
            options: { type: ['array', 'null'], items: { type: 'string' } },
          },
          required: ['kind', 'question', 'options'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['answer'] },
            text: { type: 'string' },
          },
          required: ['kind', 'text'],
        },
      ],
    },
  },
  required: ['decision'],
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
  // `null` is how the wire schema encodes "no options" (options is
  // required-but-nullable — ADR-0007); treat it identically to absent.
  if (options === undefined || options === null) {
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

/**
 * Unwraps codex's `{"decision": {...}}` ENVELOPE, then validates the inner
 * decision via `parseCoordinatorDecision`. The envelope exists ONLY because
 * `--output-schema` requires a root object (ADR-0007): codex's final
 * `agent_message` is this wrapper, and the coordinator driver hands its
 * JSON-parsed form here. Fails closed exactly like the inner parser — a
 * non-object input, or a missing / non-object `decision`, clarifies nothing;
 * it returns `{ ok: false }` and the caller falls back to the deterministic
 * router.
 */
export function parseCoordinatorDecisionEnvelope(raw: unknown): ParseCoordinatorDecisionResult {
  if (!isRecord(raw)) {
    return fail('coordinator output must be a JSON object');
  }
  if (!('decision' in raw)) {
    return fail('coordinator output missing "decision" envelope field');
  }
  return parseCoordinatorDecision(raw.decision);
}
