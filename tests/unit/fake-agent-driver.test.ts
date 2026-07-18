import { describe, expect, it } from 'vitest';

import type { AgentTaskHandle, AgentTaskInput, DriverEvent } from '../../src/drivers/types.js';
import {
  FakeAgentDriver,
  FakeAgentDriverStartFailure,
} from '../helpers/fakeAgentDriver.js';

// Guards decision D-P3P-3 (AgentDriver interface + fake): tests/helpers/fakeAgentDriver.ts
// is what every Phase-3-prework test that drives code written against AgentDriver
// uses instead of a real `codex exec --json` subprocess — the same relationship
// tests/helpers/fakeTransport.ts has to MailTransport. This file both tests the
// fake itself AND, by construction, documents/pins the AgentDriver contract
// (single trailing terminal event, deterministic session ids) that any real
// driver (codex, batch outside this plan) must also satisfy.

const MESSAGE_EVENT: DriverEvent = { kind: 'agent-message', text: 'looking at the repo' };
const TOOL_EVENT: DriverEvent = { kind: 'tool-activity', summary: 'ran pnpm test' };
const COMPLETED_EVENT: DriverEvent = { kind: 'completed', resultText: 'done' };
const FAILED_EVENT: DriverEvent = { kind: 'failed', errorText: 'boom' };

function taskInput(overrides: Partial<AgentTaskInput> = {}): AgentTaskInput {
  return {
    prompt: 'fix the failing test',
    cwd: '/repo/worktrees/task-1',
    dryRun: false,
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

/** Every handle this fake hands back from a successful start/resume carries
 *  a non-null sessionId; this narrows that for tests that need to feed it
 *  back into resumeTask without an `as` cast or a silent `?? ''`. */
function requireSessionId(handle: AgentTaskHandle): string {
  if (handle.sessionId === null) {
    throw new Error('expected FakeAgentDriver to return a non-null sessionId');
  }
  return handle.sessionId;
}

describe('FakeAgentDriver (D-P3P-3 fake)', () => {
  describe('scripted streaming', () => {
    it('yields a segment’s events in order, ending with the terminal event', async () => {
      const segment: DriverEvent[] = [MESSAGE_EVENT, TOOL_EVENT, COMPLETED_EVENT];
      const driver = new FakeAgentDriver([segment]);

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual(segment);
    });

    it('yields a failed-only segment (failed is a valid sole terminal event)', async () => {
      const driver = new FakeAgentDriver([[MESSAGE_EVENT, FAILED_EVENT]]);

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));

      expect(events).toEqual([MESSAGE_EVENT, FAILED_EVENT]);
    });
  });

  describe('terminal-event contract (validated eagerly at construction time)', () => {
    it('throws when a segment has no terminal event at all', () => {
      expect(() => new FakeAgentDriver([[MESSAGE_EVENT, TOOL_EVENT]])).toThrow(
        /no terminal event/,
      );
    });

    it('throws when a terminal event is followed by more events', () => {
      expect(() => new FakeAgentDriver([[COMPLETED_EVENT, MESSAGE_EVENT]])).toThrow(
        /must be last/,
      );
    });

    it('throws when a segment has two terminal events', () => {
      expect(() => new FakeAgentDriver([[COMPLETED_EVENT, FAILED_EVENT]])).toThrow(
        /2 terminal/,
      );
    });

    it('throws for an empty segment (zero events means zero terminal events)', () => {
      expect(() => new FakeAgentDriver([[]])).toThrow(/no terminal event/);
    });

    it('validates every segment at construction, before any task is started', () => {
      // segment 0 is valid; segment 1 is the broken one. If validation were
      // lazy (only checked when a segment is actually consumed/streamed),
      // this would not throw until a second startTask/resumeTask call. It
      // must throw immediately, from the constructor itself, naming the
      // offending segment.
      expect(() => new FakeAgentDriver([[COMPLETED_EVENT], [MESSAGE_EVENT]])).toThrow(
        /segment 1/,
      );
    });
  });

  describe('startTask / resumeTask call recording', () => {
    it('records every startTask input, in call order, echoed exactly', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT], [COMPLETED_EVENT]]);
      const first = taskInput({ prompt: 'first task' });
      const second = taskInput({ prompt: 'second task' });

      await driver.startTask(first);
      await driver.startTask(second);

      expect(driver.startTaskCalls).toEqual([first, second]);
    });

    it('records resumeTask sessionId and input together', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT]]);
      const input = taskInput({ prompt: 'continue the task' });

      await driver.resumeTask('prior-session-id', input);

      expect(driver.resumeTaskCalls).toEqual([{ sessionId: 'prior-session-id', input }]);
    });

    it('records multiple resumeTask calls in order', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT], [COMPLETED_EVENT]]);
      const firstInput = taskInput({ prompt: 'resume A' });
      const secondInput = taskInput({ prompt: 'resume B' });

      await driver.resumeTask('session-a', firstInput);
      await driver.resumeTask('session-b', secondInput);

      expect(driver.resumeTaskCalls).toEqual([
        { sessionId: 'session-a', input: firstInput },
        { sessionId: 'session-b', input: secondInput },
      ]);
    });
  });

  describe('failOnStart', () => {
    it('rejects startTask and consumes no script segment or session id', async () => {
      const segmentA: DriverEvent[] = [COMPLETED_EVENT];
      const segmentB: DriverEvent[] = [FAILED_EVENT];
      const driver = new FakeAgentDriver([segmentA, segmentB], { failOnStart: true });

      await expect(driver.startTask(taskInput())).rejects.toThrow(FakeAgentDriverStartFailure);

      // Proof the failed call consumed nothing: resumeTask (unaffected by
      // failOnStart) still draws segment 0 under the FIRST session id.
      const handle = await driver.resumeTask('irrelevant-prior-session', taskInput());
      expect(handle.sessionId).toBe('fake-session-1');
      await expect(collect(driver.streamEvents(handle))).resolves.toEqual(segmentA);
    });

    it('rejects every startTask call, not just the first', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT]], { failOnStart: true });

      await expect(driver.startTask(taskInput())).rejects.toThrow(FakeAgentDriverStartFailure);
      await expect(driver.startTask(taskInput())).rejects.toThrow(FakeAgentDriverStartFailure);
    });

    it('still records the attempted input even though the call rejects', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT]], { failOnStart: true });
      const input = taskInput({ prompt: 'attempted but never starts' });

      await expect(driver.startTask(input)).rejects.toThrow();

      expect(driver.startTaskCalls).toEqual([input]);
    });
  });

  describe('sessionId determinism', () => {
    it('increments deterministically across multiple startTask calls', async () => {
      const script = [[COMPLETED_EVENT], [COMPLETED_EVENT], [COMPLETED_EVENT]];
      const driver = new FakeAgentDriver(script);

      const first = await driver.startTask(taskInput());
      const second = await driver.startTask(taskInput());
      const third = await driver.startTask(taskInput());

      expect([first.sessionId, second.sessionId, third.sessionId]).toEqual([
        'fake-session-1',
        'fake-session-2',
        'fake-session-3',
      ]);
    });

    it('shares one counter and one script cursor between startTask and resumeTask', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT], [COMPLETED_EVENT]]);

      const first = await driver.startTask(taskInput());
      const second = await driver.resumeTask(requireSessionId(first), taskInput());

      expect([first.sessionId, second.sessionId]).toEqual(['fake-session-1', 'fake-session-2']);
    });
  });

  describe('capabilities()', () => {
    it('round-trips agentName and supportsResume from constructor options', () => {
      const driver = new FakeAgentDriver([], { agentName: 'fake-codex', supportsResume: false });

      expect(driver.capabilities()).toEqual({ agentName: 'fake-codex', supportsResume: false });
    });

    it('defaults to a placeholder agentName and supportsResume: true when options are omitted', () => {
      const driver = new FakeAgentDriver([]);

      expect(driver.capabilities()).toEqual({ agentName: 'fake-agent', supportsResume: true });
    });
  });

  describe('script exhaustion', () => {
    it('throws when startTask is called with no script segments left', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT]]);
      await driver.startTask(taskInput());

      await expect(driver.startTask(taskInput())).rejects.toThrow(/exhausted/);
    });

    it('throws when resumeTask is called against an empty script', async () => {
      const driver = new FakeAgentDriver([]);

      await expect(driver.resumeTask('some-session', taskInput())).rejects.toThrow(/exhausted/);
    });

    it('charges startTask and resumeTask calls against the same shared budget', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT]]);
      await driver.startTask(taskInput());

      await expect(driver.resumeTask('some-session', taskInput())).rejects.toThrow(/exhausted/);
    });
  });

  describe('streamEvents misuse', () => {
    it('throws for a handle whose sessionId this instance never issued', () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT]]);

      expect(() => driver.streamEvents({ sessionId: 'never-issued' })).toThrow(
        /no scripted segment/,
      );
    });

    it('throws for a null sessionId', () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT]]);

      expect(() => driver.streamEvents({ sessionId: null })).toThrow(/no scripted segment/);
    });

    // Fake-only affordance, pinned so nobody "fixes" it into an error (and
    // so nobody mistakes it for real-driver behavior — a subprocess stream
    // cannot generally be replayed; see the streamEvents doc comment).
    it('replays the full segment from the start when called again with the same handle', async () => {
      const segment: DriverEvent[] = [MESSAGE_EVENT, COMPLETED_EVENT];
      const driver = new FakeAgentDriver([segment]);
      const handle = await driver.startTask(taskInput());

      const first = await collect(driver.streamEvents(handle));
      const second = await collect(driver.streamEvents(handle));

      expect(first).toEqual(segment);
      expect(second).toEqual(segment);
    });
  });

  describe('close', () => {
    it('resolves', async () => {
      const driver = new FakeAgentDriver([]);

      await expect(driver.close()).resolves.toBeUndefined();
    });

    // Pins the documented divergence from a real driver: this fake's close()
    // does NOT invalidate the instance (see its doc comment).
    it('does not invalidate the instance — startTask and streamEvents still work after close', async () => {
      const driver = new FakeAgentDriver([[COMPLETED_EVENT]]);

      await driver.close();

      const handle = await driver.startTask(taskInput());
      const events = await collect(driver.streamEvents(handle));
      expect(events).toEqual([COMPLETED_EVENT]);
    });
  });
});
