/**
 * Scripted `AgentDriver` fake (D-P3P-3). Every Phase-3-prework test that
 * needs to drive code written against `AgentDriver` uses this instead of a
 * real `codex exec --json` subprocess — the same relationship
 * `fakeTransport.ts` has to `MailTransport`.
 *
 * Scripting model: the constructor takes `script: DriverEvent[][]`, one
 * segment per expected task. `startTask` and `resumeTask` share a SINGLE
 * cursor into `script` — each successful call (of either method, in call
 * order) consumes the next unconsumed segment and hands it to
 * `streamEvents` under a freshly minted `sessionId`. Calling either method
 * more times than there are segments is always a test-fixture bug, not a
 * state this fake models: it throws loudly (see `consumeNextSegment`)
 * rather than returning an empty stream or looping the script back to the
 * start.
 *
 * Terminal-event contract — WHEN it is validated (deliberate choice): every
 * segment in `script` is checked for the interface's single-terminal-event
 * contract (`types.ts`: exactly one `completed`/`failed` event, and it must
 * be the LAST event) EAGERLY, in the constructor, over the ENTIRE script
 * array — not lazily as each segment is later streamed. A malformed segment
 * therefore throws at `new FakeAgentDriver(script)` itself, i.e. at the
 * test's own fixture-construction call site, before any application code
 * under test has run at all.
 *
 * This is deliberately the stricter of the two options available: a REAL
 * driver could only ever validate lazily — it cannot know a subprocess's
 * future output in advance, so the earliest it could notice "no terminal
 * event ever arrived" is when the underlying process exits. This fake CAN
 * validate upfront, because the whole script is supplied synchronously in
 * one array, and spending that extra knowledge to fail at construction
 * time is what makes the fake useful for self-verifying upper-layer tests:
 * a bad fixture fails with a stack trace pointing straight at the literal
 * array in the test file, instead of surfacing later — possibly out of
 * order, possibly swallowed — inside whatever `for await` loop in
 * application code happens to consume the stream.
 *
 * Tradeoff: because this fake is strictly stricter than any real
 * `AgentDriver` could be forced to be, it cannot itself be used to test how
 * upper-layer code reacts to a driver that produces a malformed stream at
 * RUNTIME (as opposed to a malformed test fixture). That scenario needs a
 * hand-rolled `AgentDriver` stub, not this fake — this fake's job is to be
 * a trustworthy, well-behaved script player, not to simulate driver bugs.
 */
import type {
  AgentDriver,
  AgentTaskHandle,
  AgentTaskInput,
  DriverCapabilities,
  DriverEvent,
} from '../../src/drivers/types.js';

export interface FakeAgentDriverOptions {
  /** Default: `'fake-agent'`. Round-trips verbatim through `capabilities()`. */
  agentName?: string;
  /** Default: `true`. Purely descriptive metadata — this fake does not
   *  enforce it (e.g. `resumeTask` stays callable even when `false`); any
   *  enforcement is an application-layer concern, per the locked interface
   *  not defining one. */
  supportsResume?: boolean;
  /** Default: `false`. See the `startTask` doc comment below. */
  failOnStart?: boolean;
}

function isTerminalEvent(event: DriverEvent): boolean {
  return event.kind === 'completed' || event.kind === 'failed';
}

/**
 * Throws unless `segment` contains EXACTLY ONE terminal event (`completed`
 * or `failed`) and it is the LAST event in the segment. Covers all three
 * contract violations the interface forbids with one scan: zero terminal
 * events, a terminal event with events after it, and two-or-more terminal
 * events (whether or not the last one happens to be at the end).
 */
function assertSingleTrailingTerminal(
  segment: readonly DriverEvent[],
  segmentIndex: number,
): void {
  const terminalPositions: number[] = [];
  segment.forEach((event, index) => {
    if (isTerminalEvent(event)) {
      terminalPositions.push(index);
    }
  });

  if (terminalPositions.length === 0) {
    throw new Error(
      `FakeAgentDriver: script segment ${segmentIndex} has no terminal event — every segment ` +
        `must end with exactly one 'completed' or 'failed' event (see src/drivers/types.ts's ` +
        `DriverEvent stream contract).`,
    );
  }
  if (terminalPositions.length > 1) {
    throw new Error(
      `FakeAgentDriver: script segment ${segmentIndex} has ${terminalPositions.length} ` +
        `terminal events (at positions ${terminalPositions.join(', ')}) — a stream may end ` +
        `with exactly one.`,
    );
  }

  const terminalIndex = terminalPositions[0];
  if (terminalIndex !== segment.length - 1) {
    throw new Error(
      `FakeAgentDriver: script segment ${segmentIndex}'s terminal event is at position ` +
        `${String(terminalIndex)} but the segment has ${segment.length} events — the terminal ` +
        `event must be last.`,
    );
  }
}

async function* streamSegment(segment: readonly DriverEvent[]): AsyncGenerator<DriverEvent> {
  for (const event of segment) {
    yield event;
  }
}

/** Deterministic error `startTask` rejects with under the `failOnStart` option. */
export class FakeAgentDriverStartFailure extends Error {
  constructor() {
    super('FakeAgentDriver: startTask failed (failOnStart option is set)');
    this.name = 'FakeAgentDriverStartFailure';
  }
}

export class FakeAgentDriver implements AgentDriver {
  /** Every `AgentTaskInput` passed to `startTask`, in call order — recorded
   *  BEFORE the failOnStart/exhaustion checks run, so a call that goes on
   *  to reject is still recorded (a test asserting "the driver was invoked
   *  with X" should not first have to know whether that call succeeded). */
  readonly startTaskCalls: AgentTaskInput[] = [];
  /** Every `resumeTask` call, in order, as `{ sessionId, input }` — the
   *  `sessionId` here is the ARGUMENT the caller passed in (the session
   *  being resumed), not the fresh id the call mints for its return value. */
  readonly resumeTaskCalls: Array<{ sessionId: string; input: AgentTaskInput }> = [];

  private readonly script: readonly (readonly DriverEvent[])[];
  private readonly capabilitiesValue: DriverCapabilities;
  private readonly failOnStart: boolean;
  private readonly segmentBySessionId = new Map<string, readonly DriverEvent[]>();
  private nextScriptIndex = 0;
  private sessionCounter = 0;

  constructor(script: readonly (readonly DriverEvent[])[], options: FakeAgentDriverOptions = {}) {
    script.forEach((segment, index) => {
      assertSingleTrailingTerminal(segment, index);
    });

    this.script = script;
    this.capabilitiesValue = {
      agentName: options.agentName ?? 'fake-agent',
      supportsResume: options.supportsResume ?? true,
    };
    this.failOnStart = options.failOnStart ?? false;
  }

  capabilities(): DriverCapabilities {
    return this.capabilitiesValue;
  }

  /**
   * When `failOnStart` is set, EVERY call rejects with
   * `FakeAgentDriverStartFailure` — modeling "this driver's binary/transport
   * is unavailable", not "the Nth call happens to fail". Because the task
   * never started, a rejected call consumes NO script segment and mints NO
   * session id: the shared cursor and counter are left exactly as if the
   * call had never happened (see the `failOnStart` tests, which prove this
   * via a subsequent `resumeTask` still drawing segment 0 / session 1).
   * There is no way to make only some `startTask` calls fail — add a
   * `failOnStart`-sibling option via the same pattern if a future test
   * needs finer-grained control.
   */
  async startTask(input: AgentTaskInput): Promise<AgentTaskHandle> {
    this.startTaskCalls.push(input);

    if (this.failOnStart) {
      throw new FakeAgentDriverStartFailure();
    }

    return this.consumeNextSegment();
  }

  /**
   * `sessionId` is recorded into `resumeTaskCalls` verbatim but is NOT
   * echoed back as the returned handle's `sessionId` — real resume
   * session-id semantics (does resuming keep the same id? mint a chained
   * one?) await the P0-2 spike (see `AgentTaskHandle`'s doc comment in
   * `types.ts`). Rather than guess at unconfirmed real-driver behavior,
   * this fake always mints a fresh id from the same counter `startTask`
   * uses — the simplest deterministic choice available today.
   */
  async resumeTask(sessionId: string, input: AgentTaskInput): Promise<AgentTaskHandle> {
    this.resumeTaskCalls.push({ sessionId, input });

    return this.consumeNextSegment();
  }

  /**
   * Validates the handle synchronously (throws immediately on an unknown
   * or null sessionId, before any iteration happens) and only THEN returns
   * an async generator over the matching segment. Splitting it this way —
   * rather than making `streamEvents` itself an `async function*` — means a
   * caller that never iterates the result still gets the "this handle is
   * bogus" failure right at the `streamEvents(...)` call site, instead of
   * only on first `.next()`.
   *
   * Calling `streamEvents` AGAIN with the same handle REPLAYS the segment
   * from the start (the sessionId→segment mapping is never deleted, and
   * each call builds an independent generator with its own cursor). That
   * is a fake-only affordance — a real driver's subprocess stream cannot
   * generally be replayed — so upper-layer code must not come to rely on
   * it; it exists because deleting the mapping would turn a benign
   * double-read in a test into a confusing "unknown handle" error.
   */
  streamEvents(handle: AgentTaskHandle): AsyncIterable<DriverEvent> {
    const segment =
      handle.sessionId === null ? undefined : this.segmentBySessionId.get(handle.sessionId);
    if (segment === undefined) {
      throw new Error(
        `FakeAgentDriver.streamEvents: no scripted segment for sessionId ` +
          `${String(handle.sessionId)} — pass back a handle this same instance's ` +
          `startTask/resumeTask returned.`,
      );
    }
    return streamSegment(segment);
  }

  /**
   * No real subprocess to release. Deliberately does NOT invalidate the
   * instance either: `startTask`/`resumeTask`/`streamEvents` keep working
   * after `close()` — the same semantics the real driver settled on
   * (`src/drivers/codexDriver.ts`: close kills still-running subprocesses
   * and releases them, but the instance stays usable and every buffered
   * handle stays replayable).
   */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Shared consumption path for `startTask`/`resumeTask`: pulls the next
   * unconsumed segment off the single script cursor, mints the next
   * deterministic sessionId (`fake-session-1`, `fake-session-2`, ... —
   * never randomness or the clock, so assertions stay reproducible), and
   * remembers the mapping for `streamEvents`.
   *
   * Exhaustion (cursor has run past the end of `script`) throws loudly
   * rather than returning an empty stream or wrapping around: a scripted
   * fake never invents events, so a call past the end of the script is
   * always a test giving the fake too few segments for how many times it
   * drives startTask/resumeTask — surfacing that immediately, with a count,
   * is more useful than silently handing back nothing.
   */
  private consumeNextSegment(): AgentTaskHandle {
    const segment = this.script[this.nextScriptIndex];
    if (segment === undefined) {
      throw new Error(
        `FakeAgentDriver: script exhausted — startTask/resumeTask was called for the ` +
          `${this.nextScriptIndex + 1}th time, but only ${this.script.length} segment(s) were ` +
          `given to the constructor. Give the fake one segment per expected startTask/` +
          `resumeTask call.`,
      );
    }

    this.nextScriptIndex += 1;
    this.sessionCounter += 1;
    const sessionId = `fake-session-${this.sessionCounter}`;
    this.segmentBySessionId.set(sessionId, segment);
    return { sessionId };
  }
}
