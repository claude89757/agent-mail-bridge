/**
 * CLI subcommand dispatch (decision D-P5S-5, amended by D-P5B12-5): the
 * entire testable command surface -- `doctor`, `setup`, the four real
 * daemon commands (`start`/`status`/`pause`/`resume`), the one remaining
 * placeholder (`logout`, held for the keychain open question), `--help`,
 * `--version`, no-args, and unknown-command handling -- lives here as a
 * pure function of injected `DispatchIo`. `src/cli/main.ts` is the only
 * place that reads real `process.argv`/`process.env`/`os.homedir()`/`fs`/
 * `console`; it assembles a real `DispatchIo` and calls `dispatch` once.
 * That split is what lets every scenario below be tested by calling
 * `dispatch` directly (D-P5S-7) instead of spawning a subprocess.
 *
 * `dispatch` is ASYNC since batch 12: `amb start` runs the long-lived
 * daemon shell to completion, so its route (and therefore this function)
 * resolves to the exit code instead of returning it synchronously. Every
 * other route stays synchronous inside and is simply awaited through.
 *
 * D-P5S-1 locks `node:util`'s `parseArgs` in as the CLI's parsing tool, but
 * also locks subcommand dispatch itself as HAND-ROLLED on the first
 * argv token ("argv[2] 为子命令名，其余交 parseArgs" -- argv[2] in the raw
 * `process.argv` sense is `argv[0]` of the sliced array this module
 * receives). `parseArgs` is therefore deliberately NOT called in this
 * file: there is nothing here yet that needs option-with-value parsing
 * (`doctor` takes no flags; `setup` is a Task-3 stub that ignores its
 * args). Its first real use is inside Task 4's `setup.ts`, parsing the
 * `rest` this module already isolates and hands to `io.runSetup`.
 *
 * `setup` is the one command routed through an INJECTED handler
 * (`io.runSetup`) rather than being implemented inline like the daemon
 * placeholders: Task 4 added `src/cli/setup.ts` and only modified
 * `main.ts` to wire the real implementation in as `io.runSetup` -- this
 * file's route (`case 'setup': return io.runSetup(rest)`) did not change,
 * exactly as designed. `createSetupPlaceholder` below is the Task-3 stub;
 * it stays exported purely so `tests/unit/cli-dispatch.test.ts` can keep
 * pinning dispatch's OWN routing behavior independent of the real `setup`
 * implementation -- `main.ts` no longer references it.
 *
 * No `process.exit` anywhere here (or anywhere reachable from `dispatch`):
 * every path returns a plain exit-code number. `main.ts` is the only place
 * that assigns `process.exitCode`, which lets stdout/stderr flush before
 * the process actually exits.
 */
import type { BridgeConfig, LoadConfigIo } from './config.js';
import { loadConfig } from './config.js';
import type { DoctorContext, DoctorIo } from './doctor.js';
import { buildDefaultChecks, renderDoctorReport, runDoctor } from './doctor.js';
import type { EnvLike } from './paths.js';
import { resolveConfigPath } from './paths.js';

// ---------------------------------------------------------------------------
// IO surface
// ---------------------------------------------------------------------------

/**
 * Where all CLI output goes. `main.ts`'s real implementation wraps
 * `console.log`/`console.error` (the one legitimate use of `console` per
 * `eslint.config.js`'s `src/cli/**` exemption); every function in this
 * file writes through an injected `Writer` instead, so tests can assert on
 * exact lines without capturing global `console` (and without the ordering
 * ambiguity of interleaved real stdout/stderr writes).
 */
export interface Writer {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * Everything `dispatch` needs, injected. `env`/`homedir`/`readFileSync`/
 * `doctorIo` are exactly the real values `main.ts` reads once
 * (`process.env`, `os.homedir()`, a `fs.readFileSync` wrapper, and
 * `buildDefaultDoctorIo()` from `./doctor.js`) -- bundled flatly here
 * (matching `LoadConfigIo`'s style in `./config.ts`) rather than as a
 * nested "doctor sub-object", since `doctor` is the only v1 command that
 * needs real IO at all.
 */
export interface DispatchIo {
  readonly writer: Writer;
  /** The running package's version string (e.g. read from `package.json`
   * by `main.ts`), printed verbatim by `--version`. */
  readonly version: string;
  readonly env: EnvLike;
  readonly homedir: string;
  /** `fs.readFileSync`-like: takes a path, returns its UTF-8 text, throws
   * like `node:fs` on a missing/unreadable file. Same contract as
   * `LoadConfigIo['readFileSync']` (`./config.ts`). */
  readonly readFileSync: (path: string) => string;
  readonly doctorIo: DoctorIo;
  /** Handles `setup <rest>` -- `main.ts` binds `src/cli/setup.ts`'s real
   * `runSetup`; see the module doc comment. */
  readonly runSetup: (args: readonly string[]) => number;
  /** Handles `start <rest>` (D-P5B12-5) -- `main.ts` binds
   * `src/cli/start.ts`'s `runStart` with real io. Async because the daemon
   * runs to completion inside it. */
  readonly runStart: (args: readonly string[]) => number | Promise<number>;
  /** Handles `status` -- `main.ts` binds `src/cli/statusCmd.ts`'s
   * `runStatus` (printing included, per the runSetup binding precedent). */
  readonly runStatus: () => number;
  /** Handles `pause` -- `main.ts` binds `runPause` with a fresh `now`. */
  readonly runPause: () => number;
  /** Handles `resume` -- `main.ts` binds `runResume` with a fresh `now`. */
  readonly runResume: () => number;
  /** Handles `install <rest>` (D-P5B13-5) -- `main.ts` binds
   * `src/cli/service.ts`'s `runInstall` (printing included); the rest of
   * the argv passes through so --force parsing lives in the handler. */
  readonly runInstall: (args: readonly string[]) => number;
  /** Handles `uninstall <rest>` (D-P5B13-5) -- same binding pattern. */
  readonly runUninstall: (args: readonly string[]) => number;
}

// ---------------------------------------------------------------------------
// Help text (D-P5S-5 full command surface, including placeholders)
// ---------------------------------------------------------------------------

interface CommandSummary {
  readonly name: string;
  readonly summary: string;
}

const COMMANDS: readonly CommandSummary[] = [
  { name: 'doctor', summary: 'Run local health checks (Node version, config, credentials, database)' },
  { name: 'setup', summary: 'Write the initial config and record the first-install fence' },
  { name: 'start', summary: 'Run the mail-processing daemon in the foreground (--dry-run rehearses without executing)' },
  { name: 'status', summary: 'Show bridge status from the database (does not probe a running daemon)' },
  { name: 'pause', summary: 'Pause mail processing (takes effect within one poll interval)' },
  { name: 'resume', summary: 'Resume mail processing (takes effect within one poll interval)' },
  { name: 'install', summary: 'Write the launchd/systemd user service file and print the activation command (never runs it)' },
  { name: 'uninstall', summary: 'Remove the service file and list the remaining artifacts to clean up manually' },
  { name: 'logout', summary: 'Remove stored credentials and config (not implemented yet)' },
];

const NAME_COLUMN_WIDTH = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;

function buildHelpText(): string {
  const commandLines = COMMANDS.map((c) => `  ${c.name.padEnd(NAME_COLUMN_WIDTH)}${c.summary}`);
  return [
    'Usage: amb <command> [options]',
    '',
    'Commands:',
    ...commandLines,
    '',
    'Options:',
    '  --help       Show this help message',
    '  --version    Print the installed version',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// setup (Task-3 stub -- see module doc comment)
// ---------------------------------------------------------------------------

/**
 * The Task-3 placeholder `io.runSetup` handler. `amb setup`'s real
 * implementation (D-P5S-6) landed in Task 4 as `src/cli/setup.ts`'s
 * `runSetup`, which `main.ts` now wires in instead of this placeholder.
 * Kept here (exported) only because `tests/unit/cli-dispatch.test.ts` still
 * uses it to pin dispatch's own routing behavior independently of the real
 * setup implementation.
 */
export function createSetupPlaceholder(writer: Writer): (args: readonly string[]) => number {
  return () => {
    writer.err('`amb setup` is not implemented yet in this build.');
    writer.err('It will be wired up in a follow-up change.');
    return 2;
  };
}

// ---------------------------------------------------------------------------
// doctor assembly
// ---------------------------------------------------------------------------

/**
 * Assembles a `DoctorContext` from `io`'s real-shaped-but-injectable
 * pieces (`resolveConfigPath` + `loadConfig`, per D-P5S-2), runs the five
 * v1 checks (`buildDefaultChecks` + `runDoctor`, per D-P5S-4), prints the
 * rendered report to stdout, and returns `runDoctor`'s own exit code.
 * `main.ts` never calls this directly -- it only ever goes through
 * `dispatch`.
 */
function runDoctorCommand(io: DispatchIo): number {
  const configPath = resolveConfigPath(io.env, io.homedir);
  const loadIo: LoadConfigIo = { readFileSync: io.readFileSync, homedir: io.homedir, env: io.env };
  const configResult = loadConfig(configPath, loadIo);

  const config: BridgeConfig | null = configResult.ok ? configResult.config : null;
  const configErrors: readonly string[] = configResult.ok ? [] : configResult.errors;

  const ctx: DoctorContext = { configPath, config, configErrors, io: io.doctorIo };
  const { results, exitCode } = runDoctor(buildDefaultChecks(), ctx);

  io.writer.out(renderDoctorReport(results));
  return exitCode;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Batch 12 (D-P5B12-5) shrank this to `logout` alone: credential-storage
 *  cleanup is held for the keychain open question (roadmap open question 1);
 *  every other former placeholder now routes to a real handler. */
const PLACEHOLDER_COMMANDS = new Set(['logout']);

/** D-P6B15-1: the four commands that take no flags share one router-level
 *  usage gate — any extra argument is a usage error (exit 2, per
 *  D-P5B13-2's uniform convention), reported here so the handlers never see
 *  a non-empty argv. The flag-taking commands (`setup`/`start`/`install`/
 *  `uninstall`) keep owning their own parsing and stay out of this set. */
const NO_ARGUMENT_COMMANDS = new Set(['doctor', 'status', 'pause', 'resume']);

function reportExtraArguments(command: string, writer: Writer): number {
  writer.err(`amb ${command}: takes no arguments (usage: amb ${command})`);
  return 2;
}

function reportPlaceholderCommand(command: string, writer: Writer): number {
  writer.err(
    `\`amb ${command}\` is not implemented yet: credential-storage cleanup is pending the keychain decision.`,
  );
  return 2;
}

function reportUnknownCommand(command: string, writer: Writer): number {
  writer.err(`Unknown command: ${command}`);
  writer.err(buildHelpText());
  return 2;
}

/**
 * `argv` is the already-sliced, user-facing argument list (what `main.ts`
 * passes as `process.argv.slice(2)` -- `argv[0]` here is `argv[2]` in the
 * D-P5S-1 sense). Resolves to a plain exit code; never calls
 * `process.exit` (see the module doc comment). Async solely for `start`
 * (module doc comment) -- every other route completes synchronously.
 */
export async function dispatch(argv: readonly string[], io: DispatchIo): Promise<number> {
  const [head, ...rest] = argv;

  if (head === undefined) {
    // No-args: the plan is silent here (only "unknown command -> help +
    // exit 2" is specified). We pick the friendlier, common CLI convention
    // of treating bare no-args the same as `--help` (stdout, exit 0)
    // rather than as an error -- see the matching test comment.
    io.writer.out(buildHelpText());
    return 0;
  }

  if (head === '--help') {
    io.writer.out(buildHelpText());
    return 0;
  }

  if (head === '--version') {
    io.writer.out(io.version);
    return 0;
  }

  if (NO_ARGUMENT_COMMANDS.has(head) && rest.length > 0) {
    return reportExtraArguments(head, io.writer);
  }

  if (head === 'doctor') {
    return runDoctorCommand(io);
  }

  if (head === 'setup') {
    return io.runSetup(rest);
  }

  if (head === 'start') {
    return io.runStart(rest);
  }

  if (head === 'status') {
    return io.runStatus();
  }

  if (head === 'pause') {
    return io.runPause();
  }

  if (head === 'resume') {
    return io.runResume();
  }

  if (head === 'install') {
    return io.runInstall(rest);
  }

  if (head === 'uninstall') {
    return io.runUninstall(rest);
  }

  if (PLACEHOLDER_COMMANDS.has(head)) {
    return reportPlaceholderCommand(head, io.writer);
  }

  return reportUnknownCommand(head, io.writer);
}
