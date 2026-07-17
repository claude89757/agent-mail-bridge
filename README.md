# agent-mail-bridge

[![CI](https://github.com/claude89757/agent-mail-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/claude89757/agent-mail-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Email is the universal, firewall-friendly async transport for AI agents.**

Control the coding agent on your own device from your own mailbox: send
yourself an ordinary email from your phone, a local daemon picks it up over
IMAP IDLE, runs the task with Codex in an isolated git worktree, and mails the
result back to you. No vendor cloud, no relay server, no port forwarding —
your mail provider is the only intermediary.

> **Status: pre-release skeleton (Phase 0).** The design is complete and the
> engineering scaffold is in place; the pipeline is being built phase by phase.
> Roadmap and design decisions:
> [docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md](docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md)

## Why email?

- Works through corporate firewalls and NAT — if your mail syncs, your agent
  is reachable.
- Asynchronous by nature: fire a task from your phone, get the result when
  it's done.
- Your provider's DKIM infrastructure gives cryptographic sender verification
  that ad-hoc relay channels don't have.

## Security first

Security and privacy documents are headline features, not appendices:
[threat model](docs/threat-model.md) · [security](docs/security.md) ·
[privacy](docs/privacy.md).

Highlights: DKIM-verified self-mail only, zero model calls for invalid mail,
bridge-owned worktree isolation (your working tree is never touched),
`workspace-write` sandbox ceiling, redacted replies to yourself only.

**Intended use**: your own mailbox, your own device, your own projects. Not
for circumventing employer policy; don't bind a managed corporate mailbox.

## Documentation

See [docs/](docs/README.md) for architecture, threat model, compatibility
(pinned toolchain and Codex CLI policy) and decision records.

## License

[MIT](LICENSE) © 2026 claude89757
