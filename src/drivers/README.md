# drivers/

`AgentDriver` interface (`startTask` / `resumeTask` / `streamEvents` / `capabilities`)
and its implementations. First implementation: `codex` via `codex exec --json` /
`codex exec resume` subprocesses. Future: `claude-code`. Event model aligns with
ACP semantics.

- Does: run coding-agent tasks and surface their events; enforces the sandbox
  ceiling (`workspace-write`, never `danger-full-access`).
- Used by: `application/` (dispatch).
- Depends on: agent CLIs as external systems; never on `transports/`.

New agents plug in here without touching the core (extension axis 2).
