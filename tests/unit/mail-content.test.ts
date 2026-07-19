import { describe, expect, it } from 'vitest';

import { extractCommand } from '../../src/domain/mailContent.js';
import { normalizeMessageId } from '../../src/domain/mail.js';

// Guards decision D-P4B10-2 (docs/superpowers/plans/2026-07-19-phase-4-batch10-mail-content-path.md):
// the pure extraction function that turns a command mail's already-fetched
// pieces (subject, bodyText, thread headers) into { threadKey, term, prompt }
// for the daemon's dispatch wiring (next batch). The v0.1 minimal command
// format — subject first token = project term, body = task text — is locked
// HERE (doc'd in src/domain/mailContent.ts) and cheap to adjust after
// real-device use precisely because this is a pure function.
//
// Placeholder addresses/ids only (public-repo rule): example.com/example.net.

/** Convenience: every field absent — individual tests override only what
 *  they exercise. */
function input(
  overrides: Partial<Parameters<typeof extractCommand>[0]> = {},
): Parameters<typeof extractCommand>[0] {
  return {
    subjectRaw: null,
    bodyText: null,
    messageIdNormalized: null,
    references: [],
    inReplyTo: null,
    ...overrides,
  };
}

describe('extractCommand (D-P4B10-2)', () => {
  describe('threadKey (three-level fallback: References first id ?? In-Reply-To ?? own Message-ID)', () => {
    it('References first id wins even when In-Reply-To and the own Message-ID are both present', () => {
      const result = extractCommand(
        input({
          references: ['<root@example.com> <mid@example.net>'],
          inReplyTo: '<parent@example.net>',
          messageIdNormalized: 'self@example.com',
        }),
      );

      expect(result.threadKey).toBe('root@example.com');
    });

    it('takes the FIRST id across multiple References instances, in occurrence order', () => {
      const result = extractCommand(
        input({
          references: ['<root@example.com>', '<later@example.net>'],
        }),
      );

      expect(result.threadKey).toBe('root@example.com');
    });

    it('skips a References instance with no bracketed token at all and anchors on the next instance', () => {
      const result = extractCommand(
        input({
          references: ['(this instance carries no id)', '<root@example.com>'],
        }),
      );

      expect(result.threadKey).toBe('root@example.com');
    });

    it('restarts token scanning at an inner "<" so an unclosed bracket cannot swallow the real id', () => {
      const result = extractCommand(
        input({
          references: ['junk < <root@example.com>'],
        }),
      );

      expect(result.threadKey).toBe('root@example.com');
    });

    it('falls back to In-Reply-To when References is empty', () => {
      const result = extractCommand(
        input({
          inReplyTo: '<parent@example.net>',
          messageIdNormalized: 'self@example.com',
        }),
      );

      expect(result.threadKey).toBe('parent@example.net');
    });

    it('an INVALID first References id (no @) fails closed to In-Reply-To — never re-anchors onto a later id in the chain', () => {
      const result = extractCommand(
        input({
          references: ['<no-at-sign> <second@example.com>'],
          inReplyTo: '<parent@example.net>',
        }),
      );

      expect(result.threadKey).toBe('parent@example.net');
    });

    it('the root-or-nothing rule spans instances too: an invalid id in the FIRST instance never re-anchors onto the second instance', () => {
      const result = extractCommand(
        input({
          references: ['<no-at-sign>', '<second@example.com>'],
          inReplyTo: '<parent@example.net>',
        }),
      );

      expect(result.threadKey).toBe('parent@example.net');
    });

    it('a bracketless In-Reply-To yields no anchor (fail closed) and falls through to the own Message-ID', () => {
      const result = extractCommand(
        input({
          inReplyTo: 'bare@example.net',
          messageIdNormalized: 'self@example.com',
        }),
      );

      expect(result.threadKey).toBe('self@example.com');
    });

    it('falls back to the own normalized Message-ID when References and In-Reply-To are both absent (a fresh command roots its own thread)', () => {
      const result = extractCommand(input({ messageIdNormalized: 'self@example.com' }));

      expect(result.threadKey).toBe('self@example.com');
    });

    it('is null when all three anchors are absent (upstream ingest already rejects NO_MESSAGE_ID, so this is belt-and-suspenders)', () => {
      expect(extractCommand(input()).threadKey).toBeNull();
    });

    // 对拍 (D-P4B10-2): the References/In-Reply-To extraction must be the
    // SAME normalization ingest applies to Message-ID — literally
    // `normalizeMessageId` — so a reply's thread anchor compares equal to
    // the key the original command was recorded under. Same raw token
    // through both paths ⇒ identical output, INCLUDING case preservation.
    it('normalizes reference ids with the exact ingest normalization (same input, same output, case preserved)', () => {
      const rawToken = '<AbC-123@Example.COM>';

      const viaIngest = normalizeMessageId(rawToken);
      const viaReferences = extractCommand(input({ references: [rawToken] })).threadKey;
      const viaInReplyTo = extractCommand(input({ inReplyTo: rawToken })).threadKey;

      expect(viaIngest).not.toBeNull();
      expect(viaReferences).toBe(viaIngest);
      expect(viaInReplyTo).toBe(viaIngest);
      expect(viaReferences).toBe('AbC-123@Example.COM');
    });

    it('tolerates surrounding whitespace on the extracted token exactly like ingest does', () => {
      const result = extractCommand(input({ inReplyTo: '  <parent@example.net>  ' }));

      expect(result.threadKey).toBe(normalizeMessageId('  <parent@example.net>  '));
      expect(result.threadKey).toBe('parent@example.net');
    });
  });

  describe('term (subject first token after stripping the re:/fwd: chain, trim+lowercase)', () => {
    it('takes the first whitespace-delimited token, lowercased', () => {
      expect(extractCommand(input({ subjectRaw: 'Proj-A run the tests' })).term).toBe('proj-a');
    });

    it('strips a multi-level re:/fwd: chain, case-insensitively, tolerating whitespace', () => {
      expect(extractCommand(input({ subjectRaw: 're: re: fix the bug' })).term).toBe('fix');
      expect(extractCommand(input({ subjectRaw: 'Re:  FWD: re: Deploy now' })).term).toBe('deploy');
      expect(extractCommand(input({ subjectRaw: 'RE:FWD:proj-a continue' })).term).toBe('proj-a');
    });

    it('is null for a null subject', () => {
      expect(extractCommand(input()).term).toBeNull();
    });

    it('is null for an empty or all-whitespace subject', () => {
      expect(extractCommand(input({ subjectRaw: '' })).term).toBeNull();
      expect(extractCommand(input({ subjectRaw: '   ' })).term).toBeNull();
    });

    it('is null when the subject is ONLY a re:/fwd: chain', () => {
      expect(extractCommand(input({ subjectRaw: 'Re: Re:' })).term).toBeNull();
      expect(extractCommand(input({ subjectRaw: 'Fwd: ' })).term).toBeNull();
    });
  });

  describe('prompt (body first, stripped subject as fallback)', () => {
    it('uses the trimmed body when it is non-empty', () => {
      const result = extractCommand(
        input({ subjectRaw: 'proj-a ignored', bodyText: '  run the tests\r\n' }),
      );

      expect(result.prompt).toBe('run the tests');
    });

    it('preserves internal newlines of a multi-line body (only the ends are trimmed)', () => {
      const result = extractCommand(input({ bodyText: 'line one\nline two\n' }));

      expect(result.prompt).toBe('line one\nline two');
    });

    it('falls back to the FULL stripped subject when the body is whitespace-only', () => {
      const result = extractCommand(
        input({ subjectRaw: 'Re: proj-a run the tests', bodyText: ' \r\n ' }),
      );

      expect(result.prompt).toBe('proj-a run the tests');
    });

    it('falls back to the FULL stripped subject when the body is null', () => {
      const result = extractCommand(input({ subjectRaw: 'Fwd: proj-a run the tests' }));

      expect(result.prompt).toBe('proj-a run the tests');
    });

    it('is null when the body is empty and the subject is only a re:/fwd: chain', () => {
      expect(extractCommand(input({ subjectRaw: 'Re: re:', bodyText: '' })).prompt).toBeNull();
    });

    it('is null when body and subject are both null', () => {
      expect(extractCommand(input()).prompt).toBeNull();
    });
  });

  it('extracts the full shape from a realistic fresh command mail', () => {
    const result = extractCommand(
      input({
        subjectRaw: 'proj-a run the full suite',
        bodyText: 'run pnpm test and report failures\n',
        messageIdNormalized: 'cmd-1@example.com',
      }),
    );

    expect(result).toEqual({
      threadKey: 'cmd-1@example.com',
      term: 'proj-a',
      prompt: 'run pnpm test and report failures',
    });
  });

  it('extracts the full shape from a realistic reply (continue) mail', () => {
    const result = extractCommand(
      input({
        subjectRaw: 'Re: proj-a run the full suite',
        bodyText: 'now fix the two failures\n',
        messageIdNormalized: 'cmd-2@example.com',
        references: ['<cmd-1@example.com> <reply-1@example.com>'],
        inReplyTo: '<reply-1@example.com>',
      }),
    );

    expect(result).toEqual({
      threadKey: 'cmd-1@example.com',
      term: 'proj-a',
      prompt: 'now fix the two failures',
    });
  });
});
