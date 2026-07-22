# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-22

Conversational coordination layer (ADR-0006), off by default. A mail can now be
written in plain language: the bridge understands it, asks a clarifying question
when the request is under-specified, answers read-only meta-queries (projects,
sessions, status, history) without running anything, and carries a multi-turn
thread as one conversation — all behind the unchanged deterministic identity
gate. The operator opts in per install; with it off, routing stays exactly as in
0.1.0. The security kernel (identity gate + execution isolation) is untouched —
the coordinator only ever reads.

### Added

- Coordinator behind the identity gate: a codex session driven at
  `--sandbox read-only` interprets the mail and emits a structured
  `dispatch` | `clarify` | `answer` decision. On model failure or off-schema
  output it falls back to the 0.1.0 deterministic router (fail-closed — never a
  guess).
- Multi-turn coordination: a reply on the same thread resumes the SAME codex
  conversation (`codex exec resume`), so context carries across mails; verified
  live against real codex (ADR-0008).
- Read-only meta-queries: projects / sessions / status / history answered from a
  scrubbed snapshot pushed into the prompt (ADR-0007) — no agent runs, the
  intent is `RESOLVED` without dispatching.
- Coordinator reply markers `💬 answer` and `❓ clarification`, distinct from a
  dispatch result.

### Changed

- Releases now publish via npm trusted publishing (OIDC): no long-lived npm
  token is stored anywhere; a pushed `v*` tag drives publish + GitHub Release
  from CI (ADR-0005).

### Security

- The coordinator can never write: `--sandbox read-only` on every new turn and,
  on resume (which cannot re-assert `--sandbox`), an independently-enforcing
  `-c sandbox_mode="read-only"` emitted as a driver invariant — verified against
  real codex by a filesystem-ground-truth spike (ADR-0008).
- Injection containment: a forged or injection-laden mail body cannot make the
  coordinator dispatch outside the operator's allowlist. The model only ever
  emits an alias; the real path comes solely from the trusted project index, and
  an unmatched or path-shaped alias fails closed to a clarification. Covered by
  orchestrator- and daemon-level tests.
- Redaction holds over untrusted model text: real paths become aliases in the
  pushed context, and the coordinator's own reply is scrubbed before send, so a
  model reply cannot leak a local path.

## [0.1.0] - 2026-07-20

First public release. The full pipeline — IMAP ingest → deterministic
routing → codex dispatch in a bridge-owned worktree → redacted reply — is
built, tested, and validated end to end against a live mailbox (a real
self-mail drove a real codex task and the scrubbed result mailed itself
back, twice, in under a minute each). The one interactive feature still
pending is the clarification mail flow (replying `1`/`2`/`new` to an
ambiguous command); see the README's Status section.

### Added

- `amb` CLI: `setup`, `doctor` (five local health checks), `start`
  (foreground daemon with `--dry-run` rehearsal), `status`, `pause` /
  `resume`, `install` / `uninstall` (launchd / systemd user service files),
  with uniform exit codes.
- IMAP ingest with crash-safe idempotency: per-mailbox UID watermarks with a
  fail-closed `UIDVALIDITY` guard, mail persisted before the watermark
  advances, duplicates converging on normalized `Message-ID`.
- Deterministic routing — thread continuity first (a reply resumes that
  thread's agent session), then a unique exact match against the
  operator-configured project allowlist; anything ambiguous is answered
  with a reply naming the candidates, never a fuzzy guess.
- Codex driver on `codex exec --json` with session capture and resume.
- Bridge-owned git worktree per task — the operator's own checkouts are
  never touched.
- Transactional outbox: send-uncertain mail is reconciled only by observing
  the bridge's own echo markers, never by blind resend.
- Daemon shell with startup crash recovery (interrupted work is marked, not
  silently re-run), pause/resume via a database flag, graceful signal
  shutdown, and a three-consecutive-failures fatal exit that defers restart
  policy to the service manager.
- Config schema v1 (XDG-based paths, `~/` expansion, unknown fields
  rejected) plus the `readyAt` first-install fence: mail received before
  the first install is never executed.
- Optional working-hours `timeWindow` (out-of-window mail is queued, not
  dispatched) and a full dry-run mode (`dryRun` / `amb start --dry-run`)
  that rehearses the pipeline with zero agent invocations.
- Scrubbed, size-rotated daemon log file under the XDG state directory —
  fail-open, so the daemon never dies because of its log.

### Security

- Redaction funnel on every outbound reply: path placeholders,
  secret-keyword value masking, a long-token heuristic, and
  scrub-before-truncate ordering.
- Reply recipient locked to the configured self address; no CC, BCC or
  attachments, ever.
- Ingest identity gate (self-address check, own-echo detection, `readyAt`
  fence): invalid mail is dropped with zero agent/model calls.
- Self-submission authentication factor (ADR-0003): a `From==To==self` mail
  carrying any `Authentication-Results` header reached INBOX via an external
  MX and is quarantined `AUTH_RESULTS_PRESENT` — legitimate authenticated
  self-mail carries none. Confirmed live by the end-to-end run.
- Credentials live only in an operator-named env file whose permissions are
  enforced at exactly 0600 (file) / 0700 (directory) by stat-only checks;
  credential values never appear in config, logs, terminal output or mail.
- Agent runs are capped at the `workspace-write` sandbox ceiling, and
  `amb install` / `uninstall` only print the service-manager activation
  commands — they never execute them.

[0.2.0]: https://github.com/claude89757/agent-mail-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/claude89757/agent-mail-bridge/releases/tag/v0.1.0
