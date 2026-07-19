/**
 * `amb status` / `amb pause` / `amb resume` (decision D-P5B12-5): the three
 * database-view daemon commands. All three share one honest positioning,
 * stated in the output itself: they read and write the SQLite store the
 * daemon also uses — they NEVER probe whether a daemon process is actually
 * running (there is no IPC channel, no pidfile in v0.1). Concretely:
 *
 *   - `status` reports the DB view: readyAt, the pause flag, per-table
 *     status counts, the UNCERTAIN outbox count (rows awaiting echo
 *     reconciliation — the C3 loop's open items), PENDING clarifications,
 *     and the UID watermarks. It deliberately NEVER echoes `selfAddress`
 *     (red line 2's display surface: the configured address is identity
 *     material and has no business in casual terminal output/scrollback).
 *   - `pause`/`resume` write the D-P5B12-2 meta flag. The daemon reads it
 *     at the top of each poll round, so the change takes effect within one
 *     poll interval — the message says so, quoting the configured
 *     `pollIntervalSeconds`, instead of pretending to be immediate.
 *
 * Same result-value discipline as `runSetup` (D-P5S-6): each command
 * returns `{ exitCode, messages }` and never throws, never prints, never
 * reads real globals — `main.ts` binds the real io and routes messages to
 * stdout (exit 0) or stderr (exit 1). `now` for pause/resume is injected
 * by `main.ts` at the moment of invocation, never read here.
 *
 * Only `src/store/**` may import `better-sqlite3` (D-P5S-7): the stores are
 * imported as VALUES (the doctor.ts/setup.ts precedent), and the handle
 * type is `ReturnType<typeof openDatabase>`.
 */
import { ClarificationStore } from '../store/clarificationStore.js';
import { CommandStore } from '../store/commandStore.js';
import type { openDatabase } from '../store/database.js';
import { IntentStore } from '../store/intentStore.js';
import { MetaStore } from '../store/metaStore.js';
import { OutboxStore } from '../store/outboxStore.js';

import type { BridgeConfig, LoadConfigIo } from './config.js';
import { loadConfig } from './config.js';
import type { EnvLike } from './paths.js';
import { resolveConfigPath } from './paths.js';

export interface StatusIo {
  readonly env: EnvLike;
  readonly homedir: string;
  /** Same contract as `LoadConfigIo['readFileSync']`. */
  readonly readFileSync: (path: string) => string;
  /** Same contract as `DoctorIo['openDatabase']` — in production it IS
   * `openDatabase` (`src/store/database.ts`). */
  readonly openDatabase: (path: string) => ReturnType<typeof openDatabase>;
}

/** Same shape as `SetupResult` (`./setup.ts`): exit 0 ⇒ messages go to
 *  stdout, exit 1 ⇒ stderr — `main.ts` owns the printing. */
export interface StatusCommandResult {
  readonly exitCode: 0 | 1;
  readonly messages: readonly string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ConfigOutcome =
  | { readonly ok: true; readonly config: BridgeConfig }
  | { readonly ok: false; readonly result: StatusCommandResult };

function loadConfigOrFail(command: string, io: StatusIo): ConfigOutcome {
  const configPath = resolveConfigPath(io.env, io.homedir);
  const loadIo: LoadConfigIo = {
    readFileSync: io.readFileSync,
    homedir: io.homedir,
    env: io.env,
  };
  const result = loadConfig(configPath, loadIo);
  if (!result.ok) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        messages: [
          `amb ${command}: cannot load config:`,
          ...result.errors.map((error) => `  - ${error}`),
        ],
      },
    };
  }
  return { ok: true, config: result.config };
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([status, count]) => `${status}=${String(count)}`)
    .join(' ');
}

/**
 * The DB-view report (module doc comment). Opens its own handle and closes
 * it before returning, `doctor`-style — no handle outlives the command.
 */
export function runStatus(io: StatusIo): StatusCommandResult {
  const outcome = loadConfigOrFail('status', io);
  if (!outcome.ok) {
    return outcome.result;
  }
  const { config } = outcome;

  let db: ReturnType<typeof openDatabase>;
  try {
    db = io.openDatabase(config.dbPath);
  } catch (error) {
    return {
      exitCode: 1,
      messages: [`amb status: failed to open database at ${config.dbPath}: ${describeError(error)}`],
    };
  }

  try {
    const metaStore = new MetaStore(db);
    const readyAt = metaStore.getReadyAt();
    const paused = metaStore.getPaused();
    // The pause flag's last-changed instant (the `setPaused` doc promise);
    // omitted entirely when the flag was never touched — a fresh install
    // shows plain `paused: no`, not an invented timestamp.
    const pausedChangedAt = metaStore.getPausedChangedAt();
    const pausedChangedSuffix = pausedChangedAt === null ? '' : ` (last changed at ${pausedChangedAt})`;
    const watermarks = metaStore.listWatermarks();

    const commandCounts = new CommandStore(db).countByStatus();
    const intentCounts = new IntentStore(db).countByStatus();
    const uncertainOutbox = new OutboxStore(db).findByStatus('UNCERTAIN').length;
    const pendingClarifications = new ClarificationStore(db).countByStatus().PENDING;

    const messages: string[] = [
      'bridge status (database view — this command does not detect whether a daemon process is running)',
      readyAt === null
        ? 'readyAt: not set (run `amb setup` to record the first-install fence)'
        : `readyAt: ${readyAt}`,
      paused
        ? `paused: yes (the daemon skips mail processing each round until \`amb resume\`)${pausedChangedSuffix}`
        : `paused: no${pausedChangedSuffix}`,
      `commands: ${formatCounts(commandCounts)}`,
      `intents: ${formatCounts(intentCounts)}`,
      `outbox UNCERTAIN (awaiting echo reconciliation): ${String(uncertainOutbox)}`,
      `clarifications PENDING: ${String(pendingClarifications)}`,
      ...(watermarks.length === 0
        ? ['watermark: none recorded yet']
        : watermarks.map(
            (mark) =>
              `watermark: ${mark.mailbox} uidValidity=${mark.uidValidity} lastUid=${String(mark.lastUid)}`,
          )),
    ];
    return { exitCode: 0, messages };
  } catch (error) {
    return {
      exitCode: 1,
      messages: [`amb status: failed to read status from ${config.dbPath}: ${describeError(error)}`],
    };
  } finally {
    db.close();
  }
}

/** Shared write path for pause/resume (module doc comment). */
function setPausedCommand(
  command: 'pause' | 'resume',
  paused: boolean,
  io: StatusIo,
  now: Date,
): StatusCommandResult {
  const outcome = loadConfigOrFail(command, io);
  if (!outcome.ok) {
    return outcome.result;
  }
  const { config } = outcome;

  let db: ReturnType<typeof openDatabase>;
  try {
    db = io.openDatabase(config.dbPath);
  } catch (error) {
    return {
      exitCode: 1,
      messages: [
        `amb ${command}: failed to open database at ${config.dbPath}: ${describeError(error)}`,
      ],
    };
  }

  try {
    new MetaStore(db).setPaused(paused, now.toISOString());
  } catch (error) {
    return {
      exitCode: 1,
      messages: [`amb ${command}: failed to write the pause flag: ${describeError(error)}`],
    };
  } finally {
    db.close();
  }

  const interval = String(config.pollIntervalSeconds);
  return {
    exitCode: 0,
    messages: [
      paused
        ? 'mail processing paused (flag recorded in the database)'
        : 'mail processing resumed (flag cleared in the database)',
      `the daemon reads this flag at the start of each poll round — the change takes effect within one poll interval (pollIntervalSeconds: ${interval})`,
    ],
  };
}

export function runPause(io: StatusIo, now: Date): StatusCommandResult {
  return setPausedCommand('pause', true, io, now);
}

export function runResume(io: StatusIo, now: Date): StatusCommandResult {
  return setPausedCommand('resume', false, io, now);
}
