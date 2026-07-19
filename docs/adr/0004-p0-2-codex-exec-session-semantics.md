# ADR-0004: P0-2 codex exec session semantics — Go for CodexDriver

- Status: accepted (2026-07-19)
- Deciders: bridge maintainers
- Related: spec §5 P0-2 / P0-4, D6 (driver seam); `src/drivers/types.ts`
  (AgentDriver contract, batch-1); AGENTS.md engineering red line (no
  `danger-full-access`, no `--dangerously-bypass-*`)
- Toolchain: codex CLI upgraded 0.140.0 → 0.144.6 (user-authorized,
  2026-07-19) — 0.140.0 was hard-blocked (default model → HTTP 400
  "requires a newer version of Codex").

## Context

Phase 4 dispatch needs: extract a session identity from a non-interactive
`codex exec` run, resume that session later (mail thread ↔ agent session
mapping, C8), and map process outcomes onto the `AgentDriver` seam's
terminal-event contract. All previously blocked on the CLI version.

## Evidence (2026-07-19, three runs; metered cost: 23 output tokens total)

1. **Event stream & id extraction** (`codex exec --json <prompt>`): stdout
   is pure JSONL. Typed events observed:
   `thread.started {thread_id}` → `turn.started` → `item.completed {item}`
   × N → `turn.completed {usage}`. The session id is
   `thread.started.thread_id` (UUID) — no regex scraping needed. The final
   answer is the `item.completed` whose `item.type === "agent_message"`
   (`item.text`). Config/deprecation noise arrives as NON-terminal
   `item.type === "error"` items (observed: hooks deprecation, skills
   context-budget warning) — a driver MUST tolerate them without failing
   the run.
2. **Resume** (`codex exec resume <uuid> --json <prompt>`): context is
   retained (a nonce memorized in run 1 was recalled verbatim), and
   `thread.started` re-emits the SAME thread_id — session identity is
   stable across resumes, so `thread_id` is the right value to persist for
   thread↔session mapping. Usage shows prompt caching on resume (27k of
   36k input tokens cached).
3. **Failure semantics** (resume with a bogus UUID): exit code 1, EMPTY
   stdout (zero events), stderr carries a parseable
   `thread/resume failed: no rollout found for thread id … (code -32600)`.
   Maps directly onto the batch-1 AgentDriver crash contract: no terminal
   event observed ⇒ the driver synthesizes `failed`.

### Option-surface asymmetry (driver-relevant)

- `codex exec` accepts `--sandbox <mode>`; **`codex exec resume` does
  NOT** — the sandbox is fixed at session creation and rides along on
  resume. The driver therefore sets `--sandbox workspace-write` (C6
  ceiling) on the INITIAL exec only.
- Both accept `--json`, `--skip-git-repo-check`, `-m`, `-c`,
  `--output-last-message`, `--ephemeral`.
- `--ephemeral` skips session persistence ⇒ NOT resumable ⇒ the daemon's
  dispatches must never use it (probes may).
- stdin: when not a TTY, codex announces reading stdin — the driver spawns
  with stdin closed and passes the prompt as an argv argument.
- `resume --last` exists but the driver uses explicit ids only
  (deterministic mapping, no "most recent" ambiguity).

## Decision

**Go** for `CodexDriver` on the existing `AgentDriver` seam:

- spawn `codex exec --json --sandbox workspace-write -C <worktree>` (never
  the forbidden bypass flags), parse JSONL, persist
  `thread.started.thread_id`;
- continue a mail thread via `codex exec resume <thread_id> --json`;
- synthesize `failed` when the process exits without a terminal event
  (empty stdout included); treat `item.type=error` items as diagnostics.

**P0-4 (connector reserve) is not pursued**: its purpose was a fallback if
codex driving proved infeasible; with P0-2 green it would be dead scope.
Revisit only if real-task E2E (red line 5, user-gated) fails.

## Consequences

- The CodexDriver implementation batch is unblocked and unit-testable
  without model quota (scripted subprocess fake per the batch-1 seam).
- Real-task E2E (codex actually executing a coding task) still requires a
  quota estimate + user confirmation first (red line 5).
- The measured event vocabulary becomes the driver's parsing contract;
  unknown event types must be tolerated (forward compatibility), missing
  terminal events must fail closed.

## Reproduction steps

```sh
codex exec --json --skip-git-repo-check -s read-only "记住暗号 <nonce>。只回复: 已记住"
# → note thread.started.thread_id in the JSONL
codex exec resume <thread_id> --json --skip-git-repo-check "刚才的暗号是什么？"
# → same thread_id re-emitted; nonce recalled
codex exec resume 00000000-0000-0000-0000-000000000000 --json --skip-git-repo-check "任意"
# → exit 1, empty stdout, stderr "no rollout found … (code -32600)"
```
