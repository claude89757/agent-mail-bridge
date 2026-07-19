/**
 * The long-running daemon shell (decision D-P5B12-3, plan
 * docs/superpowers/plans/2026-07-19-phase-5-batch12-daemon-shell.md): wraps
 * the batch-11 single-step ticks into the process that actually stays up.
 *
 * NORMATIVE startup + loop order (batch-11 handover #4):
 *
 *   recover → sweepStranded → loop [ paused? skip : (mailTick → orphanTick
 *   → sweepExpired) ] → sleep(pollIntervalMs) → repeat
 *
 * Pause (D-P5B12-2): `metaStore.getPaused()` is read from the database at
 * the top of EVERY round — the CLI writes the flag, there is no IPC, so a
 * pause/resume takes effect within one poll interval, never immediately. A
 * paused round skips all three ticks but still sleeps.
 *
 * Signals: `onShutdownSignal` (production binding: SIGINT/SIGTERM, wired in
 * `src/cli/start.ts`) sets a stop flag; the CURRENT tick round runs to
 * completion — an in-flight dispatch is never interrupted — and the shell
 * returns `{ reason: 'signal' }` without sleeping again. A second signal
 * does not accelerate anything (v0.1 simplification: there is no force-quit
 * path here; the operator's `kill -9` is the escalation). A signal arriving
 * during `sleep` is honored at the next loop top — worst case one poll
 * interval late, same latency bound as every other flag read.
 *
 * Tick error policy: a throw anywhere in a round ABORTS that round (the
 * remaining ticks are skipped — after an unexplained failure the cheapest
 * safe move is to retry the whole round in order), is logged (scrubbed, see
 * below) and counts one consecutive failure; `FATAL_AFTER` consecutive
 * failed rounds return `{ reason: 'fatal', error }` with the LAST error —
 * fail closed, the CLI maps it to a non-zero exit, and any restart policy
 * belongs to the operator's supervisor (launchd/systemd), not to this
 * process. One fully successful round resets the counter. A throw out of
 * the two STARTUP steps is immediately fatal: they are this shell's own
 * crash-recovery contract, and looping on a store that cannot even recover
 * would just spin.
 *
 * RED LINE 2 (logging): every line this shell emits passes through
 * `scrubText` with the injected `homeDir` needle before reaching
 * `deps.log` — tick failure messages inside reports are already scrubbed
 * by `ticks.ts`, and `scrubText` is idempotent, so double-scrubbing is
 * safe; error messages caught HERE are scrubbed here for the first time.
 * `log`'s production binding is `console.error` and lives in
 * `src/cli/start.ts` — the `src/cli/**` no-console exemption surface —
 * never in this file (house `no-console` applies here).
 *
 * No `console`, no zero-arg `new Date()`/`Date.now()`, no `process.*`:
 * time, signals and output all arrive through `ShellDeps`.
 */
import { scrubText } from '../domain/replyComposition.js';
import type { MetaStore } from '../store/metaStore.js';
import type { MailTickReport, OrphanTickReport } from './ticks.js';

/**
 * The five tick entry points, pre-bound by `assembleDaemon`
 * (`./assembly.ts`) so the shell never sees store/transport/driver wiring —
 * it only sequences.
 */
export interface ShellTicks {
  recover(): { recovered: readonly string[] };
  sweepStranded(): { swept: readonly string[] };
  mailTick(): Promise<MailTickReport>;
  orphanTick(): Promise<OrphanTickReport>;
  sweepExpired(): { expired: readonly number[] };
}

export interface ShellDeps {
  ticks: ShellTicks;
  /** Only the pause flag is read here — narrowed so tests can hand in a
   *  two-line fake without a database. */
  metaStore: Pick<MetaStore, 'getPaused'>;
  /** Injected `os.homedir()` (the `MailTickDeps.homeDir` precedent): the
   *  scrub needle for every log line this shell emits (red line 2). */
  homeDir: string;
  /** Production binding: `setTimeout` promise (`src/cli/start.ts`). */
  sleep(ms: number): Promise<void>;
  /** Registers a shutdown handler, returns the unsubscribe. Production
   *  binding: SIGINT/SIGTERM listeners (`src/cli/start.ts`). */
  onShutdownSignal(fn: () => void): () => void;
  /** Receives ALREADY-SCRUBBED text (this shell scrubs before calling).
   *  Production binding: `console.error` in `src/cli/start.ts`. */
  log(line: string): void;
  pollIntervalMs: number;
}

export interface ShellOutcome {
  reason: 'signal' | 'fatal';
  /** Present for `fatal`: the LAST round's error (or the startup error). */
  error?: unknown;
}

/** Consecutive fully-failed rounds that end the process (D-P5B12-3). */
export const FATAL_AFTER = 3;

/** Duplicated per-file by convention (ticks.ts, dispatch.ts, ...). */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the daemon until a shutdown signal (⇒ `{ reason: 'signal' }`, the
 * CLI exits 0) or `FATAL_AFTER` consecutive failed rounds (⇒
 * `{ reason: 'fatal', error }`, the CLI exits 1). Never throws for a tick
 * failure; see the module doc comment for the full policy.
 */
export async function runDaemonShell(deps: ShellDeps): Promise<ShellOutcome> {
  const emit = (line: string): void => {
    deps.log(scrubText(line, { worktreePath: null, homeDir: deps.homeDir }));
  };

  let stopping = false;
  const unsubscribe = deps.onShutdownSignal(() => {
    stopping = true;
  });

  try {
    // Startup (normative order; throw here ⇒ immediately fatal, module doc).
    try {
      const { recovered } = deps.ticks.recover();
      const { swept } = deps.ticks.sweepStranded();
      emit(
        `startup: recovered ${String(recovered.length)} interrupted intent(s), ` +
          `swept ${String(swept.length)} stranded SENDING row(s) to UNCERTAIN`,
      );
    } catch (error) {
      emit(`startup failed (fatal): ${describeError(error)}`);
      return { reason: 'fatal', error };
    }

    let consecutiveFailures = 0;
    for (;;) {
      if (stopping) {
        return { reason: 'signal' };
      }

      if (deps.metaStore.getPaused()) {
        emit('paused — skipping ticks this round (resume takes effect within one poll interval)');
      } else {
        try {
          const mail = await deps.ticks.mailTick();
          const orphan = await deps.ticks.orphanTick();
          const { expired } = deps.ticks.sweepExpired();
          consecutiveFailures = 0;
          emit(
            `round ok: fetched=${String(mail.fetched)} dispatched=${String(mail.dispatched)} ` +
              `failures=${String(mail.failures.length)} orphanScanned=${String(orphan.scanned)} ` +
              `expired=${String(expired.length)}`,
          );
          for (const failure of mail.failures) {
            // failure.message is already scrubbed by ticks.ts; emit scrubs
            // again (idempotent) so THIS module's guarantee stands alone.
            emit(`mail tick failure uid=${String(failure.uid)} stage=${failure.stage}: ${failure.message}`);
          }
        } catch (error) {
          consecutiveFailures += 1;
          emit(
            `tick round failed (${String(consecutiveFailures)}/${String(FATAL_AFTER)}): ` +
              describeError(error),
          );
          if (consecutiveFailures >= FATAL_AFTER) {
            emit(`${String(FATAL_AFTER)} consecutive failed rounds — exiting (fatal)`);
            return { reason: 'fatal', error };
          }
        }
      }

      if (stopping) {
        // Signal arrived during this round: the round completed, exit
        // WITHOUT sleeping (graceful-stop contract, module doc comment).
        return { reason: 'signal' };
      }
      await deps.sleep(deps.pollIntervalMs);
    }
  } finally {
    unsubscribe();
  }
}
