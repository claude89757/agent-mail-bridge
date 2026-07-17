# Operations

> Status: skeleton — this document is filled in Phase 5 (productization).
> Listed now so the surface area is fixed early.

Will cover:

- **Install / run**: `npx agent-mail-bridge setup` wizard; launchd (macOS) and
  systemd user unit (Linux) templates from `resources/`.
- **Health**: `amb doctor` — connectivity, DKIM self-check, clock skew, Codex
  CLI version, permission bits, worktree root.
- **Lifecycle**: `amb status` / `pause` / `resume` / `logout`.
- **Logs**: redacted by design, rotated; location and retention documented here.
- **Uninstall order**: stop daemon → remove service unit → remove credentials
  from keychain → remove state directory → remove package. Each step verifiable.
