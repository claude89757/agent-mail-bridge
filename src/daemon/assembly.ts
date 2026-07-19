/**
 * Daemon composition root (decision D-P5B12-4, plan
 * docs/superpowers/plans/2026-07-19-phase-5-batch12-daemon-shell.md): turns
 * a validated `BridgeConfig` plus a set of injectable BUILDERS into the
 * pre-bound tick set the shell (`./shell.ts`) sequences. Every external
 * construction — database, transport, driver, project index, worktree
 * creation, credentials read, clock, homedir — arrives through
 * `AssemblyBuilders`, so the assembly test suite can assert the full wiring
 * TOPOLOGY (which config field flows where, close order, credentials
 * confinement) against fakes without ever opening a real connection;
 * `buildProductionAssemblyBuilders` (`src/cli/start.ts`) is the only place
 * the real implementations are bound.
 *
 * Credentials (RED LINES 1/2): `readCredentials(config.credentialsEnvFile)`
 * runs FIRST — fail closed before any resource is opened — and its product
 * flows into EXACTLY ONE place: `buildTransport`'s input. No log line, no
 * error message, no other builder input ever carries the values (the
 * assembly test serializes every other builder call and asserts absence).
 * `readCredentialsFile` below is the production reader; its error messages
 * name KEYS and the PATH, never values.
 *
 * Empty project roots (D-P5B12-1's documented default): `buildProjectIndex`
 * itself fails closed on an empty allowlist by design, so the assembly maps
 * `projects.roots: []` to a static empty index WITHOUT calling
 * `buildIndex` — every command then routes to the no-match clarification
 * stopgap, which is exactly the documented behavior of an unconfigured
 * bridge (commands are answered with "cannot route", never dropped).
 *
 * `close()` releases in REVERSE build order — driver → transport → db —
 * so nothing is torn down while a later-built component could still call
 * into it. A builder failure AFTER the db opened closes the db before the
 * error propagates (no leaked handle; better-sqlite3 handles are not
 * GC-closed).
 *
 * `BridgeConfig` is imported TYPE-ONLY from `src/cli/config.ts`: erased at
 * compile time, so `daemon/` carries no runtime dependency on the CLI layer
 * (the `transports/types.ts` ↔ `store/` precedent for cross-layer
 * type-only references).
 *
 * No `console`, no zero-arg `new Date()`/`Date.now()`: time arrives through
 * the injected `clock`, output belongs to the shell/CLI.
 */
import { readFileSync } from 'node:fs';

import type { TransactionRunner } from '../application/ingest.js';
import type { BuildProjectIndexInput, ProjectIndex, RejectedDir } from '../application/projectIndex.js';
import type { CreateWorktreeInput } from '../application/worktreeManager.js';
import type { BridgeConfig } from '../cli/config.js';
import type { AgentDriver } from '../drivers/types.js';
import { ClarificationStore } from '../store/clarificationStore.js';
import { CommandStore } from '../store/commandStore.js';
import type { openDatabase } from '../store/database.js';
import { IntentStore } from '../store/intentStore.js';
import { MetaStore } from '../store/metaStore.js';
import { OutboxStore } from '../store/outboxStore.js';
import { SessionStore } from '../store/sessionStore.js';
import type { MailTransport, OutboundMail, SendReceipt } from '../transports/types.js';
import { buildRegisterOutbox } from './replySender.js';
import type { ShellTicks } from './shell.js';
import {
  recoverInterruptedIntents,
  runMailTick,
  runOrphanTick,
  sweepExpiredClarifications,
  sweepStrandedSending,
} from './ticks.js';
import type { MailTickDeps } from './ticks.js';

export interface AssemblyCredentials {
  user: string;
  pass: string;
}

/** What the transport builder receives — the ONLY sink credentials ever
 *  flow into (module doc comment). `registerOutbox` is the production
 *  `buildRegisterOutbox` product over the assembly's own stores: the
 *  transport must persist the outbox row BEFORE any SMTP submission (C3). */
export interface BuildTransportInput {
  selfAddress: string;
  credentials: AssemblyCredentials;
  registerOutbox: (receipt: SendReceipt, mail: OutboundMail) => Promise<void>;
}

/**
 * Every external construction `assembleDaemon` performs, injectable
 * (D-P5B12-4 "全部可注入，测试替身"). `createWorktree`/`directoryExists`
 * are builders too — the plan sketch's list named the constructor family;
 * these two are the remaining `MailTickDeps` seams and follow the same
 * principle (production bindings: `createTaskWorktree` + `fs` in
 * `src/cli/start.ts`).
 */
export interface AssemblyBuilders {
  /** Production: `openDatabase` (`src/store/database.ts`). */
  openDb(path: string): ReturnType<typeof openDatabase>;
  buildTransport(input: BuildTransportInput): MailTransport;
  buildDriver(): AgentDriver;
  /** Production: `buildProjectIndex` + `buildDefaultProjectScanIo`. NEVER
   *  called with empty roots — see the module doc comment. */
  buildIndex(
    input: BuildProjectIndexInput,
  ): Promise<{ index: ProjectIndex; rejected: readonly RejectedDir[] }>;
  createWorktree(input: CreateWorktreeInput): Promise<{ worktreePath: string; baseCommit: string }>;
  directoryExists(path: string): Promise<boolean>;
  /** Production: `os.homedir()` — read ONCE here at the boundary. */
  homedir(): string;
  /** Production: `readCredentialsFile` below. Throws on any missing piece
   *  (fail closed); the values it returns reach ONLY `buildTransport`. */
  readCredentials(envFilePath: string): AssemblyCredentials;
  /** Production: `() => new Date().toISOString()`. */
  clock(): string;
}

export interface AssembledDaemon {
  ticks: ShellTicks;
  metaStore: MetaStore;
  /** `builders.homedir()`'s answer — the shell's scrub needle. */
  homeDir: string;
  /** The index build report's rejected roots (empty when roots was empty
   *  and no build ran) — log material for `amb start`. */
  indexRejected: readonly RejectedDir[];
  /** Reverse build order: driver → transport → db (module doc comment). */
  close(): Promise<void>;
}

/** The lookup-nothing index an empty `projects.roots` maps to. */
const EMPTY_INDEX: ProjectIndex = {
  entries: [],
  lookup: () => [],
};

export async function assembleDaemon(
  config: BridgeConfig,
  builders: AssemblyBuilders,
): Promise<AssembledDaemon> {
  // Credentials FIRST: the cheapest, most likely misconfiguration fails
  // before any resource is opened (module doc comment).
  const credentials = builders.readCredentials(config.credentialsEnvFile);

  const db = builders.openDb(config.dbPath);

  try {
    const commandStore = new CommandStore(db);
    const intentStore = new IntentStore(db);
    const sessionStore = new SessionStore(db);
    const outboxStore = new OutboxStore(db);
    const metaStore = new MetaStore(db);
    const clarificationStore = new ClarificationStore(db);

    // The better-sqlite3 handle satisfies the structural TransactionRunner
    // face directly (ingest.ts's documented stance).
    const transactionDb: TransactionRunner = db;

    const registerOutbox = buildRegisterOutbox({
      db: transactionDb,
      outboxStore,
      clock: builders.clock,
    });

    const transport = builders.buildTransport({
      selfAddress: config.selfAddress,
      credentials,
      registerOutbox,
    });

    const driver = builders.buildDriver();

    const { index, rejected } =
      config.projects.roots.length === 0
        ? { index: EMPTY_INDEX, rejected: [] as readonly RejectedDir[] }
        : await builders.buildIndex(config.projects);

    const homeDir = builders.homedir();

    const mailTickDeps: MailTickDeps = {
      db: transactionDb,
      transport,
      commandStore,
      intentStore,
      sessionStore,
      outboxStore,
      metaStore,
      index,
      driver,
      createWorktree: builders.createWorktree,
      directoryExists: builders.directoryExists,
      worktreesRoot: config.worktreesRoot,
      baseRef: config.baseRef,
      homeDir,
      mailbox: config.mailbox,
      ingestConfig: {
        selfAddress: config.selfAddress,
        dryRun: config.dryRun,
        ...(config.timeWindow !== undefined ? { timeWindow: config.timeWindow } : {}),
      },
      clock: builders.clock,
    };

    const ticks: ShellTicks = {
      recover: () => recoverInterruptedIntents({ intentStore, clock: builders.clock }),
      sweepStranded: () => sweepStrandedSending({ outboxStore, clock: builders.clock }),
      mailTick: () => runMailTick(mailTickDeps),
      orphanTick: () => runOrphanTick(mailTickDeps),
      sweepExpired: () => sweepExpiredClarifications({ clarificationStore, clock: builders.clock }),
    };

    return {
      ticks,
      metaStore,
      homeDir,
      indexRejected: rejected,
      close: async (): Promise<void> => {
        await driver.close();
        await transport.close();
        db.close();
      },
    };
  } catch (error) {
    // No leaked handle on a partial assembly (module doc comment).
    db.close();
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Production credentials reader                                       */
/* ------------------------------------------------------------------ */

const USER_KEYS = ['AMB_IMAP_USER', 'AMB_TEST_IMAP_USER'] as const;
const PASS_KEYS = ['AMB_IMAP_PASS', 'AMB_TEST_IMAP_PASS'] as const;

/**
 * `KEY=VALUE` env-file parsing with EXACTLY `tests/helpers/liveCreds.ts`'s
 * semantics (that helper lives under `tests/` and cannot be imported from
 * `src/`, so the rules are restated, not shared): physical lines (CRLF
 * tolerated), `#` comments (leading whitespace tolerated) and blank lines
 * skipped, no-`=` lines skipped, key trimmed, VALUE VERBATIM after the
 * first `=` (never trimmed, never de-quoted — an app password's bytes are
 * not this parser's to edit), last occurrence wins.
 */
function parseEnvFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) {
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    if (key.length === 0) {
      continue;
    }
    entries.set(key, line.slice(eqIdx + 1));
  }
  return entries;
}

/**
 * Production `AssemblyBuilders.readCredentials` (D-P5B12-4): reads the
 * config-named env file and extracts the IMAP/SMTP credential pair.
 * Accepts two key families — `AMB_IMAP_USER`/`AMB_IMAP_PASS` (generic,
 * preferred) and `AMB_TEST_IMAP_USER`/`AMB_TEST_IMAP_PASS` (the
 * `tests/live` `loadLiveCreds` family the dedicated test mailbox's
 * `~/.secrets/amb-test.env` already uses, red line 1) — per slot the
 * generic name wins when both are present.
 *
 * UNLIKE `loadLiveCreds` (which collapses every failure to `null` because
 * a missing opt-in file is an ordinary state for the live suites), this
 * reader THROWS on a missing/unreadable file or a missing/empty key: for
 * the daemon a credentials problem is a startup-blocking misconfiguration,
 * and fail closed beats a silent no-auth connect attempt. RED LINE 2:
 * every error message names KEYS and the PATH only — a credential VALUE is
 * never interpolated into any string this function constructs.
 */
export function readCredentialsFile(envFilePath: string): AssemblyCredentials {
  let text: string;
  try {
    text = readFileSync(envFilePath, 'utf8');
  } catch {
    // Deliberately NOT the underlying error message: fs errors repeat the
    // path (fine) but keeping the message fully self-authored guarantees
    // no foreign text ever rides along.
    throw new Error(`credentials file is missing or unreadable: ${envFilePath}`);
  }

  const entries = parseEnvFile(text);
  const pick = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const value = entries.get(key);
      if (value !== undefined && value.length > 0) {
        return value;
      }
    }
    return undefined;
  };

  const user = pick(USER_KEYS);
  if (user === undefined) {
    throw new Error(
      `credentials file ${envFilePath}: missing ${USER_KEYS.join(' or ')} (fail closed)`,
    );
  }
  const pass = pick(PASS_KEYS);
  if (pass === undefined) {
    throw new Error(
      `credentials file ${envFilePath}: missing ${PASS_KEYS.join(' or ')} (fail closed)`,
    );
  }

  return { user, pass };
}
