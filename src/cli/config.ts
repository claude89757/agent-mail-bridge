/**
 * Config schema v1 + loader (decision D-P5S-2). Hand-written validator,
 * zero new dependencies (no zod): every rejected field is named by its JSON
 * path so `doctor` (Task 2) can render a config problem as a normal check
 * failure instead of a stack trace.
 *
 * `validateConfig` is a pure function of already-`JSON.parse`d input — no
 * IO, no `process.env`/`os.homedir()` reads. `loadConfig` is the thin IO
 * wrapper around it: `io` bundles the injected file-read function together
 * with `homedir`/`env` (rather than adding a third parameter), so
 * `loadConfig`'s signature stays exactly `(path, io)` per D-P5S-2 while
 * still being able to compute the XDG-based default `dbPath` (via
 * `resolveDefaultDbPath`) and expand `~/` (via `expandTilde`) without ever
 * reading the real environment itself — `main.ts` (Task 3) is the only
 * place real values are read.
 *
 * Neither function throws for a bad config: both return
 * `{ ok: false, errors }` so a missing file, invalid JSON, or a schema
 * violation all become an ordinary data value the caller (doctor, setup)
 * can render, never an uncaught exception.
 *
 * Only `src/store/**` may import `better-sqlite3` (D-P5S-7) — this module
 * loads and validates plain JSON and never touches the database.
 */
import { isAbsolute } from 'node:path';

import type { TimeWindowConfig } from '../domain/timeWindow.js';

import { expandTilde, resolveDefaultDbPath } from './paths.js';
import type { EnvLike } from './paths.js';

/**
 * Config schema v1 (D-P5S-2). `timeWindow` reuses the domain type verbatim
 * — there is no separate CLI-only copy of its shape.
 */
export interface BridgeConfig {
  readonly version: 1;
  /**
   * Non-empty, contains `@`. This is a config-shape sanity check only, at
   * load time — NOT the full identity gate (`domain/identity.ts`), which
   * compares parsed mail addresses against this value at ingest time.
   */
  readonly selfAddress: string;
  /**
   * Path to a file holding credentials as env vars. Points AT the file;
   * the credentials themselves never appear in config.json (AGENTS.md red
   * line 2).
   */
  readonly credentialsEnvFile: string;
  /** SQLite store path. Defaults via `resolveDefaultDbPath` when omitted. */
  readonly dbPath: string;
  /** Defaults to `"INBOX"` when omitted. */
  readonly mailbox: string;
  readonly timeWindow?: TimeWindowConfig;
  /** Defaults to `false` when omitted. */
  readonly dryRun: boolean;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: BridgeConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

const KNOWN_FIELDS = new Set<string>([
  'version',
  'selfAddress',
  'credentialsEnvFile',
  'dbPath',
  'mailbox',
  'timeWindow',
  'dryRun',
]);

const HHMM = /^\d{2}:\d{2}$/;
const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Absolute, or `~/`-prefixed for later expansion by `loadConfig` — never a
 * bare relative path, so config semantics never depend on the process's
 * cwd (D-P5S-2).
 */
function isAbsoluteOrTildePath(value: string): boolean {
  return isAbsolute(value) || value.startsWith('~/');
}

/**
 * Validates a `timeWindow` value against `TimeWindowConfig`'s SHAPE (field
 * presence/types, plus the `HH:MM` / `YYYY-MM-DD` string formats its own
 * doc comments specify). Deliberately does NOT validate semantic validity —
 * e.g. whether `timezone` is a real IANA name. `isWithinWindow` itself
 * (`domain/timeWindow.ts`) is documented to let an invalid timezone throw
 * at call time (fail closed); this loader does not duplicate that check.
 *
 * Appends to the shared `errors` array (rather than returning its own)
 * because `validateConfig` aggregates every problem across the whole
 * config, not just this nested object, into one flat list.
 */
function validateTimeWindow(raw: unknown, errors: string[]): TimeWindowConfig | undefined {
  if (!isPlainObject(raw)) {
    errors.push(`timeWindow: must be an object, got ${describeType(raw)}`);
    return undefined;
  }

  const before = errors.length;

  const timezone = raw.timezone;
  if (typeof timezone !== 'string' || timezone.length === 0) {
    errors.push('timeWindow.timezone: must be a non-empty string');
  }

  const days = raw.days;
  if (
    !Array.isArray(days) ||
    !days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
  ) {
    errors.push('timeWindow.days: must be an array of integers 0-6 (0 = Sunday)');
  }

  const start = raw.start;
  if (typeof start !== 'string' || !HHMM.test(start)) {
    errors.push('timeWindow.start: must match HH:MM');
  }

  const end = raw.end;
  if (typeof end !== 'string' || !HHMM.test(end)) {
    errors.push('timeWindow.end: must match HH:MM');
  }

  const excludeDates = raw.excludeDates;
  if (
    !Array.isArray(excludeDates) ||
    !excludeDates.every((d) => typeof d === 'string' && YYYY_MM_DD.test(d))
  ) {
    errors.push('timeWindow.excludeDates: must be an array of YYYY-MM-DD strings');
  }

  if (errors.length > before) {
    return undefined;
  }

  return {
    timezone: timezone as string,
    days: days as number[],
    start: start as string,
    end: end as string,
    excludeDates: excludeDates as string[],
  };
}

/**
 * Validates already-`JSON.parse`d config data against schema v1. Fails
 * closed: an unrecognized top-level field is a hard error (rejected, never
 * silently ignored), and every branch names the offending field's JSON
 * path so the message is directly actionable. Collects ALL errors instead
 * of stopping at the first, so `setup` (Task 4) can list every problem in
 * one pass.
 *
 * `dbPath` is REQUIRED here (unlike in an on-disk config file, where it may
 * be omitted): the XDG-based default needs `env`/`homedir`, which this pure
 * function deliberately never reads — `loadConfig` fills `dbPath` in BEFORE
 * calling this function whenever the parsed JSON omits it.
 */
export function validateConfig(raw: unknown): ConfigResult {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`config: must be a JSON object, got ${describeType(raw)}`] };
  }

  const errors: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      errors.push(`${key}: unknown field`);
    }
  }

  const version = raw.version;
  if (version !== 1) {
    errors.push(
      version === undefined
        ? 'version: missing (expected 1)'
        : `version: expected 1, got ${JSON.stringify(version)}`,
    );
  }

  const selfAddress = raw.selfAddress;
  if (typeof selfAddress !== 'string' || selfAddress.length === 0) {
    errors.push('selfAddress: must be a non-empty string');
  } else if (!selfAddress.includes('@')) {
    errors.push('selfAddress: must contain "@"');
  }

  const credentialsEnvFile = raw.credentialsEnvFile;
  if (typeof credentialsEnvFile !== 'string' || credentialsEnvFile.length === 0) {
    errors.push('credentialsEnvFile: must be a non-empty string');
  } else if (!isAbsoluteOrTildePath(credentialsEnvFile)) {
    errors.push(
      `credentialsEnvFile: must be an absolute path or start with "~/" (got ${JSON.stringify(credentialsEnvFile)})`,
    );
  }

  const dbPath = raw.dbPath;
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    errors.push('dbPath: must be a non-empty string');
  } else if (!isAbsoluteOrTildePath(dbPath)) {
    errors.push(
      `dbPath: must be an absolute path or start with "~/" (got ${JSON.stringify(dbPath)})`,
    );
  }

  const mailbox = raw.mailbox;
  if (mailbox !== undefined && (typeof mailbox !== 'string' || mailbox.length === 0)) {
    errors.push('mailbox: must be a non-empty string');
  }

  const dryRun = raw.dryRun;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    errors.push('dryRun: must be a boolean');
  }

  const timeWindow =
    raw.timeWindow === undefined ? undefined : validateTimeWindow(raw.timeWindow, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      version: 1,
      selfAddress: selfAddress as string,
      credentialsEnvFile: credentialsEnvFile as string,
      dbPath: dbPath as string,
      mailbox: typeof mailbox === 'string' ? mailbox : 'INBOX',
      dryRun: typeof dryRun === 'boolean' ? dryRun : false,
      ...(timeWindow !== undefined ? { timeWindow } : {}),
    },
  };
}

/**
 * Minimal injected IO `loadConfig` needs: a `readFileSync`-like function
 * (throws like `node:fs` on a missing/unreadable file) bundled together
 * with `homedir`/`env` so the function signature stays exactly
 * `(path, io)` per D-P5S-2 — see the module doc comment for why
 * `homedir`/`env` are threaded through `io` rather than a third parameter.
 */
export interface LoadConfigIo {
  readonly readFileSync: (path: string) => string;
  readonly homedir: string;
  readonly env: EnvLike;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fills in the XDG-based default `dbPath` BEFORE validation, ONLY when the
 * parsed config is a plain object that omits it entirely. An explicit
 * `dbPath` — including an explicitly-invalid one, so `validateConfig` can
 * report it — always passes through untouched.
 */
function applyDbPathDefault(parsed: unknown, io: LoadConfigIo): unknown {
  if (!isPlainObject(parsed) || parsed.dbPath !== undefined) {
    return parsed;
  }
  return { ...parsed, dbPath: resolveDefaultDbPath(io.env, io.homedir) };
}

/**
 * Reads, parses, and validates the config file at `path`. Never throws: a
 * missing file, unreadable file, or JSON syntax error all become
 * `{ ok: false, errors }` exactly like a schema violation, so `doctor`
 * (Task 2) can render any of them as an ordinary check failure.
 */
export function loadConfig(path: string, io: LoadConfigIo): ConfigResult {
  let text: string;
  try {
    text = io.readFileSync(path);
  } catch (error) {
    return { ok: false, errors: [`config: cannot read ${path}: ${describeError(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`config: invalid JSON in ${path}: ${describeError(error)}`] };
  }

  const validated = validateConfig(applyDbPathDefault(parsed, io));
  if (!validated.ok) {
    return validated;
  }

  return {
    ok: true,
    config: {
      ...validated.config,
      credentialsEnvFile: expandTilde(validated.config.credentialsEnvFile, io.homedir),
      dbPath: expandTilde(validated.config.dbPath, io.homedir),
    },
  };
}
