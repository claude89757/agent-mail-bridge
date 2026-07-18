/**
 * Doctor check engine (decision D-P5S-4): a small registry of independent,
 * synchronous local checks, a runner that executes them in a fixed order,
 * and a plain-text renderer — kept deliberately separate so `main.ts`
 * (Task 3) can run the checks, decide the process exit code, and print the
 * report without any of those concerns leaking into this module.
 *
 * Every check is a pure function of `DoctorContext`: nothing here reads
 * `process.env`, `process.version`, or the real filesystem/database
 * directly. All of that is threaded through the injected `DoctorIo`
 * (`nodeVersion` / `stat` / `openDatabase`), so every check can be unit
 * tested against fixed fake or thin-real-fs values without needing a
 * specific real Node version or touching a real credentials file.
 * `buildDefaultDoctorIo` at the bottom of this file is the one exception —
 * it wires the real values for production use and is meant to be called
 * from `main.ts`, never from inside a check.
 *
 * `credentials-file` implements the credentials-hygiene contract from
 * D-P5S-3: stat-only — the file's CONTENTS are never read here (reading
 * only ever happens later, at daemon/transport runtime). Existence,
 * regular-file-ness, and exact permission bits (`0600` file / `0700` parent
 * directory) are the entire check. Any deviation is a `fail` with a
 * `chmod`/`mkdir` hint, never a `warn` — wider-than-intended permissions on
 * a secrets file is not a soft warning (AGENTS.md red line 2).
 *
 * `ready-at` is deliberately the only `warn`-capable check among the five:
 * an unset `readyAt` just means `amb setup` has not run yet, an expected
 * and common state, not a defect — `doctor` has to stay useful *before*
 * setup (D-P5S-4).
 *
 * No `console.*` calls anywhere in this file: `renderDoctorReport` returns
 * a string, printing is `main.ts`'s job. No `Date.now()`/`new Date()`
 * either — nothing a doctor check reports needs the current time.
 *
 * Only `src/store/**` may import `better-sqlite3` directly (D-P5S-7); this
 * module never does. `openDatabase`/`MetaStore` are imported as VALUES from
 * `src/store/**` (allowed), and the database handle type is derived via
 * `ReturnType<typeof openDatabase>` rather than ever naming
 * `better-sqlite3`'s `Database` type.
 */
import { statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BridgeConfig } from './config.js';
import { openDatabase } from '../store/database.js';
import { MetaStore } from '../store/metaStore.js';

// ---------------------------------------------------------------------------
// D-P5S-4 core types
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  readonly status: CheckStatus;
  readonly message: string;
  /** Actionable remediation text, e.g. an exact `chmod` command. Present on
   * most `fail`/`warn` results, omitted on `pass`. */
  readonly hint?: string;
}

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  run(ctx: DoctorContext): CheckResult;
}

export interface DoctorContext {
  readonly configPath: string;
  /** `null` when config failed to load/validate — see `configErrors`. */
  readonly config: BridgeConfig | null;
  /** Populated (non-empty) whenever `config` is `null`; empty when `config`
   * loaded cleanly. Mirrors `ConfigResult`'s `errors` from `./config.ts`. */
  readonly configErrors: readonly string[];
  readonly io: DoctorIo;
}

/** The subset of `fs.Stats` a doctor check needs. `mode` is the RAW mode
 * field (includes file-type bits), exactly like `fs.Stats.mode` — callers
 * mask with `& 0o7777` (permission bits AND setuid/setgid/sticky, NOT just
 * the low 9 permission bits) to check permissions exactly (D-P5S-3). */
export interface DoctorFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly mode: number;
}

/**
 * Every external effect a doctor check needs, injected so tests never have
 * to touch the real process/filesystem/database unless they deliberately
 * choose a "thin real-fs io" (D-P5S-7) — see `buildDefaultDoctorIo`, which
 * wires the real versions for production use.
 */
export interface DoctorIo {
  /** Same string shape as `process.version` (a leading `v` is optional and
   * stripped before parsing) — injected so `node-version` can be tested at
   * an arbitrary major version without a matching real interpreter. */
  readonly nodeVersion: string;
  /** `fs.statSync`-like. Returns `null` for ENOENT (does not exist) instead
   * of throwing, so "not there" is an ordinary value every check can branch
   * on directly; any other stat failure (e.g. `ENOTDIR`, `EACCES`) still
   * throws and is the caller's responsibility to catch. */
  readonly stat: (path: string) => DoctorFileStat | null;
  /** Same contract as `openDatabase` (`src/store/database.ts`) — in
   * production it IS that function. Throws on failure (bad path, migration
   * failure, …), exactly like `openDatabase` itself. This is the ONLY seam
   * through which a doctor check ever reaches the database. */
  readonly openDatabase: (path: string) => ReturnType<typeof openDatabase>;
}

/** A `CheckResult` with the originating check's `id`/`title` attached —
 * what `runDoctor` collects and what `renderDoctorReport` renders. */
export interface DoctorCheckOutcome extends CheckResult {
  readonly id: string;
  readonly title: string;
}

export interface DoctorRunResult {
  readonly results: readonly DoctorCheckOutcome[];
  readonly exitCode: 0 | 1;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Runs every check in `checks`, IN ORDER — that order is the output order
 * (D-P5S-4). `exitCode` is `1` iff at least one check reports `fail`; a
 * `warn` never affects it, which is what lets `doctor` stay useful before
 * `amb setup` has run (the `ready-at` check warns, not fails, when unset).
 */
export function runDoctor(checks: readonly DoctorCheck[], ctx: DoctorContext): DoctorRunResult {
  const results: DoctorCheckOutcome[] = checks.map((check) => ({
    id: check.id,
    title: check.title,
    ...check.run(ctx),
  }));

  const hasFailure = results.some((result) => result.status === 'fail');
  return { results, exitCode: hasFailure ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const STATUS_SYMBOL: Record<CheckStatus, string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
};

/**
 * Deterministic plain-text report (no colors in v1, per D-P5S-4): one line
 * per result (`<symbol> <title>: <message>`), with an indented `  hint: …`
 * line directly below whenever the result carries one. Pure string
 * transform — printing is `main.ts`'s job (Task 3), never this module's.
 */
export function renderDoctorReport(results: readonly DoctorCheckOutcome[]): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${STATUS_SYMBOL[result.status]} ${result.title}: ${result.message}`);
    if (result.hint !== undefined) {
      lines.push(`  hint: ${result.hint}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared check helpers
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Masks with `0o7777`, NOT `0o777`: the wider mask keeps the setuid/setgid/
 * sticky bits (`0o7000`) in the result alongside the rwx permission bits,
 * so e.g. a `0o4600` file (setuid + owner-rw) is correctly reported as
 * `0o4600`, not silently narrowed down to `0o600` and treated as an exact
 * match by the "must be exactly 0600/0700" checks below. `& 0o777` would
 * make "exactly 0600" a lie for any file carrying one of those bits.
 */
function permissionBits(mode: number): number {
  return mode & 0o7777;
}

/** e.g. `0o644` -> `"0644"` — matches how permission bits are conventionally
 * written (leading zero + 3 octal digits) in `chmod` hints and messages. */
function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Check 1: node-version
// ---------------------------------------------------------------------------

const MIN_NODE_MAJOR = 22;

function parseMajorVersion(version: string): number {
  const normalized = version.startsWith('v') ? version.slice(1) : version;
  const [majorText = ''] = normalized.split('.');
  return Number(majorText);
}

function nodeVersionCheck(): DoctorCheck {
  return {
    id: 'node-version',
    title: 'Node.js version',
    run(ctx) {
      const major = parseMajorVersion(ctx.io.nodeVersion);
      if (major >= MIN_NODE_MAJOR) {
        return {
          status: 'pass',
          message: `Node.js ${ctx.io.nodeVersion} (>= ${MIN_NODE_MAJOR} required)`,
        };
      }
      return {
        status: 'fail',
        message: `Node.js ${ctx.io.nodeVersion} is older than the minimum required version ${MIN_NODE_MAJOR}`,
        hint: `upgrade Node.js to version ${MIN_NODE_MAJOR} or later`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Check 2: config
// ---------------------------------------------------------------------------

function configCheck(): DoctorCheck {
  return {
    id: 'config',
    title: 'Config file',
    run(ctx) {
      if (ctx.config !== null && ctx.configErrors.length === 0) {
        return { status: 'pass', message: `config loaded from ${ctx.configPath}` };
      }
      const [firstError = 'unknown config error'] = ctx.configErrors;
      return {
        status: 'fail',
        message: `config invalid: ${firstError}`,
        hint: 'run `amb setup` to write a valid config, or see the setup docs',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Check 3: credentials-file (D-P5S-3)
// ---------------------------------------------------------------------------

const CREDENTIALS_FILE_MODE = 0o600;
const CREDENTIALS_DIR_MODE = 0o700;

/**
 * The stat-only credentials-file hygiene check itself (D-P5S-3), factored
 * out of `DoctorContext`/`DoctorCheck` so `src/cli/setup.ts` (Task 4, step 2
 * of D-P5S-6) can run the EXACT same check during `amb setup` without
 * fabricating an unrelated `DoctorContext` (`configPath`/`configErrors`/
 * `nodeVersion`/`openDatabase`) it has no use for — it only ever needs a
 * concrete path and a `stat` function. `credentialsFileCheck` below is now a
 * thin `DoctorContext`-shaped wrapper around this; its behavior (messages,
 * hints, statuses) is unchanged by this extraction.
 */
export function checkCredentialsFileHygiene(
  filePath: string,
  stat: DoctorIo['stat'],
): CheckResult {
  try {
    const fileStat = stat(filePath);
    if (fileStat === null) {
      return {
        status: 'fail',
        message: `credentials file does not exist: ${filePath}`,
        hint: `create it, then run: chmod 600 ${filePath}`,
      };
    }
    if (!fileStat.isFile) {
      return {
        status: 'fail',
        message: `credentials file is not a regular file: ${filePath}`,
        hint: `replace it with a regular file, then run: chmod 600 ${filePath}`,
      };
    }
    if (permissionBits(fileStat.mode) !== CREDENTIALS_FILE_MODE) {
      return {
        status: 'fail',
        message: `credentials file has mode ${formatMode(permissionBits(fileStat.mode))} (must be exactly 0600): ${filePath}`,
        hint: `chmod 600 ${filePath}`,
      };
    }

    const dirPath = dirname(filePath);
    const dirStat = stat(dirPath);
    if (dirStat === null) {
      return {
        status: 'fail',
        message: `credentials file parent directory does not exist: ${dirPath}`,
        hint: `mkdir -p ${dirPath} && chmod 700 ${dirPath}`,
      };
    }
    if (!dirStat.isDirectory) {
      return {
        status: 'fail',
        message: `credentials file parent path is not a directory: ${dirPath}`,
        hint: `replace it with a directory, then run: chmod 700 ${dirPath}`,
      };
    }
    if (permissionBits(dirStat.mode) !== CREDENTIALS_DIR_MODE) {
      return {
        status: 'fail',
        message: `credentials file parent directory has mode ${formatMode(permissionBits(dirStat.mode))} (must be exactly 0700): ${dirPath}`,
        hint: `chmod 700 ${dirPath}`,
      };
    }

    return { status: 'pass', message: `credentials file permissions OK: ${filePath}` };
  } catch (error) {
    // fail closed: an unexpected stat error (e.g. ENOTDIR because a
    // path component is a file, or EACCES) is a check FAILURE, never an
    // uncaught exception that would take down the rest of the report.
    // Deliberately no `hint` here (unlike every other branch above):
    // a `chmod 600 …` suggestion would be actively misleading for an
    // error class it doesn't address (ENOTDIR, EACCES, …) — confirmed
    // intentional in Task 2's review, not an oversight.
    return {
      status: 'fail',
      message: `failed to check credentials file at ${filePath}: ${describeError(error)}`,
    };
  }
}

function credentialsFileCheck(): DoctorCheck {
  return {
    id: 'credentials-file',
    title: 'Credentials file permissions',
    run(ctx) {
      if (ctx.config === null) {
        return { status: 'fail', message: 'config invalid; cannot check credentials file' };
      }
      return checkCredentialsFileHygiene(ctx.config.credentialsEnvFile, ctx.io.stat);
    },
  };
}

// ---------------------------------------------------------------------------
// Check 4: database
// ---------------------------------------------------------------------------

function databaseCheck(): DoctorCheck {
  return {
    id: 'database',
    title: 'Database',
    run(ctx) {
      if (ctx.config === null) {
        return { status: 'fail', message: 'config invalid; cannot open database' };
      }

      const { dbPath } = ctx.config;
      try {
        const db = ctx.io.openDatabase(dbPath);
        db.close();
        return { status: 'pass', message: `database opens cleanly: ${dbPath}` };
      } catch (error) {
        return {
          status: 'fail',
          message: `failed to open database at ${dbPath}: ${describeError(error)}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Check 5: ready-at
// ---------------------------------------------------------------------------

function readyAtCheck(): DoctorCheck {
  return {
    id: 'ready-at',
    title: 'Ready-at fence',
    run(ctx) {
      if (ctx.config === null) {
        return { status: 'fail', message: 'config invalid; cannot check readyAt' };
      }

      const { dbPath } = ctx.config;

      // Deliberately independent of the `database` check: that check
      // already closed its handle by the time this one runs, and sharing a
      // handle across checks is not worth the complexity (D-P5S-4) — this
      // check opens, reads, and closes its own.
      let db: ReturnType<typeof openDatabase>;
      try {
        db = ctx.io.openDatabase(dbPath);
      } catch (error) {
        return {
          status: 'fail',
          message: `failed to open database at ${dbPath}: ${describeError(error)}`,
        };
      }

      try {
        const readyAt = new MetaStore(db).getReadyAt();
        if (readyAt === null) {
          return {
            status: 'warn',
            message: 'readyAt is not set yet',
            hint: 'run `amb setup` to record the first-install fence',
          };
        }
        return { status: 'pass', message: `readyAt is set to ${readyAt}` };
      } catch (error) {
        return {
          status: 'fail',
          message: `failed to read readyAt from ${dbPath}: ${describeError(error)}`,
        };
      } finally {
        db.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The five v1 checks (D-P5S-4), in output order. Returns a fresh array
 * every call — checks are stateless factories, not shared singletons. */
export function buildDefaultChecks(): DoctorCheck[] {
  return [
    nodeVersionCheck(),
    configCheck(),
    credentialsFileCheck(),
    databaseCheck(),
    readyAtCheck(),
  ];
}

// ---------------------------------------------------------------------------
// Production io wiring
// ---------------------------------------------------------------------------

function isEnoentError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function statOrNull(path: string): DoctorFileStat | null {
  try {
    const stats = statSync(path);
    return { isFile: stats.isFile(), isDirectory: stats.isDirectory(), mode: stats.mode };
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Wires the real `process.version` / `fs.statSync` / `openDatabase`
 * (`src/store/database.ts`) behind `DoctorIo`, for `main.ts` (Task 3) to
 * plug into `runDoctor`'s context. This is the ONLY place in this module
 * that touches a real global or the real filesystem/database — every check
 * above only ever calls `ctx.io`.
 */
export function buildDefaultDoctorIo(): DoctorIo {
  return {
    nodeVersion: process.version,
    stat: statOrNull,
    openDatabase,
  };
}
