# cli/

User-facing commands: `setup` wizard (5-minute hard target), `doctor`, `status`,
`pause` / `resume`, `logout`. Bin names: `agent-mail-bridge` and `amb` (decision D10).

- Does: onboarding, diagnostics and lifecycle control; the only module allowed
  to write to stdout/stderr directly.
- Used by: humans.
- Depends on: `application/`, `daemon/` installers.
