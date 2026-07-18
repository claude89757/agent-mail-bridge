import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadLiveCreds } from '../helpers/liveCreds.js';

// Guards decision D-P3B2-4
// (docs/superpowers/plans/2026-07-19-phase-3-batch2-imap-read-path.md):
// `loadLiveCreds` never touches the real ~/.secrets/amb-test.env from this
// file — every call below passes an INJECTED temp-dir `baseDir` (AGENTS.md
// red lines 1/2: this task's own tests must never read the operator's real
// credentials file, and credential values must never be asserted-on by
// content or embedded anywhere). Placeholder values only (public-repo
// rule), matching the convention in tests/unit/imap-read-transport.test.ts:
// bridge-user@example.com / a fixed non-secret literal standing in for an
// app password. This file never calls `loadLiveCreds()` with zero
// arguments — that is exclusively `tests/live/imap-read-live.test.ts`'s
// job, and only at module scope (see that file's header comment).

const ENV_FILE_NAME = 'amb-test.env';
const PLACEHOLDER_USER = 'bridge-user@example.com';
const PLACEHOLDER_PASS = 'placeholder-app-password';

describe('loadLiveCreds (D-P3B2-4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amb-live-creds-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeEnvFile(content: string): void {
    writeFileSync(join(dir, ENV_FILE_NAME), content);
  }

  it('returns {user, pass} when both keys are present', () => {
    writeEnvFile(`AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\nAMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}\n`);

    expect(loadLiveCreds(dir)).toEqual({ user: PLACEHOLDER_USER, pass: PLACEHOLDER_PASS });
  });

  // Pins the parser's documented duplicate-key behavior (last occurrence
  // wins), previously stated only in liveCreds.ts's doc comment.
  it('lets the last occurrence win when a key is duplicated', () => {
    writeEnvFile(
      `AMB_TEST_IMAP_USER=stale-user@example.net\n` +
        `AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\n` +
        `AMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}\n`,
    );

    expect(loadLiveCreds(dir)).toEqual({ user: PLACEHOLDER_USER, pass: PLACEHOLDER_PASS });
  });

  // Pins the parser's documented empty-key behavior (a line starting with
  // `=` has no key and is skipped, not treated as a mystery entry).
  it('skips a line whose key before = is empty', () => {
    writeEnvFile(
      `=orphan-value\nAMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\nAMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}\n`,
    );

    expect(loadLiveCreds(dir)).toEqual({ user: PLACEHOLDER_USER, pass: PLACEHOLDER_PASS });
  });

  it('returns null when the env file does not exist', () => {
    expect(loadLiveCreds(dir)).toBeNull();
  });

  it('does not throw when the env file does not exist', () => {
    expect(() => loadLiveCreds(dir)).not.toThrow();
  });

  it('returns null when the base directory itself does not exist', () => {
    const missingDir = join(dir, 'does-not-exist');

    expect(loadLiveCreds(missingDir)).toBeNull();
  });

  it('returns null when AMB_TEST_IMAP_USER is missing', () => {
    writeEnvFile(`AMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}\n`);

    expect(loadLiveCreds(dir)).toBeNull();
  });

  it('returns null when AMB_TEST_IMAP_PASS is missing', () => {
    writeEnvFile(`AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\n`);

    expect(loadLiveCreds(dir)).toBeNull();
  });

  it('returns null when AMB_TEST_IMAP_USER is present but empty', () => {
    writeEnvFile(`AMB_TEST_IMAP_USER=\nAMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}\n`);

    expect(loadLiveCreds(dir)).toBeNull();
  });

  it('returns null when AMB_TEST_IMAP_PASS is present but empty', () => {
    writeEnvFile(`AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\nAMB_TEST_IMAP_PASS=\n`);

    expect(loadLiveCreds(dir)).toBeNull();
  });

  it('tolerates comment lines and blank lines interspersed with the real entries', () => {
    writeEnvFile(
      [
        '# amb-test.env - placeholder fixture, not a real credentials file',
        '',
        `AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}`,
        '',
        '  # indented comment before the password line',
        `AMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}`,
        '',
      ].join('\n'),
    );

    expect(loadLiveCreds(dir)).toEqual({ user: PLACEHOLDER_USER, pass: PLACEHOLDER_PASS });
  });

  it('keeps a value containing "=" intact after the first "="', () => {
    writeEnvFile(`AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\nAMB_TEST_IMAP_PASS=abcd=efgh==ijkl\n`);

    expect(loadLiveCreds(dir)).toEqual({ user: PLACEHOLDER_USER, pass: 'abcd=efgh==ijkl' });
  });

  it('takes the value verbatim: leading/trailing/internal spaces survive untouched (only the newline itself is stripped)', () => {
    writeEnvFile(`AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\nAMB_TEST_IMAP_PASS= a b  c \n`);

    expect(loadLiveCreds(dir)).toEqual({ user: PLACEHOLDER_USER, pass: ' a b  c ' });
  });

  it('works with no trailing newline at EOF', () => {
    writeEnvFile(`AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\nAMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}`);

    expect(loadLiveCreds(dir)).toEqual({ user: PLACEHOLDER_USER, pass: PLACEHOLDER_PASS });
  });

  it('works with CRLF line endings', () => {
    writeEnvFile(`AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\r\nAMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}\r\n`);

    expect(loadLiveCreds(dir)).toEqual({ user: PLACEHOLDER_USER, pass: PLACEHOLDER_PASS });
  });

  it('ignores a differently-named file in the same directory (exact filename "amb-test.env" required)', () => {
    writeFileSync(
      join(dir, 'other.env'),
      `AMB_TEST_IMAP_USER=${PLACEHOLDER_USER}\nAMB_TEST_IMAP_PASS=${PLACEHOLDER_PASS}\n`,
    );

    expect(loadLiveCreds(dir)).toBeNull();
  });

  it('never throws on a binary-garbage file and returns null', () => {
    writeFileSync(join(dir, ENV_FILE_NAME), randomBytes(512));

    expect(() => loadLiveCreds(dir)).not.toThrow();
    expect(loadLiveCreds(dir)).toBeNull();
  });
});
