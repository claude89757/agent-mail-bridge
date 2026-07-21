import { describe, expect, it } from 'vitest';

import {
  assembleCappedBody,
  BODY_TOTAL_CAP,
  composeAckReply,
  composeCoordinatorAnswerReply,
  composeCoordinatorClarifyReply,
  composeDispatchFailedReply,
  composeDryRunReply,
  composeResultReply,
  EVENT_TEXT_CAP,
  scrubAndCapEventText,
  scrubText,
  type ReplyContext,
  type ScrubContext,
} from '../../src/domain/replyComposition.js';
import type { RouteVerdict } from '../../src/domain/routing.js';
import type { DriverEvent } from '../../src/drivers/types.js';
import type { OutboundMail } from '../../src/transports/types.js';

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

  it('normalizes trailing-slash needles so bare path mentions are still masked (review M-1)', () => {
    // ScrubContext is an exported seam: a daemon-built context may carry
    // '/tmp/fixtures/wt-a/' while the text mentions the bare path — the
    // needle is normalized (all trailing '/' stripped) before matching.
    const out = scrubText(`saw ${WORKTREE} and ${HOME}/notes`, {
      worktreePath: `${WORKTREE}/`,
      homeDir: `${HOME}//`,
    });

    expect(out).toBe('saw <cwd> and <home>/notes');
  });

  it('a needle that is ONLY slashes strips to empty and is skipped (needle >= 2 guard on the stripped form)', () => {
    expect(scrubText('/// stays as-is', { worktreePath: '///', homeDir: HOME })).toBe(
      '/// stays as-is',
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

// ---------------------------------------------------------------------------
// Composers (D-P4B9-3)
// ---------------------------------------------------------------------------

function replyContext(overrides: Partial<ReplyContext> = {}): ReplyContext {
  return {
    originalSubject: 'run the tests',
    commandId: 42,
    intentId: 'intent-0001',
    projectName: 'proj-a',
    scrub: SCRUB,
    ...overrides,
  };
}

describe('composeResultReply (D-P4B9-3)', () => {
  it('renders the fixed four-region skeleton in order for a completed run', () => {
    // Exact-equality pins region order AND that the terminal event in the
    // events array is rendered ONLY in the terminal region ('done now'
    // appears once), never duplicated as an event line.
    const mail = composeResultReply(replyContext(), {
      verdict: 'DISPATCH_NEW',
      terminal: { kind: 'completed', resultText: 'done now' },
      events: [
        { kind: 'agent-message', text: 'hello' },
        { kind: 'tool-activity', summary: 'ran build' },
        { kind: 'completed', resultText: 'done now' },
      ],
    });

    expect(mail.kind).toBe('RESULT');
    expect(mail.commandId).toBe(42);
    expect(mail.subjectRedacted).toBe('Re: run the tests');
    expect(mail.bodyRedacted).toBe(
      [
        '✅ completed (DISPATCH_NEW)',
        '',
        'project: proj-a',
        'intent: intent-0001',
        'verdict: DISPATCH_NEW',
        '',
        'events:',
        '[agent] hello',
        '[tool] ran build',
        '',
        'result:',
        'done now',
      ].join('\n'),
    );
  });

  it('renders a failed terminal as kind ERROR with the error: region', () => {
    const mail = composeResultReply(replyContext(), {
      verdict: 'CONTINUE_SESSION',
      terminal: { kind: 'failed', errorText: `crash at ${WORKTREE}/x.ts — token: Aa-Aa-Tok-0001` },
      events: [],
    });

    expect(mail.kind).toBe('ERROR');
    expect(mail.bodyRedacted).toContain('❌ failed (CONTINUE_SESSION)');
    expect(mail.bodyRedacted).toContain('error:\ncrash at <cwd>/x.ts — token: <redacted>');
    // No events -> no events region at all.
    expect(mail.bodyRedacted).not.toContain('events:');
    expectCanaryClean(mail.bodyRedacted);
  });

  it('omits the project name as (unknown) when none is known', () => {
    const mail = composeResultReply(replyContext({ projectName: null }), {
      verdict: 'CONTINUE_SESSION',
      terminal: { kind: 'completed', resultText: 'ok' },
      events: [],
    });

    expect(mail.bodyRedacted).toContain('project: (unknown)');
  });

  it('scrubs and caps every event line through the one funnel', () => {
    const longEventText = `${WORKTREE}/big.ts ${'. '.repeat(1200)}`;

    const mail = composeResultReply(replyContext(), {
      verdict: 'DISPATCH_NEW',
      terminal: { kind: 'completed', resultText: 'ok' },
      events: [{ kind: 'agent-message', text: longEventText }],
    });

    expect(mail.bodyRedacted).toContain('[agent] <cwd>/big.ts');
    expect(mail.bodyRedacted).toContain('…[truncated ');
    expect(mail.bodyRedacted).not.toContain('/tmp/fixtures/wt-a');
  });

  it('wires the body cap: oldest events are dropped, the terminal region survives', () => {
    const events: DriverEvent[] = Array.from({ length: 25 }, (_, i) => ({
      kind: 'agent-message' as const,
      text: `m${String(i)} ${'. '.repeat(490)}`,
    }));

    const mail = composeResultReply(replyContext(), {
      verdict: 'DISPATCH_NEW',
      terminal: { kind: 'completed', resultText: 'ok' },
      events,
    });

    expect(mail.bodyRedacted.length).toBeLessThanOrEqual(BODY_TOTAL_CAP);
    expect(mail.bodyRedacted).toContain(' earlier events omitted]');
    expect(mail.bodyRedacted).not.toContain('m0 ');
    expect(mail.bodyRedacted).toContain('m24 ');
    expect(mail.bodyRedacted).toContain('✅ completed (DISPATCH_NEW)');
    expect(mail.bodyRedacted).toContain('result:\nok');
  });
});

describe('composer leakage canary (D-P4B9-4 — the plan-level canary: subject AND body)', () => {
  it('a fully poisoned outcome produces a clean subject and body', () => {
    const mail = composeResultReply(
      replyContext({ originalSubject: `deploy ${WORKTREE}/app` }),
      {
        verdict: 'DISPATCH_NEW',
        terminal: {
          kind: 'completed',
          resultText: `uploaded blob ${'a'.repeat(64)} from /tmp/fixtures/wt-a`,
        },
        events: [
          { kind: 'agent-message', text: 'wrote /tmp/fixtures/wt-a/deep/file.ts' },
          { kind: 'tool-activity', summary: 'read /tmp/fixtures/home-x/.ssh/id_rsa' },
          { kind: 'agent-message', text: 'Api_Key: Aa-Aa-Tok-0001' },
        ],
      },
    );

    expectCanaryClean(mail.subjectRedacted);
    expectCanaryClean(mail.bodyRedacted);
    expect(mail.subjectRedacted).toBe('Re: deploy <cwd>/app');
    expect(mail.bodyRedacted).toContain('[agent] wrote <cwd>/deep/file.ts');
    expect(mail.bodyRedacted).toContain('[tool] read <home>/.ssh/id_rsa');
    expect(mail.bodyRedacted).toContain('[agent] Api_Key: <redacted>');
    expect(mail.bodyRedacted).toContain('<redacted:64ch>');
  });

  it('a poisoned dispatch-failed reason is scrubbed and keeps its stage prefix verbatim', () => {
    const mail = composeDispatchFailedReply(replyContext(), {
      stage: 'WORKTREE',
      reason: `WORKTREE: git failed at ${WORKTREE} — token: Aa-Aa-Tok-0001`,
    });

    expectCanaryClean(mail.bodyRedacted);
    expect(mail.bodyRedacted).toContain('error:\nWORKTREE: git failed at <cwd> — token: <redacted>');
  });
});

describe('composeDispatchFailedReply (D-P4B9-3)', () => {
  it('renders the stage in the status line, no verdict line, no events region', () => {
    const mail = composeDispatchFailedReply(replyContext(), {
      stage: 'SESSION_STATE',
      reason: 'SESSION_STATE_INCOMPLETE',
    });

    expect(mail.kind).toBe('ERROR');
    expect(mail.commandId).toBe(42);
    expect(mail.bodyRedacted).toBe(
      [
        '❌ dispatch failed (SESSION_STATE)',
        '',
        'project: proj-a',
        'intent: intent-0001',
        '',
        'error:',
        'SESSION_STATE_INCOMPLETE',
      ].join('\n'),
    );
  });

  it('keeps the batch-8 stage-prefixed reason wording verbatim (WORKTREE_MISSING)', () => {
    const mail = composeDispatchFailedReply(replyContext(), {
      stage: 'WORKTREE',
      reason: 'WORKTREE_MISSING',
    });

    expect(mail.bodyRedacted).toContain('❌ dispatch failed (WORKTREE)');
    expect(mail.bodyRedacted).toContain('error:\nWORKTREE_MISSING');
  });

  // D-P4B11 stage-union extension (additive — the dispatch pipeline's own
  // three-valued union is untouched; these two members exist for the daemon):
  // 'EXTRACTION' = the mail's threadKey/prompt could not be extracted,
  // 'ROUTING' = the clarification stopgap's one-time cannot-route notice.
  it("renders the daemon's EXTRACTION stage like any other (additive union member)", () => {
    const mail = composeDispatchFailedReply(replyContext({ projectName: null }), {
      stage: 'EXTRACTION',
      reason: 'EXTRACTION_INCOMPLETE: missing prompt',
    });

    expect(mail.kind).toBe('ERROR');
    expect(mail.bodyRedacted).toContain('❌ dispatch failed (EXTRACTION)');
    expect(mail.bodyRedacted).toContain('error:\nEXTRACTION_INCOMPLETE: missing prompt');
    expect(mail.bodyRedacted).toContain('project: (unknown)');
  });

  it("renders the daemon's ROUTING stage with a names-only candidate reason (batch-9 discipline: never a path)", () => {
    const mail = composeDispatchFailedReply(replyContext(), {
      stage: 'ROUTING',
      reason: 'cannot route: ambiguous (2 candidates: proj-a, proj-alpha)',
    });

    expect(mail.kind).toBe('ERROR');
    expect(mail.bodyRedacted).toContain('❌ dispatch failed (ROUTING)');
    expect(mail.bodyRedacted).toContain(
      'error:\ncannot route: ambiguous (2 candidates: proj-a, proj-alpha)',
    );
    expect(mail.bodyRedacted).not.toContain('/tmp/fixtures');
  });
});

describe('composeDryRunReply (D-P4B9-3)', () => {
  it('DISPATCH_NEW: names the project, never its path', () => {
    const verdict: RouteVerdict = {
      kind: 'DISPATCH_NEW',
      project: { name: 'proj-a', path: '/tmp/fixtures/proj-a' },
    };

    const mail = composeDryRunReply(replyContext(), verdict);

    expect(mail.kind).toBe('RESULT');
    expect(mail.bodyRedacted).toContain('🔍 dry-run (DISPATCH_NEW)');
    expect(mail.bodyRedacted).toContain('verdict: DISPATCH_NEW');
    expect(mail.bodyRedacted).toContain("would dispatch a new agent session in project 'proj-a'");
    expect(mail.bodyRedacted).not.toContain('/tmp/fixtures/proj-a');
  });

  it('CONTINUE_SESSION: says it would resume, renders neither projectPath nor session id', () => {
    const verdict: RouteVerdict = {
      kind: 'CONTINUE_SESSION',
      session: {
        projectPath: '/tmp/fixtures/proj-a',
        driverSessionId: '00000000-0000-4000-8000-000000000001',
      },
    };

    const mail = composeDryRunReply(replyContext(), verdict);

    expect(mail.bodyRedacted).toContain('🔍 dry-run (CONTINUE_SESSION)');
    expect(mail.bodyRedacted).toContain('would resume the existing agent session');
    expect(mail.bodyRedacted).not.toContain('/tmp/fixtures/proj-a');
    expect(mail.bodyRedacted).not.toContain('00000000-0000-4000-8000-000000000001');
  });

  it('CLARIFY_AMBIGUOUS: lists candidate NAMES only — paths never appear', () => {
    const verdict: RouteVerdict = {
      kind: 'CLARIFY_AMBIGUOUS',
      candidates: [
        { name: 'proj-a', path: '/tmp/fixtures/proj-a' },
        { name: 'proj-b', path: '/tmp/fixtures/other-root/proj-b' },
      ],
    };

    const mail = composeDryRunReply(replyContext(), verdict);

    expect(mail.bodyRedacted).toContain('🔍 dry-run (CLARIFY_AMBIGUOUS)');
    expect(mail.bodyRedacted).toContain('would ask for clarification');
    expect(mail.bodyRedacted).toContain('- proj-a');
    expect(mail.bodyRedacted).toContain('- proj-b');
    expect(mail.bodyRedacted).not.toContain('/tmp/fixtures/proj-a');
    expect(mail.bodyRedacted).not.toContain('/tmp/fixtures/other-root');
    expect(mail.bodyRedacted).not.toContain('path');
  });

  it('CLARIFY_NO_MATCH: reports that nothing matched', () => {
    const mail = composeDryRunReply(replyContext(), { kind: 'CLARIFY_NO_MATCH' });

    expect(mail.kind).toBe('RESULT');
    expect(mail.bodyRedacted).toBe(
      [
        '🔍 dry-run (CLARIFY_NO_MATCH)',
        '',
        'project: proj-a',
        'intent: intent-0001',
        'verdict: CLARIFY_NO_MATCH',
        '',
        'plan:',
        'would ask for clarification — no project matched the given term.',
      ].join('\n'),
    );
  });
});

describe('composeAckReply (D-P4B9-3)', () => {
  it('renders status + meta only, kind ACK', () => {
    const mail = composeAckReply(replyContext(), { verdict: 'DISPATCH_NEW' });

    expect(mail.kind).toBe('ACK');
    expect(mail.commandId).toBe(42);
    expect(mail.bodyRedacted).toBe(
      [
        '📨 accepted (DISPATCH_NEW)',
        '',
        'project: proj-a',
        'intent: intent-0001',
        'verdict: DISPATCH_NEW',
      ].join('\n'),
    );
    expect(mail.bodyRedacted).not.toContain('events:');
    expect(mail.bodyRedacted).not.toContain('result:');
  });
});

describe('reply subject (D-P4B9-3)', () => {
  it('prefixes Re: when the original subject has none', () => {
    const mail = composeAckReply(replyContext({ originalSubject: 'build it' }), {
      verdict: 'DISPATCH_NEW',
    });

    expect(mail.subjectRedacted).toBe('Re: build it');
  });

  it('keeps an existing re: prefix verbatim — case-insensitive, multiples tolerated', () => {
    expect(
      composeAckReply(replyContext({ originalSubject: 're: build it' }), {
        verdict: 'DISPATCH_NEW',
      }).subjectRedacted,
    ).toBe('re: build it');
    expect(
      composeAckReply(replyContext({ originalSubject: 'RE: Re: build it' }), {
        verdict: 'DISPATCH_NEW',
      }).subjectRedacted,
    ).toBe('RE: Re: build it');
  });

  it('falls back to amb: task update when the original subject is null', () => {
    const mail = composeAckReply(replyContext({ originalSubject: null }), {
      verdict: 'DISPATCH_NEW',
    });

    expect(mail.subjectRedacted).toBe('amb: task update');
  });

  it('single-lines CR/LF and caps the subject at 200 chars', () => {
    expect(
      composeAckReply(replyContext({ originalSubject: 'fix\r\nthis\nnow' }), {
        verdict: 'DISPATCH_NEW',
      }).subjectRedacted,
    ).toBe('Re: fix this now');

    const long = 's '.repeat(125);
    const capped = composeAckReply(replyContext({ originalSubject: long }), {
      verdict: 'DISPATCH_NEW',
    }).subjectRedacted;
    expect(capped).toHaveLength(200);
    expect(capped).toBe(`Re: ${long}`.slice(0, 200));
  });

  it('scrubs a path embedded in the subject', () => {
    const mail = composeAckReply(replyContext({ originalSubject: `check ${WORKTREE}/x.ts` }), {
      verdict: 'DISPATCH_NEW',
    });

    expect(mail.subjectRedacted).toBe('Re: check <cwd>/x.ts');
  });

  it('single-lines BEFORE scrubbing: a newline-split keyword secret cannot dodge the mask (review I-1)', () => {
    // Scrub-then-single-line would let 'password:\n<value>' slip through:
    // the keyword regex's [^\S\n] guard (correct for multi-line BODIES)
    // does not bite across the newline, and the later CR/LF gluing would
    // reassemble 'password: <value>' INTO the sent subject. Single-lining
    // first means the glued form is what the scrub sees.
    expect(
      composeAckReply(replyContext({ originalSubject: 'password:\nhunter-low' }), {
        verdict: 'DISPATCH_NEW',
      }).subjectRedacted,
    ).toBe('Re: password: <redacted>');
    expect(
      composeAckReply(replyContext({ originalSubject: 'token=\r\nAa-Aa-Tok-0001' }), {
        verdict: 'DISPATCH_NEW',
      }).subjectRedacted,
    ).toBe('Re: token= <redacted>');
  });
});

describe('composeCoordinatorAnswerReply (ADR-0006 batch E — a meta-query answer)', () => {
  it('renders the free-text answer under an answer: region, kind RESULT, no verdict line', () => {
    const mail = composeCoordinatorAnswerReply(replyContext(), {
      text: 'there are two active sessions right now.',
    });

    expect(mail.kind).toBe('RESULT');
    expect(mail.commandId).toBe(42);
    expect(mail.bodyRedacted).toBe(
      [
        '💬 answer',
        '',
        'project: proj-a',
        'intent: intent-0001',
        '',
        'answer:',
        'there are two active sessions right now.',
      ].join('\n'),
    );
    // A meta-query answer is not a routing outcome — no verdict line.
    expect(mail.bodyRedacted).not.toContain('verdict:');
  });

  it('scrubs a worktree path leaked into the answer text', () => {
    const mail = composeCoordinatorAnswerReply(replyContext(), {
      text: `the worktree is at ${WORKTREE}/x.ts`,
    });

    expect(mail.bodyRedacted).toContain('the worktree is at <cwd>/x.ts');
    expect(mail.bodyRedacted).not.toContain(WORKTREE);
  });
});

describe('composeCoordinatorClarifyReply (ADR-0006 batch E — the coordinator disambiguates conversationally)', () => {
  it('renders the question under a question: region, kind CLARIFICATION, no verdict line', () => {
    const mail = composeCoordinatorClarifyReply(replyContext(), {
      question: 'which project did you mean, proj-a or proj-b?',
    });

    expect(mail.kind).toBe('CLARIFICATION');
    expect(mail.commandId).toBe(42);
    expect(mail.bodyRedacted).toBe(
      [
        '❓ clarification',
        '',
        'project: proj-a',
        'intent: intent-0001',
        '',
        'question:',
        'which project did you mean, proj-a or proj-b?',
      ].join('\n'),
    );
    expect(mail.bodyRedacted).not.toContain('verdict:');
  });

  it('lists options as bare dashes when provided', () => {
    const mail = composeCoordinatorClarifyReply(replyContext(), {
      question: 'which project did you mean?',
      options: ['proj-a', 'proj-b'],
    });

    expect(mail.bodyRedacted).toBe(
      [
        '❓ clarification',
        '',
        'project: proj-a',
        'intent: intent-0001',
        '',
        'question:',
        'which project did you mean?',
        '',
        'options:',
        '- proj-a',
        '- proj-b',
      ].join('\n'),
    );
  });

  it('scrubs a worktree path leaked into the question text', () => {
    const mail = composeCoordinatorClarifyReply(replyContext(), {
      question: `did you mean the task in ${WORKTREE}?`,
    });

    expect(mail.bodyRedacted).toContain('did you mean the task in <cwd>?');
    expect(mail.bodyRedacted).not.toContain(WORKTREE);
  });

  it('is structurally an OutboundMail despite the widened kind (transport seam)', () => {
    // CLARIFICATION is the kind ADR-0006 batch E adds to ComposedReplyKind;
    // this pins that the widened union stays assignable to OutboundMail
    // (kind narrowed to a subtype of OutboxKind) with no upward import.
    const mail: OutboundMail = composeCoordinatorClarifyReply(replyContext(), {
      question: 'which project?',
    });

    expect(mail.kind).toBe('CLARIFICATION');
  });
});

describe('composer products stay structurally compatible with the upper-layer seams', () => {
  it('a composer product IS an OutboundMail, and a DriverEvent[] feeds composeResultReply unchanged', () => {
    // The two type annotations are the compile-time pin for the local
    // re-declarations in replyComposition.ts (domain never imports from
    // transports/drivers, not even type-only — structural typing carries
    // the compatibility, and this test breaks if the shapes ever drift).
    const events: DriverEvent[] = [
      { kind: 'tool-activity', summary: 'probe' },
      { kind: 'completed', resultText: 'ok' },
    ];

    const mail: OutboundMail = composeResultReply(replyContext(), {
      verdict: 'CONTINUE_SESSION',
      terminal: { kind: 'completed', resultText: 'ok' },
      events,
    });

    expect(mail.kind).toBe('RESULT');
    expect(mail.commandId).toBe(42);
  });
});
