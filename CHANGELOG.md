# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First public release. See the README's Status section for what is
live-verified versus not yet wired (the identity gate's DKIM factor, the
clarification mail flow, a full end-to-end run).

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
- Credentials live only in an operator-named env file whose permissions are
  enforced at exactly 0600 (file) / 0700 (directory) by stat-only checks;
  credential values never appear in config, logs, terminal output or mail.
- Agent runs are capped at the `workspace-write` sandbox ceiling, and
  `amb install` / `uninstall` only print the service-manager activation
  commands — they never execute them.

[0.1.0]: https://github.com/claude89757/agent-mail-bridge/releases/tag/v0.1.0
