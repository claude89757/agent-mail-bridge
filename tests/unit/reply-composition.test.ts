import { describe, expect, it } from 'vitest';

import {
  assembleCappedBody,
  BODY_TOTAL_CAP,
  EVENT_TEXT_CAP,
  scrubAndCapEventText,
  scrubText,
  type ScrubContext,
} from '../../src/domain/replyComposition.js';

// Guards decisions D-P4B9-1..4 (reply composition — threat-model C9's
// RENDERING half) from
// docs/superpowers/plans/2026-07-19-phase-4-batch9-reply-composition.md:
// `scrubText` is the single exit every composer output funnels through, with
// a FIXED masking order (worktree path -> home path -> keyword values ->
// long tokens) and caps applied strictly AFTER scrubbing (the codex driver's
// scrub-before-truncate precedent: truncation before scrubbing could bisect
// a path needle and leave a live prefix standing).
//
// Fixture discipline (AGENTS.md): synthetic /tmp/fixtures/* paths only, and
// LOW-ENTROPY placeholder values next to secret keywords (Aa-Aa-Tok-0001,
// 64×'a') — CI gitleaks flags "secret keyword + Shannon entropy >= 3.5"
// even for invented values, so high-entropy fakes are as forbidden as real
// ones.

const HOME = '/tmp/fixtures/home-x';
const WORKTREE = '/tmp/fixtures/wt-a';
const SCRUB: ScrubContext = { worktreePath: WORKTREE, homeDir: HOME };

// The four leakage classes the canaries plant (D-P4B9-4): a worktree-local
// path, a home-local path, a keyword-labelled secret value, and a bare long
// token. Reused by the composer-level canaries below.
const CANARY_TEXT = [
  'wrote /tmp/fixtures/wt-a/deep/file.ts',
  'read /tmp/fixtures/home-x/.ssh/id_rsa',
  'Api_Key: Aa-Aa-Tok-0001',
  `uploaded blob ${'a'.repeat(64)}`,
].join('\n');

/** Every "no raw secret survived" assertion the canaries share. */
function expectCanaryClean(text: string): void {
  expect(text).not.toContain('/tmp/fixtures/wt-a');
  expect(text).not.toContain('/tmp/fixtures/home-x');
  expect(text).not.toContain('Aa-Aa-Tok-0001');
  expect(text).not.toContain('a'.repeat(48));
}

describe('scrubText leakage canary (D-P4B9-4)', () => {
  it('masks all four leakage classes and keeps the placeholder forms', () => {
    const out = scrubText(CANARY_TEXT, SCRUB);

    expectCanaryClean(out);
    expect(out).toContain('<cwd>/deep/file.ts');
    expect(out).toContain('<home>/.ssh/id_rsa');
    expect(out).toContain('Api_Key: <redacted>');
    expect(out).toContain('<redacted:64ch>');
  });
});

describe('scrubText units (D-P4B9-1)', () => {
  it('masks the worktree path BEFORE the long-token rule (reversed order would shred a 48+-char path)', () => {
    // A path whose tail segment alone is a 48+-char [A-Za-z0-9+/=_-] run:
    // running the long-token rule first would replace that run with
    // <redacted:NNch>, destroy the needle, and leave the raw
    // '/tmp/fixtures/deep.' prefix standing — exact equality pins the order.
    const longWorktree = `/tmp/fixtures/deep.tree/${'b'.repeat(50)}`;

    const out = scrubText(`error at ${longWorktree}/src/index.ts`, {
      worktreePath: longWorktree,
      homeDir: HOME,
    });

    expect(out).toBe('error at <cwd>/src/index.ts');
  });

  it('masks the worktree path BEFORE the home path (a worktree under home must become <cwd>, not <home>/...)', () => {
    const nestedWorktree = `${HOME}/wt-nested`;

    const out = scrubText(`touched ${nestedWorktree}/a.ts and ${HOME}/.gitconfig`, {
      worktreePath: nestedWorktree,
      homeDir: HOME,
    });

    expect(out).toBe('touched <cwd>/a.ts and <home>/.gitconfig');
  });

  it('masks keyword values BEFORE the long-token rule (keyword and separator survive, value does not)', () => {
    // Reversed order would consume 'token=' + the 48 a's as ONE long run
    // and emit '<redacted:54ch>' with the keyword gone.
    const out = scrubText(`token=${'a'.repeat(48)}`, SCRUB);

    expect(out).toBe('token=<redacted>');
  });

  it('is idempotent: scrubbing already-scrubbed text changes nothing', () => {
    const once = scrubText(CANARY_TEXT, SCRUB);

    expect(scrubText(once, SCRUB)).toBe(once);
  });

  it('skips needles shorter than 2 chars instead of shredding the text', () => {
    expect(scrubText('/ stays as-is', { worktreePath: '/', homeDir: HOME })).toBe('/ stays as-is');
    expect(scrubText('xx marks the spot', { worktreePath: null, homeDir: 'x' })).toBe(
      'xx marks the spot',
    );
    expect(scrubText('nothing to mask', { worktreePath: null, homeDir: '' })).toBe(
      'nothing to mask',
    );
  });

  it('with a null worktreePath only the home path is masked', () => {
    const out = scrubText(`saw ${HOME}/notes.txt`, { worktreePath: null, homeDir: HOME });

    expect(out).toBe('saw <home>/notes.txt');
  });

  it('lets a 40-hex commit sha and a UUID survive (the 48 threshold exists for them)', () => {
    const sha = 'deadbeef'.repeat(5);
    const uuid = '00000000-0000-4000-8000-000000000001';
    const text = `commit ${sha} session ${uuid}`;

    expect(scrubText(text, SCRUB)).toBe(text);
  });

  it('long-token boundary: a 47-char run survives, a 48-char run is masked with its length', () => {
    expect(scrubText('a'.repeat(47), SCRUB)).toBe('a'.repeat(47));
    expect(scrubText('a'.repeat(48), SCRUB)).toBe('<redacted:48ch>');
  });

  it('matches all keyword spellings case-insensitively and preserves each separator verbatim', () => {
    expect(scrubText('apikey: v1', SCRUB)).toBe('apikey: <redacted>');
    expect(scrubText('api-key=v2', SCRUB)).toBe('api-key=<redacted>');
    expect(scrubText('Api_Key : v3', SCRUB)).toBe('Api_Key : <redacted>');
    expect(scrubText('password=hunter2 and secret: hush', SCRUB)).toBe(
      'password=<redacted> and secret: <redacted>',
    );
    expect(scrubText('passwd=pw-1 credential: cred-1', SCRUB)).toBe(
      'passwd=<redacted> credential: <redacted>',
    );
  });

  it('keyword masking never crosses a newline (the plan regex is [^\\S\\n]-guarded)', () => {
    expect(scrubText('token:\nnext line stays', SCRUB)).toBe('token:\nnext line stays');
  });
});

describe('event text cap (D-P4B9-2)', () => {
  it('exports the locked cap constants', () => {
    expect(EVENT_TEXT_CAP).toBe(2000);
    expect(BODY_TOTAL_CAP).toBe(16000);
  });

  // Cap-test padding uses '. ' pairs: an unbroken alphanumeric filler like
  // 'x'.repeat(2000) is ITSELF a 48+ long-token run and gets redacted (the
  // scrub working as designed), which would make these fixtures test the
  // wrong thing.
  it('leaves text at or under EVENT_TEXT_CAP untouched', () => {
    expect(scrubAndCapEventText('short text', SCRUB)).toBe('short text');
    expect(scrubAndCapEventText('. '.repeat(1000), SCRUB)).toBe('. '.repeat(1000));
  });

  it('truncates over-cap text and reports the dropped char count', () => {
    const out = scrubAndCapEventText('. '.repeat(1050), SCRUB);

    expect(out).toBe(`${'. '.repeat(1000)} …[truncated 100ch]`);
  });

  it('scrubs BEFORE truncating: a path straddling the cap line is masked, never bisected', () => {
    // Truncating first would cut the path needle mid-way ('/tmp/fixtu…'),
    // the scrub needle would no longer match, and a live path prefix would
    // ride into the mail body — the exact leak the driver's
    // scrub-before-truncate precedent exists to prevent.
    const straddle = `${'. '.repeat(995)}${WORKTREE}/leak.ts${'. '.repeat(100)}`;

    const out = scrubAndCapEventText(straddle, SCRUB);

    expect(out).toBe(`${'. '.repeat(995)}<cwd>/leak …[truncated 203ch]`);
    expect(out).not.toContain('/tmp/fix');
  });

  it('scrubs even under-cap text (same funnel, no cap shortcut around the scrub)', () => {
    expect(scrubAndCapEventText(`${HOME}/f`, SCRUB)).toBe('<home>/f');
  });
});

describe('body assembly cap (D-P4B9-2)', () => {
  it('joins head, events and tail verbatim when everything fits — no omitted marker', () => {
    const body = assembleCappedBody({
      head: ['H1', '', 'H2'],
      eventEntries: ['E1', 'E2'],
      tail: ['', 'T1'],
    });

    expect(body).toBe('H1\n\nH2\nE1\nE2\n\nT1');
  });

  it('handles an empty event section', () => {
    expect(assembleCappedBody({ head: ['H'], eventEntries: [], tail: ['T'] })).toBe('H\nT');
  });

  it('drops whole events from the OLDEST end until the body fits, and counts them in the marker', () => {
    // 20 entries × 1000 chars: head/tail sizes make d=5 the minimal drop
    // (kept 15×1001 + head/tail/marker = 15077 <= 16000; keeping 16 would
    // be 16078 > 16000) — the exact marker count pins "oldest first" AND
    // "drop no more than needed".
    const entries = Array.from(
      { length: 20 },
      (_, i) => `e${String(i).padStart(2, '0')}:${'z'.repeat(996)}`,
    );

    const body = assembleCappedBody({
      head: ['status-line', 'meta-line'],
      eventEntries: entries,
      tail: ['terminal-line'],
    });

    expect(body.length).toBeLessThanOrEqual(BODY_TOTAL_CAP);
    expect(body).toContain('status-line');
    expect(body).toContain('meta-line');
    expect(body).toContain('terminal-line');
    expect(body).toContain('[5 earlier events omitted]');
    expect(body).not.toContain('e00:');
    expect(body).not.toContain('e04:');
    expect(body).toContain('e05:');
    expect(body).toContain('e19:');
    // Region order stays head -> marker -> surviving events -> tail.
    expect(body.indexOf('meta-line')).toBeLessThan(body.indexOf('[5 earlier events omitted]'));
    expect(body.indexOf('[5 earlier events omitted]')).toBeLessThan(body.indexOf('e05:'));
    expect(body.indexOf('e05:')).toBeLessThan(body.indexOf('e19:'));
    expect(body.indexOf('e19:')).toBeLessThan(body.indexOf('terminal-line'));
  });

  it('never drops the tail: one oversized event is dropped entirely, head and tail stand', () => {
    const body = assembleCappedBody({
      head: ['H'],
      eventEntries: ['g'.repeat(20000)],
      tail: ['T'],
    });

    expect(body).toBe('H\n[1 earlier events omitted]\nT');
  });

  it('never truncates head or tail, even when they alone exceed the cap (composer precondition violated)', () => {
    // Composers guarantee capped tails by construction (every terminal text
    // rides through scrubAndCapEventText first); if that precondition is
    // ever violated the helper still refuses to cut head/tail — dropping
    // events is its ONLY size lever.
    const bigTail = 't'.repeat(17000);

    const body = assembleCappedBody({ head: ['H'], eventEntries: [], tail: [bigTail] });

    expect(body).toBe(`H\n${bigTail}`);
  });
});
