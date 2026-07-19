/**
 * The scrubbed-log FILE surface (decision D-P5B13-4): a shift-rotating
 * append sink `amb start` tees every daemon log line into, next to the
 * console. `dist` of one line per poll round means synchronous fs is the
 * simple, crash-safe choice — every write lands before the next tick runs.
 *
 * RED LINE 2 boundary: this sink NEVER scrubs and never needs to — by
 * contract every line it receives already passed the `runDaemonShell`/
 * `runStart` scrub funnel (`scrubText` with the homedir needle), so the
 * file surface shares exactly the console surface's boundary. Nothing else
 * may write here.
 *
 * Rotation (v0.1 constants, YAGNI — not configurable): before an append
 * would push `amb.log` past `LOG_MAX_BYTES`, the generations shift —
 * `.2 → .3` (an existing `.3` is deleted first), `.1 → .2`,
 * `amb.log → .1` — and the write starts a fresh file. At most
 * `LOG_KEEP` rotated generations ever exist.
 *
 * FAIL-OPEN: logging is an auxiliary surface — the daemon must never die
 * for its log file. If the directory cannot be created or a write fails,
 * the sink degrades to a permanent no-op (console-only logging remains)
 * and reports the failure ONCE through `report` (production binding: a
 * scrubbed `console.error` line, `src/cli/start.ts`) — never a throw, and
 * never a per-line repeat.
 *
 * `LogFsOps` is fully injectable (the `SetupIo`/`DoctorIo` seam precedent)
 * so failure paths are testable without real-fs error rigging; the real-fs
 * default is bound in `buildDefaultLogFsOps` below.
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_FILE = 'amb.log';
/** Rotation threshold (v0.1 constant). */
export const LOG_MAX_BYTES = 1 * 1024 * 1024;
/** Rotated generations kept as `amb.log.1..3`; anything older is deleted. */
export const LOG_KEEP = 3;

export interface FileLogSink {
  /** Appends `line` newline-terminated; silently a no-op once closed or
   *  degraded (fail-open, module doc comment). */
  write(line: string): void;
  /** Idempotent; further writes become no-ops. */
  close(): void;
}

/** The synchronous fs family the sink needs, injectable for failure tests.
 *  Contracts mirror `node:fs` except `statSync`, which answers `null` for a
 *  missing path instead of throwing (the `DoctorIo['stat']` precedent). */
export interface LogFsOps {
  /** `fs.mkdirSync(path, { recursive: true })`-like. */
  mkdirSync(path: string): void;
  appendFileSync(path: string, data: string): void;
  statSync(path: string): { size: number } | null;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

export function buildDefaultLogFsOps(): LogFsOps {
  return {
    mkdirSync: (path) => {
      mkdirSync(path, { recursive: true });
    },
    appendFileSync: (path, data) => {
      appendFileSync(path, data, 'utf8');
    },
    statSync: (path) => {
      try {
        return { size: statSync(path).size };
      } catch {
        // ENOENT and any other stat failure both mean "treat as absent";
        // a truly broken directory will fail the append and degrade there.
        return null;
      }
    },
    renameSync: (from, to) => {
      renameSync(from, to);
    },
    unlinkSync: (path) => {
      unlinkSync(path);
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the sink for `dir` (created `mkdir -p`-style up front). `report`
 * receives the ONE degrade notice; its production binding scrubs before
 * printing (`src/cli/start.ts`) — the raw fs error message can carry an
 * expanded home-dir path, which must not reach the terminal unscrubbed
 * (red line 2's display surface).
 */
export function buildFileLogSink(
  dir: string,
  fs: LogFsOps = buildDefaultLogFsOps(),
  report: (line: string) => void = (line) => {
    // The src/cli/** no-console exemption surface (default binding only).
    console.error(line);
  },
): FileLogSink {
  const logPath = join(dir, LOG_FILE);
  let degraded = false;
  let closed = false;

  const degrade = (error: unknown): void => {
    if (!degraded) {
      degraded = true;
      report(`amb: file logging disabled, continuing console-only: ${describeError(error)}`);
    }
  };

  try {
    fs.mkdirSync(dir);
  } catch (error) {
    degrade(error);
  }

  const rotate = (): void => {
    const oldest = `${logPath}.${String(LOG_KEEP)}`;
    if (fs.statSync(oldest) !== null) {
      fs.unlinkSync(oldest);
    }
    for (let generation = LOG_KEEP - 1; generation >= 1; generation -= 1) {
      const from = `${logPath}.${String(generation)}`;
      if (fs.statSync(from) !== null) {
        fs.renameSync(from, `${logPath}.${String(generation + 1)}`);
      }
    }
    if (fs.statSync(logPath) !== null) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  };

  return {
    write(line) {
      if (closed || degraded) {
        return;
      }
      try {
        const entry = `${line}\n`;
        const size = fs.statSync(logPath)?.size ?? 0;
        if (size + Buffer.byteLength(entry, 'utf8') > LOG_MAX_BYTES) {
          rotate();
        }
        fs.appendFileSync(logPath, entry);
      } catch (error) {
        degrade(error);
      }
    },
    close() {
      closed = true;
    },
  };
}
