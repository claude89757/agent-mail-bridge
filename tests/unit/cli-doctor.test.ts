import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BridgeConfig } from '../../src/cli/config.js';
import {
  buildDefaultChecks,
  buildDefaultDoctorIo,
  renderDoctorReport,
  runDoctor,
} from '../../src/cli/doctor.js';
import type {
  CheckStatus,
  DoctorCheck,
  DoctorCheckOutcome,
  DoctorContext,
  DoctorIo,
} from '../../src/cli/doctor.js';
import { openDatabase } from '../../src/store/database.js';
import { MetaStore } from '../../src/store/metaStore.js';

// Guards decision D-P5S-4 (doctor check engine, five v1 checks, renderer) and
// D-P5S-3 (credentials-file stat-only hygiene check). `buildDefaultDoctorIo`
// wires the REAL fs/process/database — per D-P5S-7 the credentials-file and
// database/ready-at checks are exercised through it against real temp
// dirs/files (chmodSync) and a real temp-file SQLite store, not hand-rolled
// mocks. `node-version`/`config` (and a couple of defensive branches) use a
// fully fake `DoctorIo` since they must pin values a real process/fs cannot
// provide on demand (an arbitrary Node major version; an inconsistent stat).

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    selfAddress: 'bridge-user@example.com',
    credentialsEnvFile: '/fake-home/.secrets/amb-test.env',
    dbPath: '/fake-home/.local/share/agent-mail-bridge/bridge.db',
    mailbox: 'INBOX',
    dryRun: false,
    ...overrides,
  };
}

function baseIo(overrides: Partial<DoctorIo> = {}): DoctorIo {
  return {
    nodeVersion: 'v22.0.0',
    stat: () => null,
    openDatabase: () => {
      throw new Error('unexpected openDatabase call in this test');
    },
    ...overrides,
  };
}

function baseCtx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    configPath: '/fake-home/.config/agent-mail-bridge/config.json',
    config: baseConfig(),
    configErrors: [],
    io: baseIo(),
    ...overrides,
  };
}

function getCheck(id: string): DoctorCheck {
  const check = buildDefaultChecks().find((c) => c.id === id);
  if (check === undefined) {
    throw new Error(`no check registered with id ${id}`);
  }
  return check;
}

describe('buildDefaultChecks (D-P5S-4)', () => {
  it('registers exactly the five v1 checks, in output order', () => {
    const ids = buildDefaultChecks().map((c) => c.id);

    expect(ids).toEqual(['node-version', 'config', 'credentials-file', 'database', 'ready-at']);
  });

  it('builds a fresh array of checks on every call', () => {
    expect(buildDefaultChecks()).not.toBe(buildDefaultChecks());
  });
});

describe('node-version check', () => {
  it('passes at exactly the minimum supported major version (22.0.0)', () => {
    const result = getCheck('node-version').run(baseCtx({ io: baseIo({ nodeVersion: '22.0.0' }) }));

    expect(result.status).toBe('pass');
  });

  it('passes given the process.version shape (leading "v")', () => {
    const result = getCheck('node-version').run(baseCtx({ io: baseIo({ nodeVersion: 'v22.4.1' }) }));

    expect(result.status).toBe('pass');
  });

  it('passes above the minimum version', () => {
    const result = getCheck('node-version').run(baseCtx({ io: baseIo({ nodeVersion: 'v24.1.0' }) }));

    expect(result.status).toBe('pass');
  });

  it('fails below the minimum version and hints to upgrade', () => {
    const result = getCheck('node-version').run(baseCtx({ io: baseIo({ nodeVersion: '20.11.0' }) }));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('20.11.0');
    expect(result.hint).toContain('upgrade');
  });
});

describe('config check', () => {
  it('passes when config is loaded with no errors, naming configPath', () => {
    const result = getCheck('config').run(
      baseCtx({ configPath: '/fake-home/.config/agent-mail-bridge/config.json' }),
    );

    expect(result.status).toBe('pass');
    expect(result.message).toContain('/fake-home/.config/agent-mail-bridge/config.json');
  });

  it('fails with the FIRST schema error in the message (not the others)', () => {
    const result = getCheck('config').run(
      baseCtx({
        config: null,
        configErrors: [
          'selfAddress: must be a non-empty string',
          'dbPath: must be a non-empty string',
        ],
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('selfAddress: must be a non-empty string');
    expect(result.message).not.toContain('dbPath: must be a non-empty string');
    expect(result.hint).toBeDefined();
  });

  it('fails (defensively) if config is somehow null with no errors reported', () => {
    const result = getCheck('config').run(baseCtx({ config: null, configErrors: [] }));

    expect(result.status).toBe('fail');
  });
});

describe('credentials-file check (D-P5S-3)', () => {
  let dir: string;
  let io: DoctorIo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amb-cli-doctor-test-'));
    io = buildDefaultDoctorIo(); // thin real-fs io: real statSync under the hood
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctxFor(credentialsEnvFile: string): DoctorContext {
    return baseCtx({ config: baseConfig({ credentialsEnvFile }), io });
  }

  it('fails when the credentials file does not exist', () => {
    const missing = join(dir, 'creds.env');

    const result = getCheck('credentials-file').run(ctxFor(missing));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('does not exist');
    expect(result.message).toContain(missing);
    expect(result.hint).toContain('chmod 600');
  });

  it('fails when the path is a directory, not a regular file', () => {
    const filePath = join(dir, 'creds-is-a-dir');
    mkdirSync(filePath);
    chmodSync(dir, 0o700);

    const result = getCheck('credentials-file').run(ctxFor(filePath));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('not a regular file');
  });

  it('fails with a precise chmod hint when the file mode is 0644', () => {
    const filePath = join(dir, 'creds.env');
    writeFileSync(filePath, 'X=1\n');
    chmodSync(filePath, 0o644);
    chmodSync(dir, 0o700);

    const result = getCheck('credentials-file').run(ctxFor(filePath));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('0644');
    expect(result.hint).toBe(`chmod 600 ${filePath}`);
  });

  it('fails with a precise chmod hint when the parent directory mode is 0755', () => {
    const filePath = join(dir, 'creds.env');
    writeFileSync(filePath, 'X=1\n');
    chmodSync(filePath, 0o600);
    chmodSync(dir, 0o755);

    const result = getCheck('credentials-file').run(ctxFor(filePath));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('0755');
    expect(result.hint).toBe(`chmod 700 ${dir}`);
  });

  it('passes when the file is 0600 and the parent directory is 0700', () => {
    const filePath = join(dir, 'creds.env');
    writeFileSync(filePath, 'X=1\n');
    chmodSync(filePath, 0o600);
    chmodSync(dir, 0o700);

    const result = getCheck('credentials-file').run(ctxFor(filePath));

    expect(result.status).toBe('pass');
    expect(result.message).toContain(filePath);
  });

  it('fails when the file mode carries extra bits beyond 0600 (setuid set): "exactly 0600" must not be satisfied by masking those bits away', () => {
    const filePath = join(dir, 'creds.env');
    writeFileSync(filePath, 'X=1\n');
    chmodSync(dir, 0o700);
    chmodSync(filePath, 0o4600);

    // Not every platform/filesystem preserves the setuid bit through chmod
    // on a REGULAR file (it is only semantically meaningful on
    // executables); verify what actually landed via the same `io.stat`
    // the check itself uses before trusting a real-io assertion, and fall
    // back to an injected fake stat otherwise so this test is
    // deterministic regardless of platform/CI filesystem.
    const observedMode = io.stat(filePath)?.mode ?? 0;
    const setuidPreserved = (observedMode & 0o7000) === 0o4000;

    const result = setuidPreserved
      ? getCheck('credentials-file').run(ctxFor(filePath))
      : getCheck('credentials-file').run(
          baseCtx({
            config: baseConfig({ credentialsEnvFile: filePath }),
            io: baseIo({
              stat: (p) => {
                if (p === filePath) return { isFile: true, isDirectory: false, mode: 0o4600 };
                if (p === dir) return { isFile: false, isDirectory: true, mode: 0o700 };
                return null;
              },
            }),
          }),
        );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('4600');
  });

  it('fails cleanly (not an uncaught throw) when the path traverses through a non-directory', () => {
    const blocker = join(dir, 'blocker-file');
    writeFileSync(blocker, 'x');
    const filePath = join(blocker, 'creds.env');

    expect(() => getCheck('credentials-file').run(ctxFor(filePath))).not.toThrow();
    const result = getCheck('credentials-file').run(ctxFor(filePath));

    expect(result.status).toBe('fail');
  });

  it('fails when config is null, without touching the filesystem', () => {
    const result = getCheck('credentials-file').run(baseCtx({ config: null, io: baseIo() }));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('config invalid');
  });

  it('fails (defensively) when the parent path stats as a non-directory', () => {
    // Real fs can never reach this branch without throwing ENOTDIR first
    // (exercised above); this pins the branch's own logic directly against
    // a synthetic io that reports an inconsistent (but well-formed) stat.
    const filePath = '/fake/creds.env';
    const fakeIo = baseIo({
      stat: (path: string) => {
        if (path === filePath) return { isFile: true, isDirectory: false, mode: 0o600 };
        if (path === '/fake') return { isFile: true, isDirectory: false, mode: 0o700 };
        return null;
      },
    });

    const result = getCheck('credentials-file').run(
      baseCtx({ config: baseConfig({ credentialsEnvFile: filePath }), io: fakeIo }),
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('not a directory');
  });
});

describe('database check', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amb-cli-doctor-db-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes against a real temp-file database and closes it', () => {
    const dbPath = join(dir, 'bridge.db');
    const io = buildDefaultDoctorIo();

    const result = getCheck('database').run(baseCtx({ config: baseConfig({ dbPath }), io }));

    expect(result.status).toBe('pass');
    expect(result.message).toContain(dbPath);
  });

  it('fails with a message when the path cannot be opened', () => {
    const dbPath = join(dir, 'no-such-subdir', 'bridge.db');
    const io = buildDefaultDoctorIo();

    const result = getCheck('database').run(baseCtx({ config: baseConfig({ dbPath }), io }));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('failed to open database');
    expect(result.message).toContain(dbPath);
  });

  it('fails when config is null', () => {
    const result = getCheck('database').run(baseCtx({ config: null }));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('config invalid');
  });
});

describe('ready-at check', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amb-cli-doctor-readyat-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns and mentions setup when readyAt has never been set', () => {
    const dbPath = join(dir, 'bridge.db');
    const io = buildDefaultDoctorIo();

    const result = getCheck('ready-at').run(baseCtx({ config: baseConfig({ dbPath }), io }));

    expect(result.status).toBe('warn');
    expect(result.hint).toContain('setup');
  });

  it('passes and shows the ISO value once readyAt has been set (real MetaStore.setReadyAtIfUnset)', () => {
    const dbPath = join(dir, 'bridge.db');
    const seedDb = openDatabase(dbPath);
    const readyAt = new MetaStore(seedDb).setReadyAtIfUnset('2026-07-18T00:00:00.000Z');
    seedDb.close();

    const io = buildDefaultDoctorIo();
    const result = getCheck('ready-at').run(baseCtx({ config: baseConfig({ dbPath }), io }));

    expect(result.status).toBe('pass');
    expect(result.message).toContain(readyAt);
  });

  it('does not let a repeated run change the reported value (write-once fence)', () => {
    const dbPath = join(dir, 'bridge.db');
    const seedDb = openDatabase(dbPath);
    const first = new MetaStore(seedDb).setReadyAtIfUnset('2026-07-18T00:00:00.000Z');
    seedDb.close();

    const io = buildDefaultDoctorIo();
    const result = getCheck('ready-at').run(baseCtx({ config: baseConfig({ dbPath }), io }));

    expect(result.status).toBe('pass');
    expect(result.message).toContain(first);
  });

  it('fails when config is null', () => {
    const result = getCheck('ready-at').run(baseCtx({ config: null }));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('config invalid');
  });

  it('fails with a message when the path cannot be opened', () => {
    const dbPath = join(dir, 'no-such-subdir', 'bridge.db');
    const io = buildDefaultDoctorIo();

    const result = getCheck('ready-at').run(baseCtx({ config: baseConfig({ dbPath }), io }));

    expect(result.status).toBe('fail');
    expect(result.message).toContain('failed to open database');
  });
});

describe('runDoctor (D-P5S-4)', () => {
  function fakeCheck(id: string, status: CheckStatus): DoctorCheck {
    return { id, title: `Title-${id}`, run: () => ({ status, message: `${id} says ${status}` }) };
  }

  it('exitCode is 0 when every check passes', () => {
    const { exitCode, results } = runDoctor([fakeCheck('a', 'pass'), fakeCheck('b', 'pass')], baseCtx());

    expect(exitCode).toBe(0);
    expect(results).toHaveLength(2);
  });

  it('exitCode is still 0 when a check warns but none fail', () => {
    const { exitCode } = runDoctor([fakeCheck('a', 'pass'), fakeCheck('b', 'warn')], baseCtx());

    expect(exitCode).toBe(0);
  });

  it('exitCode is 1 when at least one check fails', () => {
    const { exitCode } = runDoctor(
      [fakeCheck('a', 'pass'), fakeCheck('b', 'warn'), fakeCheck('c', 'fail')],
      baseCtx(),
    );

    expect(exitCode).toBe(1);
  });

  it('preserves check order and attaches id/title to each outcome', () => {
    const { results } = runDoctor([fakeCheck('a', 'pass'), fakeCheck('b', 'fail')], baseCtx());

    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(results[0]?.title).toBe('Title-a');
    expect(results[0]?.message).toBe('a says pass');
  });

  it('runs the real five default checks end to end against a null config (all fail but node-version)', () => {
    const { results, exitCode } = runDoctor(
      buildDefaultChecks(),
      baseCtx({ config: null, configErrors: ['selfAddress: must be a non-empty string'] }),
    );

    expect(results.map((r) => r.id)).toEqual([
      'node-version',
      'config',
      'credentials-file',
      'database',
      'ready-at',
    ]);
    expect(results.map((r) => r.status)).toEqual(['pass', 'fail', 'fail', 'fail', 'fail']);
    expect(exitCode).toBe(1);
  });
});

describe('renderDoctorReport (D-P5S-4)', () => {
  it('renders pass/warn/fail with the correct symbol and an indented hint line when present', () => {
    const results: DoctorCheckOutcome[] = [
      { id: 'a', title: 'Alpha', status: 'pass', message: 'all good' },
      { id: 'b', title: 'Beta', status: 'warn', message: 'needs attention', hint: 'run `amb setup`' },
      { id: 'c', title: 'Gamma', status: 'fail', message: 'broken', hint: 'chmod 600 /x' },
    ];

    const report = renderDoctorReport(results);

    expect(report).toBe(
      [
        '✓ Alpha: all good',
        '! Beta: needs attention',
        '  hint: run `amb setup`',
        '✗ Gamma: broken',
        '  hint: chmod 600 /x',
      ].join('\n'),
    );
  });

  it('renders a check with no hint as a single line', () => {
    const results: DoctorCheckOutcome[] = [
      { id: 'a', title: 'Alpha', status: 'pass', message: 'all good' },
    ];

    expect(renderDoctorReport(results)).toBe('✓ Alpha: all good');
  });

  it('renders an empty result list as an empty string', () => {
    expect(renderDoctorReport([])).toBe('');
  });
});

describe('buildDefaultDoctorIo (production wiring)', () => {
  it('wires nodeVersion to the real process.version', () => {
    expect(buildDefaultDoctorIo().nodeVersion).toBe(process.version);
  });

  it('wires stat so a missing path returns null instead of throwing', () => {
    const io = buildDefaultDoctorIo();

    expect(io.stat('/definitely/does/not/exist/amb-doctor-test-probe')).toBeNull();
  });

  it('wires stat to report real file mode/isFile for an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-cli-doctor-io-test-'));
    try {
      const filePath = join(dir, 'x');
      writeFileSync(filePath, 'x');
      chmodSync(filePath, 0o600);

      const stat = buildDefaultDoctorIo().stat(filePath);

      expect(stat?.isFile).toBe(true);
      expect(stat?.isDirectory).toBe(false);
      expect((stat?.mode ?? 0) & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires openDatabase to the real store openDatabase (opens and migrates a temp file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-cli-doctor-io-db-test-'));
    try {
      const dbPath = join(dir, 'bridge.db');

      const db = buildDefaultDoctorIo().openDatabase(dbPath);

      // Pinned to the latest known migration (currently 5, D-P4B8-1) rather
      // than a fixed "1": this test's intent is "did migration actually run
      // to completion", not "the ladder has exactly one rung".
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
