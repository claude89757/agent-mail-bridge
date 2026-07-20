# agent-mail-bridge

[![CI](https://github.com/claude89757/agent-mail-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/claude89757/agent-mail-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Email is the universal, firewall-friendly async transport for AI agents.**

Control the coding agent on your own device from your own mailbox: send
yourself an ordinary email from your phone, a local daemon picks it up over
IMAP, runs the task with Codex in an isolated git worktree, and mails the
result back to you. No vendor cloud, no relay server, no port forwarding —
your mail provider is the only intermediary.

## Status

**Pre-release: v0.1.0 in preparation.** What exists today, stated honestly:

- **Built and tested** — the full core pipeline (IMAP ingest → deterministic
  routing → codex dispatch in a bridge-owned worktree → redacted reply →
  daemon poll loop), including the self-mail identity gate (ADR-0003
  polarity inversion) and crash recovery, idempotent ingest and a
  transactional outbox; 850+ tests, every external seam (IMAP, SMTP, codex,
  git, filesystem, clock) faked in tests.
- **Live-verified** — the IMAP read path (read-only, against a dedicated
  test mailbox) and the SMTP send round-trip (a production-path self-send
  whose `Message-ID` and echo markers were read back over IMAP).
- **Not yet** — the clarification mail flow (replying `1`/`2`/`new` to an
  ambiguous command) waits on a real-device walkthrough; and no full
  end-to-end run (a real mail driving a real codex task) has been performed
  yet. "From README to the first result mail in ≤ 10 minutes" is the v0.1.0
  acceptance target, not a demonstrated number.

Roadmap and design decisions:
[docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md](docs/superpowers/specs/2026-07-17-agent-mail-bridge-roadmap-design.md)

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

Highlights: self-mail-only identity gate wired into ingest — mail bearing any
`Authentication-Results` header entered via an external MX path and is
quarantined ([ADR-0003](docs/adr/0003-self-mail-carries-no-auth-results.md):
legitimate authenticated self-mail carries none), zero model calls for
invalid mail, bridge-owned worktree isolation (your working tree is never
touched), `workspace-write` sandbox ceiling, redacted replies to yourself
only.

**Intended use**: your own mailbox, your own device, your own projects. Not
for circumventing employer policy; don't bind a managed corporate mailbox.

## Quickstart (from source)

The npm package is not published yet, so building from source is the only
install path today. Requirements: Node.js ≥ 22, [pnpm](https://pnpm.io), a
Gmail account (v0.1 pins Gmail's IMAP/SMTP endpoints), the OpenAI Codex CLI
(`codex`) on your `PATH`, and macOS or Linux if you want `amb install`
(launchd / systemd user units).

### 1. Clone and build

```sh
git clone https://github.com/claude89757/agent-mail-bridge.git
cd agent-mail-bridge
pnpm install
pnpm build
```

Commands below are written as `amb <command>` — the name the published npm
package will install. From a source checkout, run
`node dist/cli/main.js <command>` from the repository root instead.

### 2. Create the credentials file

The bridge reads mail credentials from a small env-format file whose path you
pass to setup. Use a Gmail
[app password](https://support.google.com/accounts/answer/185833) (requires
2-Step Verification) — never your account password.

```sh
mkdir -p ~/.secrets && chmod 700 ~/.secrets
"${EDITOR:-vi}" ~/.secrets/amb.env
chmod 600 ~/.secrets/amb.env
```

`~/.secrets/amb.env` (placeholder values — substitute your own):

```ini
# KEY=VALUE lines; `#` comments and blank lines are skipped.
# Values are taken verbatim after the first `=` — do not quote them.
AMB_IMAP_USER=bridge-user@example.com
AMB_IMAP_PASS=xxxx-placeholder-xxxx
```

Setup and doctor refuse to proceed unless the file is mode `0600` and its
parent directory `0700`. These checks are stat-only — the file's contents are
read at daemon startup, never during checks, and never stored anywhere else.

### 3. Run setup

```sh
node dist/cli/main.js setup \
  --self bridge-user@example.com \
  --credentials-env-file ~/.secrets/amb.env
```

This validates the settings, writes `config.json` (mode 0600), initializes
the SQLite store, and records the `readyAt` first-install fence: mail
received before that instant will never be executed.

### 4. Allowlist your projects

Edit the config file (see [Configuration](#configuration)) and add the
directories the bridge may work in, for example:

```json
"projects": { "roots": ["~/github"] }
```

The allowlist starts empty, and no mail command can match a project until you
fill it in.

### 5. Check, rehearse, run, install

```sh
amb doctor           # five local health checks; fix anything it flags
amb start --dry-run  # foreground rehearsal: full pipeline, zero codex runs
amb start            # the real foreground daemon (Ctrl-C stops it cleanly)
amb install          # write the launchd/systemd user service file
```

`amb install` never touches the service manager: it writes the service file
and prints the `launchctl` / `systemctl` activation command for you to run
yourself.

Then email yourself from any device: the v0.1 command format is minimal —
the subject's first token names the project (directory name or configured
alias), the body is the task prompt. The result comes back as a reply in the
same thread; replying to that thread continues the same codex session.

## Command reference

| Command | What it does |
| --- | --- |
| `amb setup --self <addr> --credentials-env-file <path>` <br>`[--db-path <p>] [--mailbox <m>] [--dry-run] [--force-config]` | Validate and write the initial `config.json` (refuses to overwrite an existing one without `--force-config`), initialize the database, and record the `readyAt` first-install fence. |
| `amb doctor` | Run the five local health checks: Node ≥ 22, config loads, credentials-file permissions (0600 file / 0700 directory), database opens, `readyAt` fence. Takes no flags. |
| `amb start [--dry-run]` | Run the mail-processing daemon in the foreground. `--dry-run` overrides the config for this run only: a full-pipeline rehearsal in which every dispatch intent lands `SKIPPED_DRY_RUN` — zero codex invocations. |
| `amb status` | Print the database view: `readyAt`, pause flag, per-table status counts, unreconciled outbox entries, and UID watermarks. Does not detect whether a daemon process is actually running. |
| `amb pause` / `amb resume` | Set / clear the pause flag in the database; the daemon reads it at the start of each poll round, so the change takes effect within one poll interval. |
| `amb install [--force]` | Write the per-user service file — a launchd LaunchAgent on macOS, a systemd user unit on Linux — and print the activation command. Never runs the service manager itself. `--force` overwrites an existing service file. |
| `amb uninstall` | Print the deactivation command, remove the service file (the only file amb ever deletes), and list the remaining artifacts for manual cleanup. |
| `amb logout` | Placeholder — exits 2; credential-storage cleanup is pending the keychain decision. |

Exit codes are uniform: `0` success, `1` runtime failure, `2` usage error —
an unknown command, an unknown flag on the commands that take flags
(`setup`, `start`, `install`, `uninstall`), or any extra argument to the
flagless commands (`doctor`, `status`, `pause`, `resume` reject extra
arguments). Two command-specific readings: `amb doctor` exits
`1` when any check fails, and `amb start` exits `0` when stopped by
SIGINT/SIGTERM but `1` after three consecutive failed poll rounds (restart
policy belongs to the service manager). `amb --help` lists the commands;
`amb --version` prints the installed version.

## Configuration

`amb setup` writes `config.json` to
`$XDG_CONFIG_HOME/agent-mail-bridge/config.json`
(`~/.config/agent-mail-bridge/config.json` when `XDG_CONFIG_HOME` is unset),
mode 0600. You can also edit it by hand — setup and a hand-edited file are
validated against exactly the same schema, and unknown fields are rejected
rather than ignored. `credentialsEnvFile`, `dbPath` and `worktreesRoot`
must be absolute or start with `~/` (validated); use the same form for
`projects.roots` and alias targets too — relative entries there pass shape
validation but resolve against the daemon's working directory at runtime.

| Field | Default | Meaning |
| --- | --- | --- |
| `version` | — (required) | Config schema version; must be `1`. |
| `selfAddress` | — (required) | The one mailbox address: only self-mail is processed, and every reply goes back to it and nowhere else. |
| `credentialsEnvFile` | — (required) | Path to the env file holding `AMB_IMAP_USER` / `AMB_IMAP_PASS`. Only the path is stored; credential values never enter `config.json`. |
| `dbPath` | `$XDG_DATA_HOME/agent-mail-bridge/bridge.db` (fallback `~/.local/share/…`) | SQLite state store: idempotency, outbox, watermarks, sessions. |
| `projects.roots` | `[]` | Allowlisted directories scanned for git repositories. While empty, no mail command can match a project. |
| `projects.aliases` | — (optional) | Short name → project path map, usable in mail subjects. |
| `worktreesRoot` | `$XDG_DATA_HOME/agent-mail-bridge/worktrees` | Where bridge-owned task worktrees are created. Your own checkouts are never touched. |
| `baseRef` | `"HEAD"` | Git ref new task worktrees are based on. |
| `pollIntervalSeconds` | `30` | Daemon poll interval; an integer between 5 and 3600. |
| `mailbox` | `"INBOX"` | IMAP mailbox to watch. |
| `timeWindow` | — (optional) | `{ timezone, days, start, end, excludeDates }`. Mail arriving outside the window is held as `QUEUED_WINDOW` instead of dispatched; omitted means always within the window. |
| `dryRun` | `false` | Record dispatch intents but never invoke the agent (same effect as `amb start --dry-run`, made permanent). |

Daemon logs are written to `$XDG_STATE_HOME/agent-mail-bridge/logs/amb.log`
(fallback `~/.local/state/…`, size-rotated), through the same redaction
funnel as the console output and mail replies.

## How it works

Every `pollIntervalSeconds` the daemon fetches mail newer than its per-mailbox
UID watermark and runs each message through the gate chain — own-echo
detection, the `readyAt` fence, the self-address identity check, the optional
time window — before persisting it (idempotently, keyed on normalized
`Message-ID`) and routing it. Routing is deterministic, never fuzzy: thread
continuity first (a reply in a known thread resumes that thread's codex
session), then a unique exact match against the configured project index;
anything ambiguous is answered with a reply naming the candidates instead
of a guess (the interactive clarification flow — replying `1`/`2`/`new` —
awaits the real-device walkthrough). Dispatch runs `codex exec --json` inside a bridge-owned git worktree
with the `workspace-write` sandbox ceiling, and the outcome is composed into
a reply that passes a redaction funnel (path placeholders, secret-pattern
masking) before the SMTP sender — recipient locked to your own address —
sends it carrying the bridge's own echo markers, so the daemon recognizes its
own mail on the next poll instead of looping. Crash safety lives in the
SQLite store: mail is persisted before the watermark advances, outbound mail
goes through a transactional outbox whose send-uncertain entries are
reconciled only by observing the echo (never by blind resend), and startup
recovery marks work interrupted by a crash instead of silently re-running it.

See [docs/architecture.md](docs/architecture.md) for the pipeline diagram,
module boundaries, the reliability model, and the per-stage implementation
status with evidence links.

## Documentation

See [docs/](docs/README.md) for architecture, threat model, compatibility
(pinned toolchain and Codex CLI policy) and decision records.

## License

[MIT](LICENSE) © 2026 claude89757
