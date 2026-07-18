/**
 * CLI subcommand dispatch (decision D-P5S-5): the entire testable command
 * surface -- `doctor`, `setup`, the four daemon-dependent placeholders
 * (`status`/`pause`/`resume`/`logout`), `--help`, `--version`, no-args, and
 * unknown-command handling -- lives here as a pure function of injected
 * `DispatchIo`. `src/cli/main.ts` (Task 3) is the only place that reads
 * real `process.argv`/`process.env`/`os.homedir()`/`fs`/`console`; it
 * assembles a real `DispatchIo` and calls `dispatch` once. That split is
 * what lets every scenario below be tested by calling `dispatch` directly
 * (D-P5S-7) instead of spawning a subprocess.
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
  /** Handles `setup <rest>`. A Task-3 stub (`createSetupPlaceholder`) until
   * Task 4 wires the real `runSetup` from `src/cli/setup.ts` -- see the
   * module doc comment. */
  readonly runSetup: (args: readonly string[]) => number;
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
  { name: 'status', summary: 'Show daemon status (requires the background daemon)' },
  { name: 'pause', summary: 'Pause mail processing (requires the background daemon)' },
  { name: 'resume', summary: 'Resume mail processing (requires the background daemon)' },
  { name: 'logout', summary: 'Remove stored credentials and config (requires the background daemon)' },
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

const PLACEHOLDER_COMMANDS = new Set(['status', 'pause', 'resume', 'logout']);

function reportPlaceholderCommand(command: string, writer: Writer): number {
  writer.err(
    `\`amb ${command}\` is not available yet: it requires the background daemon, which has not been implemented (arrives with the real Phase 5 daemon).`,
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
 * D-P5S-1 sense). Returns a plain exit code; never calls `process.exit`
 * (see the module doc comment).
 */
export function dispatch(argv: readonly string[], io: DispatchIo): number {
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

  if (head === 'doctor') {
    return runDoctorCommand(io);
  }

  if (head === 'setup') {
    return io.runSetup(rest);
  }

  if (PLACEHOLDER_COMMANDS.has(head)) {
    return reportPlaceholderCommand(head, io.writer);
  }

  return reportUnknownCommand(head, io.writer);
}
