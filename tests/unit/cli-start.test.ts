import { describe, expect, it } from 'vitest';

import type { RejectedDir } from '../../src/application/projectIndex.js';
import type { Writer } from '../../src/cli/dispatch.js';
import { resolveConfigPath } from '../../src/cli/paths.js';
import { runStart } from '../../src/cli/start.js';
import type { StartIo } from '../../src/cli/start.js';
import type { AssembledDaemon } from '../../src/daemon/assembly.js';
import type { ShellDeps, ShellOutcome } from '../../src/daemon/shell.js';

// Guards D-P5B12-5's `amb start` half: loadConfig → assembleDaemon →
// runDaemonShell wiring, the --dry-run config override, exit-code mapping
// (signal=0 / fatal=1), close-always semantics, and the red-line-2 display
// surface (selfAddress and credential material never appear in any output
// or log line). `assemble`/`runShell` are INJECTED fakes — the real
// assembly/shell have their own suites; this file only pins the CLI glue,
// per the cli-doctor/cli-setup io-injection precedent.

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
    },
    writer,
    logs,
    assembledConfigs,
    shellDeps,
    closed: 0,
    fakeTicks,
    fakeMetaStore,
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
    expect(deps?.log).toBe(h.io.log);
    expect(deps?.pollIntervalMs).toBe(45_000);

    expect(h.closed).toBe(1);

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

  it('a fatal shell outcome maps to exit 1 and close still runs', async () => {
    const h = makeHarness({
      runShellImpl: async () => ({ reason: 'fatal', error: new Error('3 consecutive failures') }),
    });

    const exitCode = await runStart([], h.io);

    expect(exitCode).toBe(1);
    expect(h.closed).toBe(1);
  });

  it('config load failure: every error printed to stderr, exit 1, assemble never called', async () => {
    const h = makeHarness({ configJson: null });

    const exitCode = await runStart([], h.io);

    expect(exitCode).toBe(1);
    expect(h.assembledConfigs).toHaveLength(0);
    expect(h.writer.errLines.join('\n')).toContain('config');
  });

  it('assemble failure (e.g. missing credentials key): message to stderr, exit 1, shell never runs', async () => {
    const h = makeHarness({
      assembleImpl: () =>
        Promise.reject(
          new Error('credentials file /fake-home/.secrets/amb-test.env: missing AMB_IMAP_USER or AMB_TEST_IMAP_USER (fail closed)'),
        ),
    });

    const exitCode = await runStart([], h.io);

    expect(exitCode).toBe(1);
    expect(h.shellDeps).toHaveLength(0);
    expect(h.writer.errLines.join('\n')).toContain('missing AMB_IMAP_USER');
  });

  it('logs rejected project roots from the assembly index report', async () => {
    const h = makeHarness({
      indexRejected: [{ path: '/fake-home/github-gone', reason: 'ROOT_NOT_FOUND' }],
    });

    await runStart([], h.io);

    expect(h.logs.join('\n')).toContain('/fake-home/github-gone');
    expect(h.logs.join('\n')).toContain('ROOT_NOT_FOUND');
  });

  it('an unknown flag is rejected with usage on stderr, exit 2, nothing assembled', async () => {
    const h = makeHarness();

    const exitCode = await runStart(['--frobnicate'], h.io);

    expect(exitCode).toBe(2);
    expect(h.assembledConfigs).toHaveLength(0);
    expect(h.writer.errLines.join('\n')).toContain('usage');
  });
});
