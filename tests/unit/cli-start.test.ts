import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RejectedDir } from '../../src/application/projectIndex.js';
import type { Writer } from '../../src/cli/dispatch.js';
import { resolveConfigPath } from '../../src/cli/paths.js';
import { buildProductionAssemblyBuilders, buildRealStartIo, runStart } from '../../src/cli/start.js';
import type { StartIo } from '../../src/cli/start.js';
import type { AssembledDaemon } from '../../src/daemon/assembly.js';
import type { ShellDeps, ShellOutcome } from '../../src/daemon/shell.js';
import { buildImapflowFactory } from '../../src/transports/imapRead.js';
import { withStdioSpy } from '../helpers/stdioSpy.js';

// Guards D-P5B12-5's `amb start` half: loadConfig → assembleDaemon →
// runDaemonShell wiring, the --dry-run config override, exit-code mapping
// (signal=0 / fatal=1), close-always semantics, and the red-line-2 display
// surface (selfAddress and credential material never appear in any output
// or log line; start's own log/err lines pass through scrubText, matching
// the shell's discipline on the same stderr stream). `assemble`/`runShell`
// are INJECTED fakes — the real assembly/shell have their own suites; this
// file only pins the CLI glue, per the cli-doctor/cli-setup io-injection
// precedent.
//
// The `buildProductionAssemblyBuilders` describe at the bottom is the
// batch-12 review's Important-1 guard: `no-console` does not police
// `src/cli/**` (exempt) nor raw `process.stderr.write` anywhere, so a
// credential value reaching ANY stdio channel from the production binding
// area would survive lint + every other test. That guard spies every
// stdio sink while running the two credential-touching builders — both
// pure construction, ZERO network (see the describe comment). `imapflow`
// is module-mocked file-wide so even an accidental construct-and-connect
// could never open a real connection.

const imapflowCaptured = vi.hoisted(() => ({ ctorOpts: [] as Record<string, unknown>[] }));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(opts: Record<string, unknown>) {
      imapflowCaptured.ctorOpts.push(opts);
    }

    connect(): Promise<void> {
      // No-op: with the module mocked there is NOTHING that could reach
      // the network (red line: this batch never opens a real connection).
      return Promise.resolve();
    }
  },
}));

const HOME = '/fake-home';
const SELF = 'bridge-user@example.com';

const CONFIG_RAW = {
  version: 1,
  selfAddress: SELF,
  credentialsEnvFile: '/fake-home/.secrets/amb-test.env',
  dbPath: '/fake-home/.local/share/agent-mail-bridge/bridge.db',
  worktreesRoot: '/fake-home/.local/share/agent-mail-bridge/worktrees',
  pollIntervalSeconds: 45,
};

function makeWriter(): Writer & { readonly outLines: string[]; readonly errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

interface HarnessOptions {
  configJson?: string | null;
  assembleImpl?: StartIo['assemble'];
  runShellImpl?: StartIo['runShell'];
  indexRejected?: readonly RejectedDir[];
}

interface Harness {
  io: StartIo;
  writer: ReturnType<typeof makeWriter>;
  logs: string[];
  assembledConfigs: unknown[];
  shellDeps: ShellDeps[];
  closed: number;
  fakeTicks: AssembledDaemon['ticks'];
  fakeMetaStore: AssembledDaemon['metaStore'];
  /** The fake file sink (D-P5B13-4 tee): what runStart's buildLogSink
   *  produced wrote/closed, plus the directory it was asked to build at. */
  sinkWritten: string[];
  sinkClosed: number;
  sinkDirs: string[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const writer = makeWriter();
  const logs: string[] = [];
  const assembledConfigs: unknown[] = [];
  const shellDeps: ShellDeps[] = [];

  const fakeTicks = {
    recover: () => ({ recovered: [] }),
    sweepStranded: () => ({ swept: [] }),
    mailTick: () => Promise.reject(new Error('fake ticks are never run by cli-start tests')),
    orphanTick: () => Promise.reject(new Error('fake ticks are never run by cli-start tests')),
    sweepExpired: () => ({ expired: [] }),
  };
  const fakeMetaStore = { getPaused: () => false } as AssembledDaemon['metaStore'];

  const harness: Harness = {
    io: {
      env: {},
      homedir: HOME,
      readFileSync: (path) => {
        if (options.configJson === null) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        if (path !== resolveConfigPath({}, HOME)) {
          throw new Error(`unexpected read of ${path}`);
        }
        return options.configJson ?? JSON.stringify(CONFIG_RAW);
      },
      writer,
      assemble:
        options.assembleImpl ??
        (async (config): Promise<AssembledDaemon> => {
          assembledConfigs.push(config);
          return {
            ticks: fakeTicks,
            metaStore: fakeMetaStore,
            homeDir: HOME,
            indexRejected: options.indexRejected ?? [],
            close: async (): Promise<void> => {
              harness.closed += 1;
            },
          };
        }),
      runShell:
        options.runShellImpl ??
        (async (deps): Promise<ShellOutcome> => {
          shellDeps.push(deps);
          return { reason: 'signal' };
        }),
      sleep: async () => {
        /* injected only to be passed through */
      },
      onShutdownSignal: () => () => {
        /* unsubscribe no-op */
      },
      log: (line) => logs.push(line),
      buildLogSink: (dir) => {
        harness.sinkDirs.push(dir);
        return {
          write: (line) => harness.sinkWritten.push(line),
          close: () => {
            harness.sinkClosed += 1;
          },
        };
      },
    },
    writer,
    logs,
    assembledConfigs,
    shellDeps,
    closed: 0,
    fakeTicks,
    fakeMetaStore,
    sinkWritten: [],
    sinkClosed: 0,
    sinkDirs: [],
  };
  return harness;
}

describe('runStart (D-P5B12-5)', () => {
  it('happy path: loads config, assembles, runs the shell with the assembled ticks/metaStore/homeDir plus the io-provided sleep/signal/log and pollIntervalSeconds*1000; signal maps to exit 0 and close always runs', async () => {
    const h = makeHarness();

    const exitCode = await runStart([], h.io);

    expect(exitCode).toBe(0);
    expect(h.assembledConfigs).toHaveLength(1);
    const config = h.assembledConfigs[0] as { dryRun: boolean; pollIntervalSeconds: number };
    expect(config.dryRun).toBe(false);
    expect(config.pollIntervalSeconds).toBe(45);

    expect(h.shellDeps).toHaveLength(1);
    const deps = h.shellDeps[0];
    expect(deps?.ticks).toBe(h.fakeTicks);
    expect(deps?.metaStore).toBe(h.fakeMetaStore);
    expect(deps?.homeDir).toBe(HOME);
    expect(deps?.sleep).toBe(h.io.sleep);
    expect(deps?.onShutdownSignal).toBe(h.io.onShutdownSignal);
    // D-P5B13-4: the shell's log is the TEE wrapper (console + file sink)
    // now, no longer io.log itself — the dedicated tee test below asserts
    // both routes receive every line.
    expect(deps?.log).not.toBe(h.io.log);
    expect(deps?.pollIntervalMs).toBe(45_000);

    expect(h.closed).toBe(1);
    expect(h.sinkClosed).toBe(1);

    // RED LINE 2 display surface: nothing start prints or logs ever carries
    // the self address (and there are no credential values in scope at all).
    const everything = [...h.writer.outLines, ...h.writer.errLines, ...h.logs].join('\n');
    expect(everything).not.toContain(SELF);
  });

  it('--dry-run overrides config.dryRun to true for the assembled daemon (full rehearsal: every intent lands SKIPPED_DRY_RUN)', async () => {
    const h = makeHarness();

    const exitCode = await runStart(['--dry-run'], h.io);

    expect(exitCode).toBe(0);
    expect((h.assembledConfigs[0] as { dryRun: boolean }).dryRun).toBe(true);
  });

  it('a fatal shell outcome maps to exit 1 and close still runs (daemon AND file sink)', async () => {
    const h = makeHarness({
      runShellImpl: async () => ({ reason: 'fatal', error: new Error('3 consecutive failures') }),
    });

    const exitCode = await runStart([], h.io);

    expect(exitCode).toBe(1);
    expect(h.closed).toBe(1);
    expect(h.sinkClosed).toBe(1);
  });

  it('tees every daemon log line into the file sink built at resolveDefaultLogDir: both routes receive the lines, close comes once after the shell exits (D-P5B13-4)', async () => {
    const h = makeHarness({
      runShellImpl: async (deps): Promise<ShellOutcome> => {
        deps.log('tee-probe-from-shell');
        return { reason: 'signal' };
      },
    });

    const exitCode = await runStart([], h.io);

    expect(exitCode).toBe(0);
    // The sink is built at the XDG-STATE default for the injected env/home.
    expect(h.sinkDirs).toEqual(['/fake-home/.local/state/agent-mail-bridge/logs']);
    // BOTH tee routes carry the shell's line AND start's own lifecycle
    // lines — the file surface receives exactly what console receives.
    for (const probe of ['tee-probe-from-shell', 'amb daemon starting', 'amb daemon stopped']) {
      expect(h.logs.some((line) => line.includes(probe))).toBe(true);
      expect(h.sinkWritten.some((line) => line.includes(probe))).toBe(true);
    }
    expect(h.sinkClosed).toBe(1);
  });

  it('config load failure: every error printed to stderr, exit 1, assemble never called', async () => {
    const h = makeHarness({ configJson: null });

    const exitCode = await runStart([], h.io);

    expect(exitCode).toBe(1);
    expect(h.assembledConfigs).toHaveLength(0);
    expect(h.writer.errLines.join('\n')).toContain('config');
  });

  it('assemble failure (e.g. missing credentials key): message to stderr SCRUBBED (home-dir paths become <home>), exit 1, shell never runs', async () => {
    const h = makeHarness({
      assembleImpl: () =>
        Promise.reject(
          new Error('credentials file /fake-home/.secrets/amb-test.env: missing AMB_IMAP_USER or AMB_TEST_IMAP_USER (fail closed)'),
        ),
    });

    const exitCode = await runStart([], h.io);

    expect(exitCode).toBe(1);
    expect(h.shellDeps).toHaveLength(0);
    const err = h.writer.errLines.join('\n');
    expect(err).toContain('missing AMB_IMAP_USER');
    // Review Minor-1: start's own lines obey the same scrub discipline as
    // every shell line sharing this stderr stream.
    expect(err).toContain('<home>/.secrets/amb-test.env');
    expect(err).not.toContain('/fake-home');
    // The file sink is only built once assembly succeeded — nothing to
    // close on this path.
    expect(h.sinkDirs).toEqual([]);
    expect(h.sinkClosed).toBe(0);
  });

  it('logs rejected project roots from the assembly index report — path in scrubbed (placeholder) form', async () => {
    const h = makeHarness({
      indexRejected: [{ path: '/fake-home/github-gone', reason: 'ROOT_NOT_FOUND' }],
    });

    await runStart([], h.io);

    const logs = h.logs.join('\n');
    expect(logs).toContain('project root rejected: <home>/github-gone (ROOT_NOT_FOUND)');
    expect(logs).not.toContain('/fake-home');
  });

  it('an unknown flag is rejected with usage on stderr, exit 2, nothing assembled', async () => {
    const h = makeHarness();

    const exitCode = await runStart(['--frobnicate'], h.io);

    expect(exitCode).toBe(2);
    expect(h.assembledConfigs).toHaveLength(0);
    expect(h.writer.errLines.join('\n')).toContain('usage');
  });
});

// Review Important-1 (batch 12): the machine-verifiable stdio guard for the
// production binding area. Both builders exercised here are PURE
// CONSTRUCTION with zero network: `readCredentialsFile` reads one local
// temp file; `buildTransport` binds `createImapReadTransport` over a lazy
// imapflow factory (ImapFlow is only ever constructed inside
// `factory.connect()` — module-mocked above anyway) and
// `buildDefaultSmtpSend`, whose `nodemailer.createTransport` opens no
// socket until a send is attempted (none is).
describe('buildProductionAssemblyBuilders — credentials stdio guard (red line 2, Important-1)', () => {
  const FIXTURE_USER = 'stdio-guard-user@example.com';
  const FIXTURE_PASS = 'Aa-Aa-Tok-7777';

  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amb-cli-start-guard-test-'));
    envPath = join(dir, 'amb-test.env');
    writeFileSync(
      envPath,
      `AMB_TEST_IMAP_USER=${FIXTURE_USER}\nAMB_TEST_IMAP_PASS=${FIXTURE_PASS}\n`,
      'utf8',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('readCredentials + buildTransport emit NOTHING carrying the credential values on any stdio channel (console.* AND raw process std streams)', async () => {
    // withStdioSpy (tests/helpers/stdioSpy.ts, extracted from this very
    // guard by D-P5B13-3) spies every sink `no-console` cannot police:
    // src/cli/** is exempt from the rule entirely, and raw
    // `process.std*.write` is invisible to it everywhere — exactly the
    // review probes' two survival channels. The spies are restored before
    // the assertions run, so a failure prints normally.
    const { result, captured } = await withStdioSpy(() => {
      const builders = buildProductionAssemblyBuilders();
      const credentials = builders.readCredentials(envPath);
      const transport = builders.buildTransport({
        selfAddress: 'bridge-user@example.com',
        credentials,
        registerOutbox: () => Promise.resolve(),
      });
      // Constructed, never driven: no method is invoked on it.
      return { credentials, transportShape: typeof transport.fetchSince };
    });

    expect(result.credentials).toEqual({ user: FIXTURE_USER, pass: FIXTURE_PASS });
    expect(result.transportShape).toBe('function');

    expect(captured).not.toContain(FIXTURE_USER);
    expect(captured).not.toContain(FIXTURE_PASS);
  });

  it('the imapflow client the production factory builds is constructed with logger: false and no debug switch (batch-5 red-line-2 precedent), creds confined to auth', async () => {
    imapflowCaptured.ctorOpts.length = 0;

    const factory = buildImapflowFactory({
      host: 'imap.gmail.com',
      port: 993,
      user: FIXTURE_USER,
      pass: FIXTURE_PASS,
    });
    await factory.connect(); // mocked ImapFlow — zero network (file header)

    expect(imapflowCaptured.ctorOpts).toHaveLength(1);
    const opts = imapflowCaptured.ctorOpts[0];
    expect(opts?.logger).toBe(false);
    expect(opts).not.toHaveProperty('debug');
    expect(opts?.secure).toBe(true);
    expect(opts?.auth).toEqual({ user: FIXTURE_USER, pass: FIXTURE_PASS });
  });
});

// D-P5B13-1: the production sleep binding is the ONE real-timer piece of the
// daemon loop, so its abort discipline is pinned here with fake timers —
// building the io is pure binding (no signal listeners are registered until
// onShutdownSignal is CALLED, which these tests never do).
describe('buildRealStartIo — interruptible production sleep (D-P5B13-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normal timeout path: resolves after ms and leaves ZERO timers behind (listener removed, nothing leaks)', async () => {
    const io = buildRealStartIo(makeWriter());
    const controller = new AbortController();
    let resolved = false;
    void io.sleep(30_000, controller.signal).then(() => {
      resolved = true;
    });

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abort during sleep: resolves immediately AND clears the pending timer (no hanging handle keeps the loop alive)', async () => {
    const io = buildRealStartIo(makeWriter());
    const controller = new AbortController();
    let resolved = false;
    void io.sleep(30_000, controller.signal).then(() => {
      resolved = true;
    });
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    await Promise.resolve(); // the settled promise's .then runs on the microtask queue

    expect(resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an ALREADY-aborted signal resolves immediately without ever creating a timer', async () => {
    const io = buildRealStartIo(makeWriter());
    const controller = new AbortController();
    controller.abort();

    await io.sleep(30_000, controller.signal);

    expect(vi.getTimerCount()).toBe(0);
  });
});
