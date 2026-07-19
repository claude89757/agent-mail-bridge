import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildFileLogSink,
  LOG_FILE,
  LOG_KEEP,
  LOG_MAX_BYTES,
} from '../../src/cli/logSink.js';
import type { LogFsOps } from '../../src/cli/logSink.js';

// Guards D-P5B13-4 (the scrubbed-log FILE surface): append semantics,
// shift-style rotation with the LOG_KEEP boundary, the fail-open degrade
// (console-only, reported ONCE), and close idempotence. Real-fs cases run
// against a mkdtemp tree (the cli-setup precedent — the real HOME is never
// touched); failure injection uses a fake `LogFsOps`.
//
// RED LINE 2 note: the sink never scrubs — by contract every line arriving
// here ALREADY passed the runDaemonShell/runStart scrub funnel, so the file
// surface shares the console surface's boundary. Fixtures below therefore
// need no secret material at all.

let dir: string;
let logDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amb-log-sink-test-'));
  logDir = join(dir, 'logs');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A line of exactly `size` bytes (marker + padding) so rotation thresholds
 *  can be crossed deterministically with a handful of writes. */
function lineOfSize(marker: string, size: number): string {
  return marker + 'x'.repeat(size - marker.length);
}

/** Fake `LogFsOps` that records calls; individual ops overridable to throw. */
function makeFakeFs(overrides: Partial<LogFsOps> = {}): LogFsOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mkdirSync: (path) => {
      calls.push(`mkdir(${path})`);
    },
    appendFileSync: (path) => {
      calls.push(`append(${path})`);
    },
    statSync: (path) => {
      calls.push(`stat(${path})`);
      return null;
    },
    renameSync: (from, to) => {
      calls.push(`rename(${from} -> ${to})`);
    },
    unlinkSync: (path) => {
      calls.push(`unlink(${path})`);
    },
    ...overrides,
  };
}

describe('buildFileLogSink (D-P5B13-4)', () => {
  it('pins the v0.1 constants: amb.log, 1 MiB threshold, 3 rotated generations', () => {
    expect(LOG_FILE).toBe('amb.log');
    expect(LOG_MAX_BYTES).toBe(1024 * 1024);
    expect(LOG_KEEP).toBe(3);
  });

  it('creates the directory and appends each line newline-terminated (real fs)', () => {
    const sink = buildFileLogSink(logDir);

    sink.write('first line');
    sink.write('second line');
    sink.close();

    expect(readFileSync(join(logDir, LOG_FILE), 'utf8')).toBe('first line\nsecond line\n');
  });

  it('rotates shift-style across the threshold and DELETES beyond LOG_KEEP: after five oversized writes .1...3 hold the three previous generations and the oldest is gone (real fs)', () => {
    const sink = buildFileLogSink(logDir);
    const size = 600_000; // two lines cross the 1 MiB threshold
    const markers = ['gen-w1:', 'gen-w2:', 'gen-w3:', 'gen-w4:', 'gen-w5:'];
    for (const marker of markers) {
      sink.write(lineOfSize(marker, size));
    }
    sink.close();

    const logPath = join(logDir, LOG_FILE);
    const readMarker = (path: string): string => readFileSync(path, 'utf8').slice(0, 7);

    expect(readMarker(logPath)).toBe('gen-w5:');
    expect(readMarker(`${logPath}.1`)).toBe('gen-w4:');
    expect(readMarker(`${logPath}.2`)).toBe('gen-w3:');
    expect(readMarker(`${logPath}.3`)).toBe('gen-w2:');
    // The keep boundary: w1's generation was unlinked, and no `.4` ever
    // comes into existence.
    expect(existsSync(`${logPath}.4`)).toBe(false);
  });

  it('an entry landing EXACTLY on LOG_MAX_BYTES does not rotate — only going past it does (batch-13 review Minor-2, the `>` boundary)', () => {
    const sink = buildFileLogSink(logDir);
    const logPath = join(logDir, LOG_FILE);

    // entry (line + '\n') == LOG_MAX_BYTES exactly: `size + entry > MAX`
    // is false, so the write appends in place.
    sink.write(lineOfSize('exact:', LOG_MAX_BYTES - 1));
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(readFileSync(logPath, 'utf8')).toHaveLength(LOG_MAX_BYTES);

    // One more byte-carrying line goes PAST the threshold ⇒ now it rotates.
    sink.write('next');
    sink.close();
    expect(readFileSync(`${logPath}.1`, 'utf8').slice(0, 6)).toBe('exact:');
    expect(readFileSync(logPath, 'utf8')).toBe('next\n');
  });

  it('a single line larger than LOG_MAX_BYTES still lands (rotation of an empty state is a no-op, the oversized entry is appended whole)', () => {
    const sink = buildFileLogSink(logDir);
    const logPath = join(logDir, LOG_FILE);

    sink.write(lineOfSize('huge:', LOG_MAX_BYTES + 100));
    expect(readFileSync(logPath, 'utf8').slice(0, 5)).toBe('huge:');
    expect(existsSync(`${logPath}.1`)).toBe(false);

    // The NEXT write finds the oversized file past the threshold and
    // shifts it out before appending.
    sink.write('after');
    sink.close();
    expect(readFileSync(`${logPath}.1`, 'utf8').slice(0, 5)).toBe('huge:');
    expect(readFileSync(logPath, 'utf8')).toBe('after\n');
  });

  it('a rename failure INSIDE rotation degrades exactly like an append failure: one report, then permanent no-op (batch-13 review Minor-2)', () => {
    const reports: string[] = [];
    const logPath = join(logDir, LOG_FILE);
    const fake = makeFakeFs({
      // The current log sits at the threshold so any write triggers
      // rotation; every generation probe answers "absent".
      statSync: (path) => (path === logPath ? { size: LOG_MAX_BYTES } : null),
      renameSync: () => {
        throw new Error('EACCES: rename denied');
      },
    });
    const sink = buildFileLogSink(logDir, fake, (line) => {
      reports.push(line);
    });

    sink.write('first');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('file logging disabled');

    const callsAfterDegrade = fake.calls.length;
    sink.write('second');
    sink.write('third');
    expect(reports).toHaveLength(1);
    expect(fake.calls.length).toBe(callsAfterDegrade);
  });

  it('a write failure degrades to console-only and reports through the injected reporter EXACTLY ONCE (fail-open: the daemon never dies for its log file)', () => {
    const reports: string[] = [];
    const fs = makeFakeFs({
      appendFileSync: () => {
        throw new Error('EDQUOT: disk quota exceeded');
      },
    });
    const sink = buildFileLogSink(logDir, fs, (line) => {
      reports.push(line);
    });

    expect(() => {
      sink.write('line 1');
      sink.write('line 2');
      sink.write('line 3');
    }).not.toThrow();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('EDQUOT');
    // Degraded means degraded: only the FIRST write ever reached the
    // filesystem (one pre-append size stat); the later two were no-ops
    // instead of failing (and reporting) per line.
    expect(fs.calls.filter((c) => c.startsWith('stat'))).toHaveLength(1);
  });

  it('a directory-creation failure at build time degrades immediately: one report, and write() never touches the filesystem', () => {
    const reports: string[] = [];
    const fs = makeFakeFs({
      mkdirSync: () => {
        throw new Error('EACCES: permission denied');
      },
    });

    const sink = buildFileLogSink(logDir, fs, (line) => {
      reports.push(line);
    });
    sink.write('never lands');
    sink.write('never lands either');

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('EACCES');
    expect(fs.calls.filter((c) => !c.startsWith('mkdir'))).toEqual([]);
  });

  it('the default failure reporter is console.error (the src/cli/** no-console surface)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const fs = makeFakeFs({
        mkdirSync: () => {
          throw new Error('EROFS: read-only file system');
        },
      });
      buildFileLogSink(logDir, fs);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('EROFS');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('close is idempotent and a write after close is a no-op (real fs)', () => {
    const sink = buildFileLogSink(logDir);
    sink.write('kept');

    sink.close();
    expect(() => {
      sink.close();
    }).not.toThrow();
    sink.write('dropped');

    expect(readFileSync(join(logDir, LOG_FILE), 'utf8')).toBe('kept\n');
  });
});
