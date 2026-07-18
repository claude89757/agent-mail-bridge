import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LoadConfigIo } from '../../src/cli/config.js';
import { loadConfig } from '../../src/cli/config.js';
import { buildDefaultDoctorIo } from '../../src/cli/doctor.js';
import type { EnvLike } from '../../src/cli/paths.js';
import { resolveConfigPath, resolveDefaultDbPath } from '../../src/cli/paths.js';
import { runSetup } from '../../src/cli/setup.js';
import type { SetupIo } from '../../src/cli/setup.js';
import { openDatabase } from '../../src/store/database.js';
import { MetaStore } from '../../src/store/metaStore.js';

// Guards decision D-P5S-6 (`amb setup`, six steps in order) and its reuse of
// D-P5S-3's credentials-file hygiene check. Per D-P5S-7, `env`/`homedir`
// always point INTO a real mkdtemp tree here -- the real HOME is never
// touched, and every filesystem/database effect below is real (chmodSync,
// real SQLite files), matching how tests/unit/cli-doctor.test.ts exercises
// `buildDefaultDoctorIo`.

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amb-cli-setup-test-'));
  home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Real-fs `SetupIo`: `stat`/`openDatabase` are reused directly from
 * `buildDefaultDoctorIo()` (same contract, same production wiring `main.ts`
 * itself uses) so this test never re-implements ENOENT-to-null translation;
 * `mkdir`/`writeFile`/`chmod` are thin real-`fs` wrappers matching each
 * field's documented contract in `src/cli/setup.ts`. */
function makeIo(env: EnvLike = {}): SetupIo {
  const doctorIo = buildDefaultDoctorIo();
  return {
    env,
    homedir: home,
    stat: doctorIo.stat,
    openDatabase: doctorIo.openDatabase,
    mkdir: (path) => {
      mkdirSync(path, { recursive: true });
    },
    writeFile: (path, content) => {
      writeFileSync(path, content, 'utf8');
    },
    chmod: (path, mode) => {
      chmodSync(path, mode);
    },
  };
}

/** A real 0600 credentials file with a 0700 parent directory somewhere in
 * the temp tree -- satisfies D-P5S-3 so tests not specifically ABOUT the
 * hygiene check can get past step 2. */
function makeValidCredentialsFile(name = 'secrets'): string {
  const credDir = join(dir, name);
  mkdirSync(credDir, { recursive: true });
  chmodSync(credDir, 0o700);
  const file = join(credDir, 'amb-test.env');
  writeFileSync(file, 'AMB_TEST_IMAP_USER=x\nAMB_TEST_IMAP_PASS=y\n');
  chmodSync(file, 0o600);
  return file;
}

describe('runSetup (D-P5S-6)', () => {
  it('fresh-directory happy path: 0600 config that round-trips through loadConfig, db file created, readyAt written and echoed, exit 0', () => {
    const credentialsEnvFile = makeValidCredentialsFile();
    const io = makeIo();
    const now = new Date('2026-07-18T12:00:00.000Z');

    const result = runSetup(
      ['--self', 'bridge-user@example.com', '--credentials-env-file', credentialsEnvFile],
      io,
      now,
    );

    expect(result.exitCode).toBe(0);

    const configPath = resolveConfigPath(io.env, io.homedir);
    const stat = statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const rawText = readFileSync(configPath, 'utf8');
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    expect(raw).toMatchObject({ version: 1, selfAddress: 'bridge-user@example.com' });

    const loadIo: LoadConfigIo = {
      readFileSync: (p) => readFileSync(p, 'utf8'),
      homedir: home,
      env: {},
    };
    const loaded = loadConfig(configPath, loadIo);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.selfAddress).toBe('bridge-user@example.com');
      expect(loaded.config.credentialsEnvFile).toBe(credentialsEnvFile);
      expect(loaded.config.mailbox).toBe('INBOX');
      expect(loaded.config.dryRun).toBe(false);
    }

    const dbPath = resolveDefaultDbPath(io.env, io.homedir);
    expect(statSync(dbPath).isFile()).toBe(true);

    const db = openDatabase(dbPath);
    const readyAt = new MetaStore(db).getReadyAt();
    db.close();
    expect(readyAt).toBe(now.toISOString());

    expect(result.messages.some((m) => m.includes(now.toISOString()))).toBe(true);
  });

  it('rejects a repeat setup without --force-config: exit 1, existing config byte-unchanged', () => {
    const credentialsEnvFile = makeValidCredentialsFile();
    const io = makeIo();
    const args = ['--self', 'bridge-user@example.com', '--credentials-env-file', credentialsEnvFile];

    const first = runSetup(args, io, new Date('2026-07-18T12:00:00.000Z'));
    expect(first.exitCode).toBe(0);

    const configPath = resolveConfigPath(io.env, io.homedir);
    const before = readFileSync(configPath, 'utf8');

    const second = runSetup(args, io, new Date('2026-07-19T00:00:00.000Z'));

    expect(second.exitCode).toBe(1);
    expect(second.messages.join('\n')).toContain('--force-config');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('repeat setup WITH --force-config overwrites config but readyAt is unchanged (first value wins)', () => {
    const credentialsEnvFile = makeValidCredentialsFile();
    const io = makeIo();
    const args = ['--self', 'bridge-user@example.com', '--credentials-env-file', credentialsEnvFile];
    const firstNow = new Date('2026-07-18T12:00:00.000Z');
    const laterNow = new Date('2026-07-19T00:00:00.000Z');

    const first = runSetup(args, io, firstNow);
    expect(first.exitCode).toBe(0);

    const second = runSetup([...args, '--force-config'], io, laterNow);

    expect(second.exitCode).toBe(0);
    expect(second.messages.some((m) => m.toLowerCase().includes('already'))).toBe(true);
    expect(second.messages.some((m) => m.includes(firstNow.toISOString()))).toBe(true);

    const dbPath = resolveDefaultDbPath(io.env, io.homedir);
    const db = openDatabase(dbPath);
    const readyAt = new MetaStore(db).getReadyAt();
    db.close();
    expect(readyAt).toBe(firstNow.toISOString());
    expect(readyAt).not.toBe(laterNow.toISOString());
  });

  it('credentials file with mode 0644 fails closed BEFORE writing config: exit 1, chmod 600 hint, no config file written', () => {
    const credDir = join(dir, 'bad-secrets');
    mkdirSync(credDir, { recursive: true });
    chmodSync(credDir, 0o700);
    const credentialsEnvFile = join(credDir, 'amb-test.env');
    writeFileSync(credentialsEnvFile, 'X=1\n');
    chmodSync(credentialsEnvFile, 0o644);
    const io = makeIo();

    const result = runSetup(
      ['--self', 'bridge-user@example.com', '--credentials-env-file', credentialsEnvFile],
      io,
      new Date('2026-07-18T12:00:00.000Z'),
    );

    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('chmod 600');

    const configPath = resolveConfigPath(io.env, io.homedir);
    expect(() => statSync(configPath)).toThrow();
  });

  it('aggregates schema errors: invalid --self AND a relative --db-path are both reported in one run, exit 1', () => {
    const io = makeIo();

    const result = runSetup(
      [
        '--self',
        'not-an-email',
        '--credentials-env-file',
        '/fake/creds.env',
        '--db-path',
        'relative/bridge.db',
      ],
      io,
      new Date('2026-07-18T12:00:00.000Z'),
    );

    expect(result.exitCode).toBe(1);
    const joined = result.messages.join('\n');
    expect(joined).toContain('selfAddress');
    expect(joined).toContain('dbPath');

    const configPath = resolveConfigPath(io.env, io.homedir);
    expect(() => statSync(configPath)).toThrow();
  });

  it('lands --dry-run/--mailbox/--db-path flags into the written config', () => {
    const credentialsEnvFile = makeValidCredentialsFile();
    const io = makeIo();
    const customDbPath = join(dir, 'custom-data', 'bridge.db');

    const result = runSetup(
      [
        '--self',
        'bridge-user@example.com',
        '--credentials-env-file',
        credentialsEnvFile,
        '--db-path',
        customDbPath,
        '--mailbox',
        'Archive',
        '--dry-run',
      ],
      io,
      new Date('2026-07-18T12:00:00.000Z'),
    );

    expect(result.exitCode).toBe(0);

    const configPath = resolveConfigPath(io.env, io.homedir);
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.dbPath).toBe(customDbPath);
    expect(raw.mailbox).toBe('Archive');
    expect(raw.dryRun).toBe(true);

    expect(statSync(customDbPath).isFile()).toBe(true);
  });

  it('reports invalid CLI arguments (unknown flag) without throwing, exit 1', () => {
    const io = makeIo();

    expect(() => runSetup(['--bogus-flag', 'x'], io, new Date('2026-07-18T12:00:00.000Z'))).not.toThrow();
    const result = runSetup(['--bogus-flag', 'x'], io, new Date('2026-07-18T12:00:00.000Z'));

    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n').length).toBeGreaterThan(0);
  });
});
