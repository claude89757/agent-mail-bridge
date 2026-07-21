import { describe, expect, it } from 'vitest';

import type { SpawnCodex, SpawnedCodex } from '../../src/drivers/codexDriver.js';
import {
  COORDINATOR_SANDBOX_MODE,
  createCoordinatorDriver,
  type CoordinatorRunInput,
} from '../../src/drivers/coordinatorDriver.js';

// Guards the coordination layer's batch-C driver (ADR-0006). The coordinator
// runs ONE read-only codex turn and returns a structured CoordinatorDecision,
// or fails closed so the caller can fall back to the deterministic router.
// Every branch is exercised against a SCRIPTED fake codex (zero model quota):
// the real carrier — whether read-only + MCP + --output-schema compose, and
// whether the final decision arrives on the stream vs needs
// --output-last-message — is the batch-D spike, gated on red line 5.
//
// Fixture discipline: synthetic placeholder ids/paths only; the one crash
// fixture deliberately puts a fake absolute path in stderr to prove red-line-2
// scrubbing keeps it out of the failure reason.

const SCHEMA_PATH = '/tmp/fixtures/schema/coordinator-decision.json';
const CWD = '/tmp/fixtures/coord';
const VALID_SESSION_ID = '00000000-0000-4000-8000-000000000001';

/** One captured spawn call plus a scripted process. */
interface Recorded {
  argv: readonly string[];
  cwd: string;
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** Codex JSONL for a completed turn whose final agent_message is `finalText`. */
function completedTurn(finalText: string, sessionId = VALID_SESSION_ID): string[] {
  return [
    line({ type: 'thread.started', thread_id: sessionId }),
    line({ type: 'item.completed', item: { type: 'agent_message', text: finalText } }),
    line({ type: 'turn.completed' }),
  ];
}

/** Wraps a decision in the `{"decision": {...}}` envelope codex emits under
 *  `--output-schema` (ADR-0007) — the shape the driver unwraps. Returned as a
 *  JSON string, ready to be the agent_message text. */
function envelope(decision: unknown): string {
  return line({ decision });
}

/** Builds a fake SpawnCodex over a scripted process, recording the argv/cwd
 *  it was called with so argv-discipline can be asserted. */
function fakeDriver(script: {
  stdout?: string[];
  stderr?: string;
  code?: number | null;
}): { run: ReturnType<typeof createCoordinatorDriver>; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const spawnCodex: SpawnCodex = (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd });
    const spawned: SpawnedCodex = {
      stdout: (async function* () {
        for (const l of script.stdout ?? []) {
          yield l;
        }
      })(),
      stderr: Promise.resolve(script.stderr ?? ''),
      exited: Promise.resolve({ code: script.code ?? 0 }),
      kill() {
        /* no-op for the fake */
      },
    };
    return spawned;
  };
  return { run: createCoordinatorDriver({ spawnCodex }), calls };
}

const NEW_INPUT: CoordinatorRunInput = { prompt: 'ship the blog', cwd: CWD, schemaPath: SCHEMA_PATH };

describe('createCoordinatorDriver (ADR-0006, coordination batch C)', () => {
  describe('happy path — a valid final message becomes a decision', () => {
    it('parses a dispatch decision and returns the captured session id', async () => {
      const { run } = fakeDriver({
        stdout: completedTurn(envelope({ kind: 'dispatch', projectAlias: 'blog', prompt: 'ship it', mode: 'new' })),
      });
      const outcome = await run(NEW_INPUT);
      expect(outcome).toEqual({
        kind: 'decided',
        decision: { kind: 'dispatch', projectAlias: 'blog', prompt: 'ship it', mode: 'new' },
        sessionId: VALID_SESSION_ID,
      });
    });

    it('parses a clarify decision (read-only, no execution)', async () => {
      const { run } = fakeDriver({
        stdout: completedTurn(envelope({ kind: 'clarify', question: 'which project?', options: ['blog', 'api'] })),
      });
      const outcome = await run(NEW_INPUT);
      expect(outcome).toEqual({
        kind: 'decided',
        decision: { kind: 'clarify', question: 'which project?', options: ['blog', 'api'] },
        sessionId: VALID_SESSION_ID,
      });
    });

    it('parses an answer decision (meta-query reply)', async () => {
      const { run } = fakeDriver({
        stdout: completedTurn(envelope({ kind: 'answer', text: 'you have 2 projects: blog, api' })),
      });
      const outcome = await run(NEW_INPUT);
      expect(outcome).toEqual({
        kind: 'decided',
        decision: { kind: 'answer', text: 'you have 2 projects: blog, api' },
        sessionId: VALID_SESSION_ID,
      });
    });
  });

  describe('argv discipline (the security-load-bearing part)', () => {
    it('runs read-only + headless-isolated, passes --output-schema, never a dangerous or write flag', async () => {
      const { run, calls } = fakeDriver({ stdout: completedTurn(envelope({ kind: 'answer', text: 'ok' })) });
      await run(NEW_INPUT);
      const argv = calls[0]?.argv ?? [];
      // read-only sandbox, positively asserted for the new-turn path
      const sandboxIdx = argv.indexOf('--sandbox');
      expect(sandboxIdx).toBeGreaterThanOrEqual(0);
      expect(argv[sandboxIdx + 1]).toBe(COORDINATOR_SANDBOX_MODE);
      expect(COORDINATOR_SANDBOX_MODE).toBe('read-only');
      // headless isolation (batch-D spike, ADR-0007): non-git cwd, clean config,
      // no interactive approval — none of these relax the sandbox
      expect(argv).toContain('--skip-git-repo-check');
      expect(argv).toContain('--ignore-user-config');
      const approvalIdx = argv.indexOf('approval_policy="never"');
      expect(approvalIdx).toBeGreaterThan(0);
      expect(argv[approvalIdx - 1]).toBe('-c');
      // structured output schema present, pointing at the caller's file
      const schemaIdx = argv.indexOf('--output-schema');
      expect(schemaIdx).toBeGreaterThanOrEqual(0);
      expect(argv[schemaIdx + 1]).toBe(SCHEMA_PATH);
      // the prompt is the final positional token
      expect(argv[argv.length - 1]).toBe('ship the blog');
      // never workspace-write, never any bypass
      expect(argv).not.toContain('workspace-write');
      expect(argv).not.toContain('danger-full-access');
      expect(argv.some((a) => a.startsWith('--dangerously-bypass'))).toBe(false);
      // spawned in the caller's cwd
      expect(calls[0]?.cwd).toBe(CWD);
    });

    it('injects extraArgs ahead of the prompt (a generic seam — MCP config rides here if re-added)', async () => {
      const extraArgs = ['-c', 'model_reasoning_effort="low"'];
      const { run, calls } = fakeDriver({ stdout: completedTurn(envelope({ kind: 'answer', text: 'ok' })) });
      await run({ ...NEW_INPUT, extraArgs });
      const argv = calls[0]?.argv ?? [];
      expect(argv).toContain('model_reasoning_effort="low"');
      // still before the trailing prompt
      expect(argv.indexOf('model_reasoning_effort="low"')).toBeLessThan(argv.length - 1);
    });

    it('resumes via `exec resume <id>` WITHOUT a --sandbox flag (codex 0.144.6 asymmetry, ADR-0004)', async () => {
      const { run, calls } = fakeDriver({ stdout: completedTurn(envelope({ kind: 'answer', text: 'ok' })) });
      await run({ ...NEW_INPUT, resumeSessionId: VALID_SESSION_ID, extraArgs: ['-c', 'x=y'] });
      const argv = calls[0]?.argv ?? [];
      expect(argv.slice(0, 3)).toEqual(['exec', 'resume', VALID_SESSION_ID]);
      expect(argv).not.toContain('--sandbox');
      expect(argv).toContain('--output-schema');
      // resume still carries the headless isolation flags; read-only for resume
      // rides on config (extraArgs), pending a resume-specific spike (batch E/F)
      expect(argv).toContain('--skip-git-repo-check');
      expect(argv).toContain('--ignore-user-config');
      expect(argv).toContain('-c');
      expect(argv[argv.length - 1]).toBe('ship the blog');
    });

    it('refuses a non-UUID resume id before spawning (argv-injection guard)', async () => {
      const { run, calls } = fakeDriver({ stdout: [] });
      await expect(run({ ...NEW_INPUT, resumeSessionId: '--last' })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });
  });

  describe('fail closed (the caller falls back to the deterministic router)', () => {
    it('fails closed when the final message is not valid JSON', async () => {
      const { run } = fakeDriver({ stdout: completedTurn('I think you should ship the blog!') });
      const outcome = await run(NEW_INPUT);
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.reason).toMatch(/json/i);
      }
    });

    it('fails closed when the JSON is not a valid decision', async () => {
      const { run } = fakeDriver({ stdout: completedTurn(envelope({ kind: 'launch_missiles' })) });
      const outcome = await run(NEW_INPUT);
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.reason).toMatch(/decision/i);
      }
    });

    it('fails closed when the turn completes with no agent message', async () => {
      const { run } = fakeDriver({
        stdout: [line({ type: 'thread.started', thread_id: VALID_SESSION_ID }), line({ type: 'turn.completed' })],
      });
      const outcome = await run(NEW_INPUT);
      expect(outcome.kind).toBe('failed');
    });

    it('fails closed on a crash (no terminal event) and scrubs local paths from the reason (red line 2)', async () => {
      const { run } = fakeDriver({
        stdout: [line({ type: 'thread.started', thread_id: VALID_SESSION_ID })],
        stderr: `boom in ${CWD}/secret-file.ts`,
        code: 1,
      });
      const outcome = await run(NEW_INPUT);
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.reason).not.toContain(CWD);
        expect(outcome.reason).toContain('<cwd>');
      }
    });

    it('fails closed when stdout throws mid-stream (broken pipe) with no terminal', async () => {
      const calls: Recorded[] = [];
      const spawnCodex: SpawnCodex = (argv, opts) => {
        calls.push({ argv, cwd: opts.cwd });
        return {
          stdout: (async function* () {
            yield line({ type: 'thread.started', thread_id: VALID_SESSION_ID });
            throw new Error('stream broke');
          })(),
          stderr: Promise.resolve(''),
          exited: Promise.resolve({ code: null }),
          kill() {
            /* no-op */
          },
        };
      };
      const run = createCoordinatorDriver({ spawnCodex });
      const outcome = await run(NEW_INPUT);
      expect(outcome.kind).toBe('failed');
    });
  });
});
