# Security

> Status: design principles. The disclosure process (reporting channel,
> supported versions, scope) lives in the root [`SECURITY.md`](../SECURITY.md).

## Principles

1. **Fail closed.** Any check that cannot run (missing header, unknown format,
   version drift in an external interface) rejects the mail or halts dispatch;
   nothing degrades silently.
2. **Deny by default.** Allowlisted projects only; sandbox ceiling
   `workspace-write`; recipients fixed to self; no attachment, CC or BCC ever.
3. **Smallest possible model surface.** Zero model calls for invalid mail,
   out-of-window mail, or idle operation — enforced as MVP acceptance criteria.
4. **Public threat model.** See [threat-model.md](threat-model.md); claims map
   to tests, and residual risks are stated instead of hidden.

## Baseline (already active in Phase 0)

- Secret scanning (gitleaks) runs in CI on every push; the repository must
  never contain real credentials, mail addresses, or local paths.
- Dedicated test mailbox only during development; credentials live outside the
  repository and are read at runtime (see `AGENTS.md`).

## Reporting a vulnerability

See the root [`SECURITY.md`](../SECURITY.md): GitHub private vulnerability
reporting is the only channel, with acknowledgement within 7 days.
