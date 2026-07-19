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

import { expandTilde, resolveDefaultDbPath, resolveDefaultWorktreesRoot } from './paths.js';
import type { EnvLike } from './paths.js';

/**
 * Project-index configuration (D-P5B12-1): the allowlisted repo-root
 * directories `buildProjectIndex` scans, plus optional alias → project-path
 * mappings. Config-layer validation is SHAPE ONLY (non-empty strings) —
 * realpath/existence/git-repo checks are `buildProjectIndex`'s runtime job
 * (`src/application/projectIndex.ts`), deliberately not duplicated here.
 */
export interface ProjectsConfig {
  readonly roots: readonly string[];
  readonly aliases?: Readonly<Record<string, string>>;
}

/**
 * Config schema v1 (D-P5S-2, extended additively by D-P5B12-1 — version
 * stays 1: every new field is optional with a pinned default, so every
 * pre-existing config file keeps loading unchanged). `timeWindow` reuses
 * the domain type verbatim — there is no separate CLI-only copy of its
 * shape.
 */
export interface BridgeConfig {
  readonly version: 1;
  /**
   * Non-empty, contains `@`, no surrounding whitespace (a padded value is
   * REJECTED, not silently trimmed — see `validateConfig`). This is a
   * config-shape sanity check only, at load time — NOT the full identity
   * gate (`domain/identity.ts`), which compares parsed mail addresses
   * against this value at ingest time.
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
  /**
   * Defaults to `{ roots: [] }` when omitted (D-P5B12-1): an empty index —
   * every command routes to the no-match clarification stopgap until roots
   * are configured.
   */
  readonly projects: ProjectsConfig;
  /**
   * Bridge-owned worktrees root. Defaults via `resolveDefaultWorktreesRoot`
   * when omitted (D-P5B12-1) — the same fill-before-validate treatment as
   * `dbPath`, because the default needs `env`/`homedir`.
   */
  readonly worktreesRoot: string;
  /** Git ref dispatch bases new worktrees on. Defaults to `'HEAD'` (the
   * target repository's current head at dispatch time, D-P5B12-1). */
  readonly baseRef: string;
  /** Daemon poll interval. Defaults to `30`; validated to an integer in
   * `5..3600` (D-P5B12-1 — 30s keeps command-to-dispatch P95 under the
   * spec's 60s without IDLE). */
  readonly pollIntervalSeconds: number;
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
  'projects',
  'worktreesRoot',
  'baseRef',
  'pollIntervalSeconds',
  'mailbox',
  'timeWindow',
  'dryRun',
]);

const POLL_INTERVAL_MIN = 5;
const POLL_INTERVAL_MAX = 3600;

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
 * `start`/`end` must be zero-padded `'HH:MM'` AND in range: hours 00-23,
 * minutes 00-59. The range half is deliberately THIS module's job: the
 * domain's own `assertHHMM` (`domain/timeWindow.ts`) is shape-only by
 * documented design and assigns the out-of-range class ("25:99") to "the
 * caller's own config validation" — without the check here such a value
 * would pass BOTH layers and silently produce wrong `isWithinWindow`
 * verdicts. The range error names the field path and echoes the offending
 * value.
 */
function validateClockValue(field: 'start' | 'end', value: unknown, errors: string[]): void {
  if (typeof value !== 'string' || !HHMM.test(value)) {
    errors.push(`timeWindow.${field}: must match HH:MM`);
    return;
  }
  // The regex guarantees two digits either side of the colon, so Number
  // can never yield NaN here.
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  if (hours > 23 || minutes > 59) {
    errors.push(
      `timeWindow.${field}: hours must be 00-23 and minutes 00-59 (got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Validates a `timeWindow` value against `TimeWindowConfig`'s SHAPE (field
 * presence/types, plus the `HH:MM` / `YYYY-MM-DD` string formats its own
 * doc comments specify) and the `start`/`end` clock-value RANGE (see
 * `validateClockValue` — the one semantic check the domain explicitly
 * delegates to config validation). Beyond that it deliberately does NOT
 * validate semantic validity — e.g. whether `timezone` is a real IANA
 * name. `isWithinWindow` itself (`domain/timeWindow.ts`) is documented to
 * let an invalid timezone throw at call time (fail closed); this loader
 * does not duplicate that check.
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
  validateClockValue('start', start, errors);

  const end = raw.end;
  validateClockValue('end', end, errors);

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
 * Validates a `projects` value against `ProjectsConfig`'s SHAPE (D-P5B12-1):
 * `roots` a (possibly empty) array of non-empty strings, `aliases` — when
 * present — a plain object whose keys and values are non-empty strings.
 * Deliberately NOTHING more: whether a root exists, resolves, or contains
 * git repositories is `buildProjectIndex`'s runtime concern
 * (`src/application/projectIndex.ts`), and duplicating half of it here
 * would let the two layers drift. Follows `validateTimeWindow`'s
 * conventions: appends to the shared `errors` array, returns `undefined`
 * whenever it appended anything.
 */
function validateProjects(raw: unknown, errors: string[]): ProjectsConfig | undefined {
  if (!isPlainObject(raw)) {
    errors.push(`projects: must be an object, got ${describeType(raw)}`);
    return undefined;
  }

  const before = errors.length;

  const roots = raw.roots;
  if (!Array.isArray(roots) || !roots.every((r) => typeof r === 'string' && r.length > 0)) {
    errors.push('projects.roots: must be an array of non-empty strings');
  }

  const aliases = raw.aliases;
  if (aliases !== undefined) {
    if (!isPlainObject(aliases)) {
      errors.push(`projects.aliases: must be an object, got ${describeType(aliases)}`);
    } else {
      for (const [key, value] of Object.entries(aliases)) {
        if (key.trim().length === 0) {
          errors.push('projects.aliases: alias names must be non-empty strings');
        }
        if (typeof value !== 'string' || value.length === 0) {
          errors.push(`projects.aliases.${key}: must be a non-empty string (project path)`);
        }
      }
    }
  }

  if (errors.length > before) {
    return undefined;
  }

  return {
    roots: roots as string[],
    ...(aliases !== undefined ? { aliases: aliases as Record<string, string> } : {}),
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
 * `dbPath` and `worktreesRoot` are REQUIRED here (unlike in an on-disk
 * config file, where either may be omitted): their XDG-based defaults need
 * `env`/`homedir`, which this pure function deliberately never reads —
 * `loadConfig` fills both in BEFORE calling this function whenever the
 * parsed JSON omits them. `projects`/`baseRef`/`pollIntervalSeconds`
 * (D-P5B12-1) have PURE defaults and are therefore defaulted right here,
 * like `mailbox`/`dryRun`.
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
  if (typeof selfAddress !== 'string' || selfAddress.trim().length === 0) {
    // Whitespace-only counts as empty — it is no address at all, and "must
    // contain @" would be a misleading complaint about it.
    errors.push('selfAddress: must be a non-empty string');
  } else if (selfAddress !== selfAddress.trim()) {
    // Padded values are REJECTED rather than silently trimmed: the on-disk
    // config must stay byte-for-byte what the identity gate
    // (`domain/identity.ts`) will compare mail addresses against, so no
    // stored-vs-validated divergence can ever exist.
    errors.push('selfAddress: must not have leading or trailing whitespace');
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

  const worktreesRoot = raw.worktreesRoot;
  if (typeof worktreesRoot !== 'string' || worktreesRoot.length === 0) {
    errors.push('worktreesRoot: must be a non-empty string');
  } else if (!isAbsoluteOrTildePath(worktreesRoot)) {
    errors.push(
      `worktreesRoot: must be an absolute path or start with "~/" (got ${JSON.stringify(worktreesRoot)})`,
    );
  }

  const baseRef = raw.baseRef;
  if (baseRef !== undefined && (typeof baseRef !== 'string' || baseRef.length === 0)) {
    errors.push('baseRef: must be a non-empty string');
  }

  const pollIntervalSeconds = raw.pollIntervalSeconds;
  if (
    pollIntervalSeconds !== undefined &&
    (typeof pollIntervalSeconds !== 'number' ||
      !Number.isInteger(pollIntervalSeconds) ||
      pollIntervalSeconds < POLL_INTERVAL_MIN ||
      pollIntervalSeconds > POLL_INTERVAL_MAX)
  ) {
    errors.push(
      `pollIntervalSeconds: must be an integer between ${String(POLL_INTERVAL_MIN)} and ` +
        `${String(POLL_INTERVAL_MAX)} (got ${JSON.stringify(pollIntervalSeconds)})`,
    );
  }

  const projects = raw.projects === undefined ? undefined : validateProjects(raw.projects, errors);

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
      projects: projects ?? { roots: [] },
      worktreesRoot: worktreesRoot as string,
      baseRef: typeof baseRef === 'string' ? baseRef : 'HEAD',
      pollIntervalSeconds: typeof pollIntervalSeconds === 'number' ? pollIntervalSeconds : 30,
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
 * Fills in the XDG-based default `dbPath`/`worktreesRoot` BEFORE
 * validation, each ONLY when the parsed config is a plain object that
 * omits that field entirely. An explicit value — including an
 * explicitly-invalid one, so `validateConfig` can report it — always
 * passes through untouched.
 */
function applyEnvBasedDefaults(parsed: unknown, io: LoadConfigIo): unknown {
  if (!isPlainObject(parsed)) {
    return parsed;
  }
  return {
    ...parsed,
    ...(parsed.dbPath === undefined ? { dbPath: resolveDefaultDbPath(io.env, io.homedir) } : {}),
    ...(parsed.worktreesRoot === undefined
      ? { worktreesRoot: resolveDefaultWorktreesRoot(io.env, io.homedir) }
      : {}),
  };
}

/**
 * Tilde expansion for the D-P5B12-1 `projects` block: every root and every
 * alias TARGET (a project path) — never alias NAMES, which are lookup
 * terms, not paths. Same load-time-only expansion stance as
 * `credentialsEnvFile`/`dbPath` (see `loadConfig`'s return): the on-disk
 * config keeps its `~/` forms.
 */
function expandProjectsTildes(projects: ProjectsConfig, homedir: string): ProjectsConfig {
  const aliases = projects.aliases;
  return {
    roots: projects.roots.map((root) => expandTilde(root, homedir)),
    ...(aliases !== undefined
      ? {
          aliases: Object.fromEntries(
            Object.entries(aliases).map(([name, target]) => [name, expandTilde(target, homedir)]),
          ),
        }
      : {}),
  };
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

  const validated = validateConfig(applyEnvBasedDefaults(parsed, io));
  if (!validated.ok) {
    return validated;
  }

  return {
    ok: true,
    config: {
      ...validated.config,
      credentialsEnvFile: expandTilde(validated.config.credentialsEnvFile, io.homedir),
      dbPath: expandTilde(validated.config.dbPath, io.homedir),
      worktreesRoot: expandTilde(validated.config.worktreesRoot, io.homedir),
      projects: expandProjectsTildes(validated.config.projects, io.homedir),
    },
  };
}
