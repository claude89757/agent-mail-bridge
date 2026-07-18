/**
 * Live-mailbox credential loader (decision D-P3B2-4,
 * docs/superpowers/plans/2026-07-19-phase-3-batch2-imap-read-path.md): reads
 * the dedicated test mailbox's IMAP credentials from a local env file so
 * `tests/live/imap-read-live.test.ts` can opt into a real, read-only
 * connection. AGENTS.md's security red lines govern this file directly:
 *   - red line 1: the default path resolves ONLY to
 *     `~/.secrets/amb-test.env` — the dedicated test-mailbox credential
 *     file, never a real/personal mailbox's credentials;
 *   - red line 2: credential VALUES are never printed, logged, or embedded
 *     in a thrown error. In fact `loadLiveCreds` never throws at all (see
 *     its doc comment below), so there is no error-message channel for a
 *     value to leak through in the first place.
 *
 * `baseDir` is always caller-injectable, mirroring `src/cli/paths.ts`'s
 * `env`/`homedir` injection discipline (real values are read at exactly one
 * call site, everything else takes them as parameters so tests can pin
 * fixed values). Every test in `tests/unit/live-creds.test.ts` passes a
 * temp-dir fixture with placeholder values, never the real default. Only
 * `tests/live/imap-read-live.test.ts` calls `loadLiveCreds()` with no
 * argument, and only once, at module scope, outside any `describe`/`it`
 * body a skip could bypass — see that file's header comment for the full
 * safety argument (the `AMB_LIVE_TEST` env-var gate).
 *
 * `no-console` (house eslint rule) applies to this file same as `src/`: it
 * must never become a hidden logging backdoor for credential values.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LiveCreds {
  user: string;
  pass: string;
}

const ENV_FILE_NAME = 'amb-test.env';
const USER_KEY = 'AMB_TEST_IMAP_USER';
const PASS_KEY = 'AMB_TEST_IMAP_PASS';

/**
 * Splits `text` into physical lines, tolerating both CRLF and bare-LF
 * terminators by dropping a trailing `\r` left over from a `\n`-delimited
 * chunk. Manual `indexOf`/`charAt` scanning, no regex — same ReDoS-avoidance
 * posture as `unfoldHeaderLines` in `src/transports/imapRead.ts` (the
 * closest sibling: another CRLF/LF-tolerant raw-text line splitter reused
 * here as a pattern, not imported — that function unfolds RFC 5322 header
 * continuations, a different job). A line returned here still carries
 * everything except its own terminator: "value taken verbatim after the
 * first `=`, trailing newline stripped" (this module's contract, see
 * {@link loadLiveCreds}) is entirely implemented by this one stripping step,
 * never by a later `.trim()` on the value.
 */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  const len = text.length;
  let pos = 0;

  while (pos <= len) {
    const nl = text.indexOf('\n', pos);
    const lineEndsAt = nl === -1 ? len : nl;
    const hasCr = lineEndsAt > pos && text.charAt(lineEndsAt - 1) === '\r';
    const contentEnd = hasCr ? lineEndsAt - 1 : lineEndsAt;
    lines.push(text.slice(pos, contentEnd));
    if (nl === -1) {
      break;
    }
    pos = nl + 1;
  }

  return lines;
}

/** True for a line that is empty or contains only whitespace. */
function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * True for a `#`-comment line. Leading whitespace before `#` is tolerated —
 * matches `spikes/p0-1-imap/observe.ts`'s `readCreds` (`trimmed.startsWith('#')`
 * after a full-line `.trim()`), so the identical physical env file is
 * accepted by both readers (see {@link parseEnvFile}'s doc comment for the
 * one deliberate delta between them).
 */
function isComment(line: string): boolean {
  return line.trimStart().startsWith('#');
}

/**
 * Parses env-file text into a `KEY -> value` map: `KEY=VALUE` lines only,
 * comments (`#`, leading whitespace tolerated) and blank lines skipped, a
 * line with no `=` skipped, a line whose key (text before the first `=`,
 * trimmed) is empty skipped. Duplicate keys: the LAST occurrence wins (plain
 * `Map.set` overwrite) — this module has no stake in rejecting a malformed
 * file with the same key twice, it only needs *a* deterministic answer.
 *
 * DELIBERATE DELTA from `spikes/p0-1-imap/observe.ts`'s `readCreds`: that
 * reader additionally `.trim()`s each extracted value (it trims the whole
 * line, then trims the value again after slicing). This module does NOT —
 * the value is kept byte-for-byte verbatim after the first `=` (only the
 * line terminator itself is ever removed, by {@link splitLines}). This is
 * intentional, not an oversight: an app password may legitimately contain
 * leading/trailing/internal whitespace, and silently trimming it would
 * hand a caller a credential that does not match what is actually on file
 * with the mail provider. Quotes (`"`/`'`) are likewise never stripped —
 * this parser has no opinion on whether they are meaningful characters
 * inside the credential, so removing them would be an unannounced,
 * unrequested transformation of the secret's bytes.
 *
 * Both readers still accept the IDENTICAL real-world file (comments, blank
 * lines, `KEY=VALUE`, optional CRLF): they only disagree on a byte range —
 * accidental whitespace padding around a value — that a correctly-authored
 * credentials file never has, so a real `~/.secrets/amb-test.env` parses
 * identically either way in practice.
 */
function parseEnvFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of splitLines(text)) {
    if (isBlank(line) || isComment(line)) {
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
    const value = line.slice(eqIdx + 1);
    entries.set(key, value);
  }

  return entries;
}

/**
 * Reads `<baseDir>/amb-test.env` (default `baseDir`: `~/.secrets`, i.e.
 * `join(homedir(), '.secrets')`) and extracts `AMB_TEST_IMAP_USER` /
 * `AMB_TEST_IMAP_PASS`. Returns `null` when: the file is missing or
 * otherwise unreadable, the base directory itself is missing, or either key
 * is missing or present-but-empty.
 *
 * NEVER throws — every failure mode collapses to `null`, matching this
 * codebase's fail-closed-and-quiet convention for optional local state
 * (compare `src/cli/doctor.ts`'s `stat`, which returns `null` for ENOENT
 * instead of throwing). The outer `try`/`catch` is a deliberate
 * belt-and-suspenders on top of the individual key/emptiness checks below:
 * even an unanticipated failure mode (e.g. a permissions error, or some
 * future Node fs edge case) still resolves to `null`, never propagates.
 * Reading a binary-garbage file never throws either: Node's `'utf-8'`
 * decoding substitutes the U+FFFD replacement character for invalid byte
 * sequences rather than throwing, so `parseEnvFile` just sees (and
 * harmlessly fails to match any key in) a garbled string.
 *
 * NEVER logs — no `console.*` call appears in this file, and no credential
 * value is ever interpolated into a string this function constructs (there
 * is nothing constructed to interpolate into: every failure path returns
 * the literal `null`).
 */
export function loadLiveCreds(baseDir?: string): LiveCreds | null {
  try {
    const dir = baseDir ?? join(homedir(), '.secrets');
    const content = readFileSync(join(dir, ENV_FILE_NAME), 'utf-8');
    const entries = parseEnvFile(content);

    const user = entries.get(USER_KEY);
    if (user === undefined || user.length === 0) {
      return null;
    }
    const pass = entries.get(PASS_KEY);
    if (pass === undefined || pass.length === 0) {
      return null;
    }

    return { user, pass };
  } catch {
    return null;
  }
}
