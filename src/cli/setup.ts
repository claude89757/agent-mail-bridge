/**
 * `amb setup` — the minimal non-interactive first-install command (decision
 * D-P5S-6). `runSetup(args, io, now)` runs the six steps below, IN ORDER,
 * returning a plain `{ exitCode, messages }` value — never throwing, never
 * calling `process.exit`/`console.*` — so `src/cli/main.ts` (the one place
 * that prints and sets `process.exitCode`) can decide where each message
 * goes. `now` is an injected parameter, not read from `Date.now()`/
 * `new Date()` here: `main.ts` constructs it once, at the assembly edge,
 * exactly when the user's `setup` invocation actually runs (D-P5S-6).
 *
 *   1. Parse flags (`node:util` `parseArgs`, reserved for subcommand flags
 *      by D-P5S-1) and assemble a raw config object, then validate it with
 *      `validateConfig` (`./config.ts`) — REUSED verbatim, not duplicated,
 *      so `amb setup` and a hand-edited config.json are held to exactly the
 *      same schema. On failure: every error is listed, exit 1.
 *   2. Credentials-file hygiene check (D-P5S-3) — REUSED from
 *      `checkCredentialsFileHygiene` (`./doctor.ts`, extracted there for
 *      this exact purpose) rather than re-implemented. Stat-only, contents
 *      never read. On failure: exit 1 with the check's own chmod hint,
 *      BEFORE anything is written to disk (steps 3-5 never run).
 *   3. Write config.json at `resolveConfigPath`'s location. Refuses to
 *      silently clobber an existing file unless `--force-config` is given;
 *      creates the parent directory (`mkdir -p`) and chmods the written
 *      file to 0600.
 *   4. `openDatabase(dbPath)` — creates the file and runs migrations if new
 *      (also `mkdir -p`s `dbPath`'s parent directory first: unlike
 *      `mkdir -p`'d config directory, SQLite itself never creates missing
 *      parent directories). A failure here or in step 5 is caught and
 *      reported as exit 1 WITH a note that step 3's config.json already
 *      exists and a retry now needs `--force-config` — the config is
 *      deliberately never rolled back.
 *   5. `metaStore.setReadyAtIfUnset(now.toISOString())` — the first-install
 *      fence, productized. `getReadyAt()` is read BEFORE the write so the
 *      result can truthfully report which case happened (freshly-set vs.
 *      already-set-at-<value>); the store itself already guarantees the
 *      VALUE never changes after the first successful call for a given
 *      `dbPath`, regardless of how many times `setup` re-runs. Same
 *      database handle as step 4, closed once both steps are done.
 *   6. Next-steps message pointing at `amb doctor` (daemon install is out of
 *      scope for this build — see the plan's self-review notes).
 *
 * `~/`-prefixed `credentialsEnvFile`/`dbPath` values are expanded (via
 * `expandTilde`, `./paths.ts`) ONLY for the real filesystem/database
 * operations in steps 2 and 4 — the value WRITTEN to config.json in step 3
 * stays exactly what `validateConfig` accepted (the CLI-provided value, or
 * the resolved default for an omitted `dbPath`), mirroring how `loadConfig`
 * treats an on-disk config: expansion is always a load-time/use-time
 * concern, never baked permanently into the stored artifact.
 *
 * Only `src/store/**` may import `better-sqlite3` directly (D-P5S-7) — this
 * module never does; `openDatabase`/`MetaStore` are imported as VALUES
 * (allowed), exactly like `./doctor.ts` already does.
 */
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import type { BridgeConfig } from './config.js';
import { validateConfig } from './config.js';
import type { DoctorFileStat } from './doctor.js';
import { checkCredentialsFileHygiene } from './doctor.js';
import type { EnvLike } from './paths.js';
import {
  expandTilde,
  resolveConfigPath,
  resolveDefaultDbPath,
  resolveDefaultWorktreesRoot,
} from './paths.js';
import { openDatabase } from '../store/database.js';
import { MetaStore } from '../store/metaStore.js';

// ---------------------------------------------------------------------------
// IO surface
// ---------------------------------------------------------------------------

/**
 * Every external effect `runSetup` needs, injected (matches the io
 * conventions `./paths.ts`/`./config.ts`/`./doctor.ts` already established —
 * see each module's own doc comment). `stat`/`openDatabase` deliberately
 * share `DoctorIo`'s exact contract (`./doctor.ts`) rather than redefining
 * an incompatible shape: it is what lets `main.ts` reuse the SAME `stat`/
 * `openDatabase` function values it already built for `doctorIo`, and what
 * lets `checkCredentialsFileHygiene` be called unchanged.
 */
export interface SetupIo {
  readonly env: EnvLike;
  readonly homedir: string;
  /** `fs.statSync`-like; returns `null` for ENOENT instead of throwing, same
   * contract as `DoctorIo['stat']` (`./doctor.ts`). */
  readonly stat: (path: string) => DoctorFileStat | null;
  /** `fs.mkdirSync(path, { recursive: true })`-like: creates `path` and any
   * missing parent directories; a no-op if `path` already exists. */
  readonly mkdir: (path: string) => void;
  /** `fs.writeFileSync(path, content, 'utf8')`-like. */
  readonly writeFile: (path: string, content: string) => void;
  /** `fs.chmodSync`-like. */
  readonly chmod: (path: string, mode: number) => void;
  /** Same contract as `DoctorIo['openDatabase']` / `store/database.ts`'s own
   * `openDatabase` — in production it IS that function. */
  readonly openDatabase: (path: string) => ReturnType<typeof openDatabase>;
}

export interface SetupResult {
  /** D-P5B13-2: `2` = usage error (flag parsing), `1` = every runtime
   *  failure (validation, hygiene, fs, database), `0` = success. */
  readonly exitCode: 0 | 1 | 2;
  readonly messages: readonly string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Step 1a: flag parsing (D-P5S-1 reserves parseArgs for a subcommand's OWN
// flags; dispatch.ts's hand-rolled routing already isolated `rest` for us)
// ---------------------------------------------------------------------------

const USAGE =
  'usage: amb setup --self <addr> --credentials-env-file <path> ' +
  '[--db-path <p>] [--mailbox <m>] [--dry-run] [--force-config]';

interface ParsedSetupFlags {
  readonly self: string | undefined;
  readonly credentialsEnvFile: string | undefined;
  readonly dbPath: string | undefined;
  readonly mailbox: string | undefined;
  readonly dryRun: boolean;
  readonly forceConfig: boolean;
}

type ParseSetupArgsResult =
  | { readonly ok: true; readonly flags: ParsedSetupFlags }
  | { readonly ok: false; readonly message: string };

/**
 * Never throws: `parseArgs` itself throws on an unknown flag, a missing
 * value, or a stray positional (all in `strict`/`allowPositionals: false`
 * mode) — caught here and turned into an ordinary `{ ok: false }` value, the
 * same fail-closed-without-throwing shape every other CLI module in this
 * package already uses (`loadConfig`, `dispatch`, …).
 */
function parseSetupArgs(args: readonly string[]): ParseSetupArgsResult {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        self: { type: 'string' },
        'credentials-env-file': { type: 'string' },
        'db-path': { type: 'string' },
        mailbox: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'force-config': { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    return {
      ok: true,
      flags: {
        self: values.self,
        credentialsEnvFile: values['credentials-env-file'],
        dbPath: values['db-path'],
        mailbox: values.mailbox,
        dryRun: values['dry-run'],
        forceConfig: values['force-config'],
      },
    };
  } catch (error) {
    return { ok: false, message: `invalid arguments: ${describeError(error)} (${USAGE})` };
  }
}

// ---------------------------------------------------------------------------
// runSetup
// ---------------------------------------------------------------------------

export function runSetup(args: readonly string[], io: SetupIo, now: Date): SetupResult {
  const parsed = parseSetupArgs(args);
  if (!parsed.ok) {
    // D-P5B13-2: usage errors exit 2 (the `runStart` convention); every
    // runtime failure below keeps exiting 1.
    return { exitCode: 2, messages: [`amb setup: ${parsed.message}`] };
  }
  const { flags } = parsed;

  // Step 1 (D-P5S-6): assemble the config object from args, then validate
  // against schema v1. `dbPath` gets the XDG-based default BEFORE
  // validation whenever `--db-path` is omitted (mirroring `loadConfig`'s own
  // `applyDbPathDefault`, `./config.ts`) — `validateConfig` itself always
  // requires a non-empty `dbPath`. `mailbox`/`dryRun` are left for
  // `validateConfig` to default (INBOX / false) exactly as it already does
  // for an on-disk config that omits them.
  const rawConfig = {
    version: 1,
    selfAddress: flags.self,
    credentialsEnvFile: flags.credentialsEnvFile,
    dbPath: flags.dbPath ?? resolveDefaultDbPath(io.env, io.homedir),
    // D-P5B12-1: like dbPath, worktreesRoot's default needs env/homedir, so
    // it is resolved HERE (there is no dedicated flag yet — operators edit
    // config.json for a custom value; projects/baseRef/pollIntervalSeconds
    // get their pure defaults inside validateConfig itself).
    worktreesRoot: resolveDefaultWorktreesRoot(io.env, io.homedir),
    mailbox: flags.mailbox,
    dryRun: flags.dryRun,
  };
  const validated = validateConfig(rawConfig);
  if (!validated.ok) {
    return {
      exitCode: 1,
      messages: [
        'amb setup: configuration is invalid:',
        ...validated.errors.map((error) => `  - ${error}`),
      ],
    };
  }
  const config: BridgeConfig = validated.config;

  // Step 2 (D-P5S-6, D-P5S-3): credentials-file hygiene check, stat-only,
  // BEFORE anything is written — see the module doc comment for why the
  // path is expanded here but the stored config value is not.
  const credentialsPath = expandTilde(config.credentialsEnvFile, io.homedir);
  const credentialsCheck = checkCredentialsFileHygiene(credentialsPath, io.stat);
  if (credentialsCheck.status !== 'pass') {
    const messages = [`amb setup: ${credentialsCheck.message}`];
    if (credentialsCheck.hint !== undefined) {
      messages.push(`  hint: ${credentialsCheck.hint}`);
    }
    return { exitCode: 1, messages };
  }

  // Step 3 (D-P5S-6): write config.json, refusing to silently clobber an
  // existing one.
  const configPath = resolveConfigPath(io.env, io.homedir);
  if (io.stat(configPath) !== null && !flags.forceConfig) {
    return {
      exitCode: 1,
      messages: [
        `amb setup: config already exists at ${configPath} (use --force-config to overwrite it)`,
      ],
    };
  }

  try {
    io.mkdir(dirname(configPath));
    io.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    io.chmod(configPath, 0o600);
  } catch (error) {
    return {
      exitCode: 1,
      messages: [`amb setup: failed to write config at ${configPath}: ${describeError(error)}`],
    };
  }

  // Failures from here on happen AFTER config.json already landed in step 3
  // (deliberately NOT rolled back — setup never deletes user config), so a
  // plain rerun would bounce off the refuse-overwrite gate above with a
  // seemingly-unrelated "config already exists" error. Every step-4/5
  // failure message therefore carries this note naming the written path and
  // the --force-config escape hatch.
  const configAlreadyWrittenNote =
    `note: config was already written to ${configPath} by this run; ` +
    'rerunning setup after fixing this will need --force-config';

  // Step 4 (D-P5S-6): open the database — creates the file and runs
  // migrations if new. SQLite never creates missing parent directories on
  // its own (unlike step 3's config write, which `mkdir -p`s its own), so
  // that happens here first.
  const dbPath = expandTilde(config.dbPath, io.homedir);
  let db: ReturnType<typeof openDatabase>;
  try {
    io.mkdir(dirname(dbPath));
    db = io.openDatabase(dbPath);
  } catch (error) {
    return {
      exitCode: 1,
      messages: [
        `amb setup: failed to open database at ${dbPath}: ${describeError(error)}`,
        configAlreadyWrittenNote,
      ],
    };
  }

  let readyAtMessage: string;
  try {
    // Step 5 (D-P5S-6): the first-install fence, productized. Read BEFORE
    // writing so the message can truthfully say which case happened — the
    // WRITE itself is idempotent regardless (`setReadyAtIfUnset`,
    // `src/store/metaStore.ts`).
    const metaStore = new MetaStore(db);
    const priorReadyAt = metaStore.getReadyAt();
    const effectiveReadyAt = metaStore.setReadyAtIfUnset(now.toISOString());
    readyAtMessage =
      priorReadyAt === null
        ? `readyAt set to ${effectiveReadyAt} (first install). Mail received before this instant will NEVER be executed.`
        : `readyAt was already set to ${effectiveReadyAt} (unchanged by this run). Mail received before this instant will NEVER be executed.`;
  } catch (error) {
    // Caught and converted, mirroring doctor.ts's readyAtCheck — a
    // metaStore failure must become an ordinary { exitCode: 1 } result,
    // never a throw out of runSetup (see the module doc comment's
    // never-throwing contract). The finally below still closes the handle
    // before this return completes.
    return {
      exitCode: 1,
      messages: [
        `amb setup: failed to record readyAt in ${dbPath}: ${describeError(error)}`,
        configAlreadyWrittenNote,
      ],
    };
  } finally {
    db.close();
  }

  // Step 6 (D-P5S-6): next steps.
  return {
    exitCode: 0,
    messages: [
      `config written to ${configPath}`,
      readyAtMessage,
      'next: run `amb doctor` to verify the installation (background daemon install arrives with the full Phase 5 release)',
    ],
  };
}
