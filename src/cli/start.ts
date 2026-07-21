/**
 * `amb start` (decision D-P5B12-5): loadConfig → assembleDaemon →
 * runDaemonShell, exit code mapped from the shell outcome — `signal` ⇒ 0
 * (a requested stop is a success), `fatal` ⇒ 1 (three consecutive failed
 * rounds; restart policy belongs to the operator's supervisor). The daemon
 * runs in the FOREGROUND: v0.1 ships no daemonizer — `amb install`
 * (`./service.ts`) writes the launchd/systemd user unit that supervises it.
 *
 * `--dry-run` overrides `config.dryRun` to `true` for this run only: a
 * full-chain rehearsal in which every dispatch intent lands
 * `SKIPPED_DRY_RUN` — zero codex invocations, zero model quota (red line
 * 5's rehearsal mode).
 *
 * `runStart(args, io)` is pure of real globals (the cli-doctor/cli-setup io
 * discipline): `StartIo` carries the config-read pieces plus the assembly
 * (`assemble`), the shell (`runShell`), and the shell's three injected
 * effects (`sleep`/`onShutdownSignal`/`log`) so tests pin the glue with
 * fakes. The `buildReal*` functions at the bottom are the ONE place the
 * real implementations are bound — including the production
 * `AssemblyBuilders` (real IMAP/SMTP transport constructors, the real
 * codex driver, real git/fs worktree io). Real IO happens only when the
 * daemon RUNS, never at binding time.
 *
 * Daemon log lines are TEED (D-P5B13-4): once assembly succeeds, every
 * line — start's own lifecycle lines and everything the shell emits — goes
 * through both `io.log` (production: `console.error`) and the rotating
 * file sink built at `resolveDefaultLogDir` (`./logSink.ts`), closed after
 * the shell exits. Both routes receive the SAME already-scrubbed text, so
 * the file surface shares the console surface's red-line-2 boundary.
 *
 * RED LINES: the shell's `log` binds to `console.error` HERE — `src/cli/**`
 * is the eslint `no-console` exemption surface — and every line the shell
 * hands it is already scrubbed (`runDaemonShell`'s emit funnel).
 * `selfAddress` and credential values never appear in anything this module
 * prints or logs. Gmail endpoints are pinned constants (imap.gmail.com:993
 * mirrors ADR-0002's measured read half; the SMTP twin lives in
 * `buildDefaultSmtpSend`).
 */
import { mkdirSync, readFileSync as fsReadFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { buildDefaultProjectScanIo, buildProjectIndex } from '../application/projectIndex.js';
import { buildDefaultWorktreeIo, createTaskWorktree } from '../application/worktreeManager.js';
import { assembleDaemon, readCredentialsFile } from '../daemon/assembly.js';
import type { AssembledDaemon, AssemblyBuilders, BuildCoordinatorInput } from '../daemon/assembly.js';
import { runDaemonShell } from '../daemon/shell.js';
import type { ShellDeps, ShellOutcome } from '../daemon/shell.js';
import type { CoordinatorTickConfig } from '../daemon/ticks.js';
import { COORDINATOR_DECISION_SCHEMA } from '../domain/coordinatorDecision.js';
import { scrubText } from '../domain/replyComposition.js';
import { buildDefaultSpawnCodex, createCodexDriver, type SpawnCodex } from '../drivers/codexDriver.js';
import { createCoordinatorDriver } from '../drivers/coordinatorDriver.js';
import { openDatabase } from '../store/database.js';
import {
  buildDefaultSmtpSend,
  buildImapflowFactory,
  createImapReadTransport,
} from '../transports/imapRead.js';

import type { BridgeConfig, LoadConfigIo } from './config.js';
import { loadConfig } from './config.js';
import type { Writer } from './dispatch.js';
import { buildDefaultLogFsOps, buildFileLogSink } from './logSink.js';
import type { FileLogSink } from './logSink.js';
import type { EnvLike } from './paths.js';
import { resolveConfigPath, resolveDefaultLogDir } from './paths.js';

const USAGE = 'usage: amb start [--dry-run]';

/** ADR-0002's measured Gmail read endpoint (v0.1 targets Gmail only; the
 *  SMTP twin `smtp.gmail.com:465` is pinned inside `buildDefaultSmtpSend`). */
const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

export interface StartIo {
  readonly env: EnvLike;
  readonly homedir: string;
  /** Same contract as `LoadConfigIo['readFileSync']`. */
  readonly readFileSync: (path: string) => string;
  readonly writer: Writer;
  /** Production: `assembleDaemon` with `buildProductionAssemblyBuilders()`. */
  readonly assemble: (config: BridgeConfig) => Promise<AssembledDaemon>;
  /** Production: `runDaemonShell`. */
  readonly runShell: (deps: ShellDeps) => Promise<ShellOutcome>;
  /** The shell's sleep — production: a `setTimeout` promise that resolves
   *  early (clearing the timer) when `abort` fires (D-P5B13-1). */
  readonly sleep: (ms: number, abort: AbortSignal) => Promise<void>;
  /** The shell's signal seam — production: SIGINT/SIGTERM listeners. */
  readonly onShutdownSignal: (fn: () => void) => () => void;
  /** The console half of the log tee — production: `console.error`. */
  readonly log: (line: string) => void;
  /** The file half of the log tee (D-P5B13-4) — production:
   *  `buildFileLogSink` with real fs and a scrubbed failure reporter. */
  readonly buildLogSink: (dir: string) => FileLogSink;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runStart(args: readonly string[], io: StartIo): Promise<number> {
  let dryRunFlag: boolean;
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { 'dry-run': { type: 'boolean', default: false } },
      allowPositionals: false,
      strict: true,
    });
    dryRunFlag = values['dry-run'];
  } catch (error) {
    io.writer.err(`amb start: invalid arguments: ${describeError(error)} (${USAGE})`);
    return 2;
  }

  // Review Minor-1 (batch 12): start's OWN log/err lines obey the same
  // scrub discipline as every shell line sharing the stderr stream — the
  // assembly failure message and the rejected-root report both carry
  // already-expanded real paths (typically under the home dir). Needle:
  // `io.homedir` — production-wise the very same `os.homedir()` the
  // assembly's `builders.homedir()` answers.
  const scrub = (line: string): string =>
    scrubText(line, { worktreePath: null, homeDir: io.homedir });

  const configPath = resolveConfigPath(io.env, io.homedir);
  const loadIo: LoadConfigIo = {
    readFileSync: io.readFileSync,
    homedir: io.homedir,
    env: io.env,
  };
  const loaded = loadConfig(configPath, loadIo);
  if (!loaded.ok) {
    io.writer.err('amb start: cannot load config:');
    for (const error of loaded.errors) {
      io.writer.err(`  - ${error}`);
    }
    return 1;
  }
  // --dry-run overrides for THIS RUN only; the on-disk config is untouched.
  const config: BridgeConfig = dryRunFlag ? { ...loaded.config, dryRun: true } : loaded.config;

  let assembled: AssembledDaemon;
  try {
    assembled = await io.assemble(config);
  } catch (error) {
    io.writer.err(scrub(`amb start: ${describeError(error)}`));
    return 1;
  }

  // D-P5B13-4: the log tee. Built only once assembly succeeded (earlier
  // failures already reported through writer.err); every line from here on
  // reaches console AND file with identical, already-scrubbed text.
  const sink = io.buildLogSink(resolveDefaultLogDir(io.env, io.homedir));
  const log = (line: string): void => {
    io.log(line);
    sink.write(line);
  };

  try {
    log(
      `amb daemon starting (poll every ${String(config.pollIntervalSeconds)}s, ` +
        `dry-run: ${config.dryRun ? 'yes' : 'no'})`,
    );
    for (const rejected of assembled.indexRejected) {
      log(scrub(`project root rejected: ${rejected.path} (${rejected.reason})`));
    }

    const outcome = await io.runShell({
      ticks: assembled.ticks,
      metaStore: assembled.metaStore,
      homeDir: assembled.homeDir,
      sleep: io.sleep,
      onShutdownSignal: io.onShutdownSignal,
      log,
      pollIntervalMs: config.pollIntervalSeconds * 1000,
    });

    if (outcome.reason === 'signal') {
      log('amb daemon stopped (shutdown signal)');
      return 0;
    }
    log('amb daemon stopped (fatal — see the errors above)');
    return 1;
  } finally {
    await assembled.close();
    sink.close();
  }
}

// ---------------------------------------------------------------------------
// Production wiring (the only place real implementations are bound)
// ---------------------------------------------------------------------------

/**
 * The real `AssemblyBuilders` (D-P5B12-4). Pure BINDING: nothing here opens
 * a connection, spawns a process, or reads a file until the assembled
 * daemon actually runs. Credentials: `readCredentialsFile` (fail closed,
 * values reach only the transport constructors below — the IMAP factory
 * and the SMTP sender, both of which are constructed with `logger`/debug
 * output hard-disabled per red line 2).
 */
export function buildProductionAssemblyBuilders(): AssemblyBuilders {
  return {
    openDb: (path) => openDatabase(path),
    buildTransport: ({ selfAddress, credentials, registerOutbox }) =>
      createImapReadTransport({
        factory: buildImapflowFactory({
          host: IMAP_HOST,
          port: IMAP_PORT,
          user: credentials.user,
          pass: credentials.pass,
        }),
        send: {
          selfAddress,
          smtpSend: buildDefaultSmtpSend({ user: credentials.user, pass: credentials.pass }),
          registerOutbox,
        },
      }),
    buildDriver: () => createCodexDriver({ spawnCodex: buildDefaultSpawnCodex() }),
    buildIndex: (input) => buildProjectIndex(input, buildDefaultProjectScanIo()),
    createWorktree: (input) => createTaskWorktree(input, buildDefaultWorktreeIo()),
    directoryExists: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    homedir: () => osHomedir(),
    readCredentials: readCredentialsFile,
    clock: () => new Date().toISOString(),
    buildCoordinator: (input) =>
      buildCoordinatorRuntime({ ...input, spawnCodex: buildDefaultSpawnCodex() }),
  };
}

/**
 * Production `AssemblyBuilders.buildCoordinator` (ADR-0006, batch E-d),
 * factored out and exported so the live E2E can reuse the EXACT wiring with a
 * call-capped `spawnCodex` (nothing about the coordinator's construction is
 * test-only). Materializes `COORDINATOR_DECISION_SCHEMA` into the bridge's
 * scratch dir (the `--output-schema` file the read-only turn is shaped by),
 * constructs the read-only codex coordinator driver, and pins `allowResume`
 * OFF — codex 0.144.6's `exec resume` cannot assert `--sandbox`, so multi-turn
 * resume's read-only wall is an unpinned spike (RED LINE 6), and every turn
 * stays a fresh `--sandbox read-only` turn until it lands. The schema file is
 * overwritten each start (idempotent); no cleanup handle, so `close()` is
 * unchanged.
 */
export function buildCoordinatorRuntime(
  input: BuildCoordinatorInput & { spawnCodex: SpawnCodex },
): CoordinatorTickConfig {
  mkdirSync(input.scratchDir, { recursive: true });
  const schemaPath = join(input.scratchDir, 'decision.schema.json');
  writeFileSync(schemaPath, `${JSON.stringify(COORDINATOR_DECISION_SCHEMA, null, 2)}\n`, 'utf8');
  return {
    runCoordinatorTurn: createCoordinatorDriver({ spawnCodex: input.spawnCodex }),
    coordinatorSessionStore: input.coordinatorSessionStore,
    coordinatorCwd: input.scratchDir,
    schemaPath,
    allowResume: false,
  };
}

/**
 * The real `StartIo` (bound once by `main.ts`). Signal seam: one handler
 * for BOTH SIGINT and SIGTERM; the returned unsubscribe removes both, so a
 * finished shell leaves the default signal disposition behind it.
 */
export function buildRealStartIo(writer: Writer): StartIo {
  const home = osHomedir();
  return {
    env: process.env,
    homedir: home,
    readFileSync: (path) => fsReadFileSync(path, 'utf8'),
    writer,
    assemble: (config) => assembleDaemon(config, buildProductionAssemblyBuilders()),
    runShell: runDaemonShell,
    // D-P5B13-1's interruptible sleep contract: never rejects; an abort
    // resolves early and CLEARS the timer (a dangling handle would keep the
    // event loop alive after shutdown; `unref()` is not an option because it
    // would let the loop exit DURING a normal sleep). The abort listener is
    // `{ once: true }` and removed again on the normal-timeout path, so
    // neither side leaks.
    sleep: (ms, abort) =>
      new Promise((resolve) => {
        if (abort.aborted) {
          resolve();
          return;
        }
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          abort.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        abort.addEventListener('abort', onAbort, { once: true });
      }),
    onShutdownSignal: (fn) => {
      const handler = (): void => {
        fn();
      };
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
      return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
      };
    },
    // The src/cli/** no-console exemption surface: the console half of the
    // daemon log tee (text arrives already scrubbed).
    log: (line) => {
      console.error(line);
    },
    // The file half (D-P5B13-4). The sink's own degrade notice is the ONE
    // line it originates itself — an fs error message can carry an expanded
    // home path, so it goes through the same scrub needle as every other
    // stderr line here (red line 2's display surface).
    buildLogSink: (dir) =>
      buildFileLogSink(dir, buildDefaultLogFsOps(), (line) => {
        console.error(scrubText(line, { worktreePath: null, homeDir: home }));
      }),
  };
}
