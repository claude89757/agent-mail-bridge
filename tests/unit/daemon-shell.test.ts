import { describe, expect, it } from 'vitest';

import { runDaemonShell } from '../../src/daemon/shell.js';
import type { ShellDeps } from '../../src/daemon/shell.js';
import type { MailTickReport, OrphanTickReport } from '../../src/daemon/ticks.js';

// Guards D-P5B12-3 (the daemon shell: normative startup order, poll loop,
// pause skip, graceful signal stop, consecutive-failure fatal policy,
// scrubbed logging) from
// docs/superpowers/plans/2026-07-19-phase-5-batch12-daemon-shell.md.
// Everything is injected: scripted tick fakes, a recording log, an
// immediately-resolving sleep, and a hand-held signal trigger — ZERO real
// timers, signals, connections or codex (red lines: the whole batch runs
// against fakes).
//
// Fixture discipline (public repo): synthetic /tmp/fixtures/* paths,
// placeholder addresses, low-entropy token values only.

const HOME = '/tmp/fixtures/home-x';

function emptyMailReport(): MailTickReport {
  return {
    fetched: 0,
    outcomes: { duplicate: 0, echo: 0, rejected: 0, 'queued-window': 0, ready: 0 },
    dispatched: 0,
    replies: [],
    failures: [],
  };
}

function emptyOrphanReport(): OrphanTickReport {
  return { scanned: 0, dispatched: 0, replies: [], finalized: [], skipped: [] };
}

interface HarnessOptions {
  /** Behavior of the Nth (1-based) mailTick call; throw inside to fail that
   *  round. Default: empty report. */
  mailTickImpl?: (n: number) => MailTickReport;
  /** Behavior of the Nth (1-based) recover call. Default: empty result. */
  recoverImpl?: (n: number) => { recovered: readonly string[] };
  /** Paused answer for the Nth (1-based) round. Default: false. */
  pausedImpl?: (round: number) => boolean;
  /** Invoked AFTER each call is recorded — tests fire the signal from here
   *  at exact moments (`name` is the recorded call name, `n` its 1-based
   *  per-name count). */
  onCall?: (name: string, n: number) => void;
  pollIntervalMs?: number;
}

interface Harness {
  deps: ShellDeps;
  /** Flat call log: 'recover' | 'sweepStranded' | 'getPaused' | 'mailTick'
   *  | 'orphanTick' | 'sweepExpired' | 'sleep(<ms>)'. */
  calls: string[];
  logs: string[];
  /** Fires the handler registered via onShutdownSignal. */
  signal: () => void;
  unsubscribed: () => boolean;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  const counts = new Map<string, number>();
  let handler: (() => void) | null = null;
  let unsubscribed = false;

  const record = (name: string, entry: string = name): number => {
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    calls.push(entry);
    options.onCall?.(name, n);
    return n;
  };

  const deps: ShellDeps = {
    ticks: {
      recover: () => {
        const n = record('recover');
        return options.recoverImpl?.(n) ?? { recovered: [] };
      },
      sweepStranded: () => {
        record('sweepStranded');
        return { swept: [] };
      },
      mailTick: async (): Promise<MailTickReport> => {
        const n = record('mailTick');
        return options.mailTickImpl?.(n) ?? emptyMailReport();
      },
      orphanTick: async (): Promise<OrphanTickReport> => {
        record('orphanTick');
        return emptyOrphanReport();
      },
      sweepExpired: () => {
        record('sweepExpired');
        return { expired: [] };
      },
    },
    metaStore: {
      getPaused: () => {
        const n = record('getPaused');
        return options.pausedImpl?.(n) ?? false;
      },
    },
    homeDir: HOME,
    sleep: async (ms: number): Promise<void> => {
      record('sleep', `sleep(${String(ms)})`);
    },
    onShutdownSignal: (fn) => {
      handler = fn;
      return () => {
        unsubscribed = true;
      };
    },
    log: (line) => logs.push(line),
    pollIntervalMs: options.pollIntervalMs ?? 30_000,
  };

  return {
    deps,
    calls,
    logs,
    signal: () => {
      if (handler === null) {
        throw new Error('test bug: signal fired before runDaemonShell registered its handler');
      }
      handler();
    },
    unsubscribed: () => unsubscribed,
  };
}

describe('runDaemonShell (D-P5B12-3)', () => {
  it('normative order: recover → sweepStranded ONCE at startup, then rounds of getPaused → mailTick → orphanTick → sweepExpired → sleep(pollIntervalMs)', async () => {
    const h: Harness = makeHarness({
      pollIntervalMs: 12_345,
      onCall: (name, n) => {
        if (name === 'sleep' && n === 2) {
          h.signal();
        }
      },
    });

    const outcome = await runDaemonShell(h.deps);

    expect(outcome).toEqual({ reason: 'signal' });
    expect(h.calls).toEqual([
      'recover',
      'sweepStranded',
      'getPaused',
      'mailTick',
      'orphanTick',
      'sweepExpired',
      'sleep(12345)',
      'getPaused',
      'mailTick',
      'orphanTick',
      'sweepExpired',
      'sleep(12345)',
    ]);
  });

  it('paused round: reads the flag from the store EVERY round, skips all three ticks but still sleeps; an un-paused later round runs again (effect delay = one poll interval)', async () => {
    const h: Harness = makeHarness({
      pausedImpl: (round) => round === 1,
      onCall: (name, n) => {
        if (name === 'sleep' && n === 2) {
          h.signal();
        }
      },
    });

    const outcome = await runDaemonShell(h.deps);

    expect(outcome).toEqual({ reason: 'signal' });
    expect(h.calls).toEqual([
      'recover',
      'sweepStranded',
      'getPaused',
      'sleep(30000)',
      'getPaused',
      'mailTick',
      'orphanTick',
      'sweepExpired',
      'sleep(30000)',
    ]);
    expect(h.logs.some((line) => line.includes('paused'))).toBe(true);
  });

  it('signal mid-tick stops gracefully: the CURRENT round completes (orphanTick + sweepExpired still run), then exits without sleeping; handler unsubscribed', async () => {
    const h: Harness = makeHarness({
      onCall: (name, n) => {
        if (name === 'mailTick' && n === 1) {
          h.signal();
        }
      },
    });

    const outcome = await runDaemonShell(h.deps);

    expect(outcome).toEqual({ reason: 'signal' });
    expect(h.calls).toEqual([
      'recover',
      'sweepStranded',
      'getPaused',
      'mailTick',
      'orphanTick',
      'sweepExpired',
    ]);
    expect(h.unsubscribed()).toBe(true);
  });

  it('three consecutive failed rounds are fatal: the round aborts at the throwing tick, sleeps between failures, and the third failure returns { reason: fatal, error } without sleeping again', async () => {
    const h = makeHarness({
      mailTickImpl: (n) => {
        throw new Error(`boom ${String(n)}`);
      },
    });

    const outcome = await runDaemonShell(h.deps);

    expect(outcome.reason).toBe('fatal');
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toBe('boom 3');
    expect(h.calls).toEqual([
      'recover',
      'sweepStranded',
      'getPaused',
      'mailTick',
      'sleep(30000)',
      'getPaused',
      'mailTick',
      'sleep(30000)',
      'getPaused',
      'mailTick',
    ]);
    expect(h.unsubscribed()).toBe(true);
  });

  it('one successful round resets the consecutive-failure counter: fail-fail-ok twice over never reaches fatal', async () => {
    const h: Harness = makeHarness({
      mailTickImpl: (n) => {
        if (n % 3 === 0) {
          return emptyMailReport();
        }
        throw new Error(`transient ${String(n)}`);
      },
      onCall: (name, n) => {
        if (name === 'sleep' && n === 6) {
          h.signal();
        }
      },
    });

    const outcome = await runDaemonShell(h.deps);

    expect(outcome).toEqual({ reason: 'signal' });
    expect(h.calls.filter((c) => c === 'mailTick')).toHaveLength(6);
    // The two successful rounds (calls 3 and 6) ran their full tick set.
    expect(h.calls.filter((c) => c === 'orphanTick')).toHaveLength(2);
  });

  it('tick errors are logged THROUGH scrubText: home-dir paths become <home> and keyword-labelled secrets are masked, raw values never reach the log', async () => {
    const h: Harness = makeHarness({
      mailTickImpl: () => {
        throw new Error(`ENOENT reading ${HOME}/.secrets/amb-test.env token=Aa-Aa-Tok-0001`);
      },
      onCall: (name, n) => {
        if (name === 'sleep' && n === 1) {
          h.signal();
        }
      },
    });

    await runDaemonShell(h.deps);

    const joined = h.logs.join('\n');
    expect(joined).toContain('<home>/.secrets/amb-test.env');
    expect(joined).toContain('token=<redacted>');
    expect(joined).not.toContain(HOME);
    expect(joined).not.toContain('Aa-Aa-Tok-0001');
  });

  it('a startup-step throw (recover) is fatal immediately: no tick round ever starts, the error is logged scrubbed and returned', async () => {
    const h = makeHarness({
      recoverImpl: () => {
        throw new Error(`cannot read intents under ${HOME}/.local/share`);
      },
    });

    const outcome = await runDaemonShell(h.deps);

    expect(outcome.reason).toBe('fatal');
    expect((outcome.error as Error).message).toContain('cannot read intents');
    expect(h.calls).toEqual(['recover']);
    expect(h.logs.join('\n')).toContain('<home>/.local/share');
    expect(h.logs.join('\n')).not.toContain(HOME);
    expect(h.unsubscribed()).toBe(true);
  });
});
