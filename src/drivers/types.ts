/**
 * Agent-driver seam (decision D-P3P-3, spec §3.1 "AgentDriver" extension
 * axis 2): the shape every coding-agent CLI backend implements. Written
 * once against this interface, `application/`'s dispatch use case (Phase 3,
 * batch outside this plan) never needs to know whether it is talking to
 * `codex exec --json` subprocesses or a future `claude-code` driver.
 * `tests/helpers/fakeAgentDriver.ts` is what every test written against
 * this interface drives until the real `codex` driver lands (P0-2-informed,
 * batch outside this plan) — the same relationship `transports/types.ts`
 * has to `tests/helpers/fakeTransport.ts`.
 *
 * Zero runtime imports (layering red line, D-P3P-5): this module is type
 * declarations only. Nothing that imports it — including the eventual
 * `codex` driver implementation, which must stay decoupled from
 * `application/`/`store/` — inherits any runtime dependency through this
 * file.
 *
 * Event-stream contract (binding on EVERY `AgentDriver` implementation,
 * fake and real alike — see `AgentDriver.streamEvents` below): a stream
 * yields zero or more `agent-message`/`tool-activity` events followed by
 * EXACTLY ONE terminal event (`completed` or `failed`), and that terminal
 * event is the LAST event of the stream — nothing may follow it.
 * `tests/helpers/fakeAgentDriver.ts` enforces this on its own scripts
 * (throwing when a script violates it) specifically so upper-layer tests
 * written against the fake self-verify they are driving a stream shape the
 * real driver is equally bound to produce.
 */

/** Static facts about one driver implementation — not per-task state. */
export interface DriverCapabilities {
  /** Whether `resumeTask` meaningfully continues a prior session for this
   *  driver, as opposed to always starting a fresh one. */
  supportsResume: boolean;
  agentName: string;
}

/** Everything a driver needs to run one agent task. */
export interface AgentTaskInput {
  prompt: string;
  cwd: string;
  dryRun: boolean;
}

/**
 * What `startTask`/`resumeTask` resolve to. `sessionId` is `null` when the
 * driver does not expose one for this task — the `codex exec --json`
 * session-id extraction semantics await the P0-2 spike, so a real driver
 * may legitimately return `null` until that lands.
 */
export interface AgentTaskHandle {
  sessionId: string | null;
}

/**
 * A minimal ACP-semantics projection of what a coding-agent subprocess can
 * report: a message from the agent, a tool-activity summary, or one of two
 * terminal outcomes. Deliberately minimal — P0-2's conclusions may extend
 * this union via a follow-up ADR. Adding a member is additive and does not
 * break existing consumers that only need to handle today's four kinds.
 */
export type DriverEvent =
  | { kind: 'agent-message'; text: string }
  | { kind: 'tool-activity'; summary: string }
  | { kind: 'completed'; resultText: string }
  | { kind: 'failed'; errorText: string };

/**
 * Extension axis 2 (spec §3.1): new coding-agent CLIs plug in here without
 * touching `domain/`, `application/`, or `store/`. `close` releases
 * whatever the driver is holding (e.g. a long-lived subprocess) and must
 * always be safe to call.
 */
export interface AgentDriver {
  capabilities(): DriverCapabilities;
  startTask(input: AgentTaskInput): Promise<AgentTaskHandle>;
  resumeTask(sessionId: string, input: AgentTaskInput): Promise<AgentTaskHandle>;
  /** See the module doc comment above for the single-terminal-event
   *  contract every returned stream must satisfy. */
  streamEvents(handle: AgentTaskHandle): AsyncIterable<DriverEvent>;
  close(): Promise<void>;
}
