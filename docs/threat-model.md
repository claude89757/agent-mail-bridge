# Threat Model — v0

> Status: v0, written before the first line of pipeline code (Phase 0).
> Sources: roadmap spec §1.3/§3.3/§3.4 and the archived pre-development research.
> Items marked **[P0-x]** await measurement in the Phase 1 spikes; where reality
> disagrees with an assumption here, the bridge fails closed and this document
> plus an ADR are updated first.

## 1. What the system is

A local daemon that watches one personal mailbox over IMAP, treats mail the
owner sends to themself as control input, dispatches tasks to a local coding
agent (Codex first) inside bridge-owned git worktrees, and replies with results
over SMTP. No third-party relay: the mail provider is the only intermediary.

## 2. Assets

| Asset | Why it matters |
| --- | --- |
| Local repositories and uncommitted work | the agent can write code; the user's working tree must never be touched |
| Local shell execution (via the agent) | remote code execution is the worst-case outcome |
| Mailbox app password / IMAP+SMTP credentials | full mailbox takeover if leaked |
| Mail contents (both directions) | may contain code excerpts, task context |
| Model quota / compute | attacker-triggered runs cost real money |
| The user's trust in the project | one security incident sinks an open-source security tool |

## 3. Trust assumptions

1. **The mailbox account is the security boundary.** Whoever fully controls the
   mailbox (password, delegate access, device session) controls the bridge.
   We make forging *into* that mailbox from outside useless, but we do not
   defend against a compromised account itself.
2. **Mail bodies are untrusted user input, never configuration.** Bodies can
   carry prompt-injection payloads; they only ever reach the sandboxed task,
   never the router's control decisions (the v0.1 router calls no model at all,
   decision D5).
3. The local machine, its OS keychain, and the installed agent CLI are trusted.
4. The mail provider's `Authentication-Results` evaluation (DKIM/SPF) is
   trusted as an identity oracle. **[P0-3]** measures its exact shape for
   self-to-self Gmail delivery; if the header is absent on the internal path,
   equivalent `Received`/provider-specific evidence replaces it — decided by
   measurement, not assumption.

## 4. Attackers and scenarios

| # | Attacker | Scenario | Primary controls (§5) |
| --- | --- | --- | --- |
| A1 | External sender, no account access | Forges `From: you@provider` to inject a command | C1, C2 |
| A2 | External sender | Sends prompt-injection body hoping it reaches an agent with tools | C1–C2 stop dispatch; C6/C7 bound the blast radius if any body reaches a task |
| A3 | Anyone | Replays an old control mail or a stale clarification reply | C4, C5, C8 |
| A4 | The bridge itself | Self-triggering loop: result mail re-ingested as a command | C3 |
| A5 | Compromised mailbox account | Sends valid self-mail commands | out of scope for identity checks; C6/C7 cap what execution can do; pause/logout is the kill switch |
| A6 | Malicious repo content (fetched deps, hooks) | Task escapes the sandbox or writes outside the worktree | C6, C7 (agent sandbox `workspace-write`, no network by default; bridge-owned worktree; path realpath checks) |
| A7 | Curious eyes on the repo / logs / replies | Credentials or private paths leak | C9, C10 |

## 5. Controls

Every control is testable; MVP acceptance (spec §6) requires evidence.

- **C1 — Strict self-addressing.** RFC 5322 addr-spec of `From` and `To` must
  both equal the configured self address; empty `CC`; multi-recipient rejected;
  aliases/`+tag` rejected in v0.1.
- **C2 — Provider authentication factor.** `Authentication-Results` must show
  `dkim=pass` with the signing domain aligned to the self domain (gmail.com
  publishes DMARC `p=none`, so we must check this ourselves — the provider will
  not reject forgeries for us). Exact self-to-self form: **[P0-3]**.
- **C3 — Echo gate.** Bridge-sent mail carries an own `Message-ID` and
  `X-AMB-Outbox-ID`; both are recorded before send, so inbound copies are
  classified `SYSTEM_ECHO` and never routed.
- **C4 — Time fence.** `INTERNALDATE` ≥ persisted `readyAt` from first setup:
  a fresh install can never execute historical mail.
- **C5 — Idempotency.** Message-ID unique index in SQLite; at-least-once
  ingest with exactly-one persistent dispatch intent per control mail; crash /
  redelivery / reorder produce no duplicate dispatch.
- **C6 — Execution ceiling.** `codex exec --sandbox workspace-write` maximum;
  `danger-full-access` and `--dangerously-bypass-*` are forbidden; mail cannot
  change model, sandbox, or approval settings.
- **C7 — Worktree isolation.** Writes happen only in bridge-owned worktrees
  created from an explicit base commit under a controlled root; the user's
  worktrees and uncommitted changes are never touched; merging back is a local,
  human action. Project targeting is allowlist + realpath, no symlink escape,
  and mail cannot name arbitrary paths.
- **C8 — Clarification binding.** Clarification replies must match token +
  thread + candidate-set version and TTL; late or stale replies are quarantined.
- **C9 — Outbound hygiene.** Replies go to self only (CC/BCC/attachments
  mechanically impossible), size-capped, with secrets, absolute paths, and
  large diffs redacted.
- **C10 — Credential hygiene.** App password in the OS keychain (macOS;
  Linux story tracked as an open question), never in git/logs/replies; public
  repo enforces secret scanning in CI from day one.

## 6. Explicit non-goals (v0.1)

- No defense against a fully compromised mailbox account or local machine
  (see A5; documented as the user's residual risk).
- No interactive approval-by-mail (excluded from v0.1; needs one-time nonce +
  short TTL + diff-hash binding — designed in the app-server phase).
- No guarantee of unbounded offline catch-up: beyond the provider's retention
  windows the bridge enters bounded recovery or asks the human.
- Exactly-once delivery is not claimed anywhere; the system is
  effectively-once via idempotency and quarantine-based reconciliation.
- Not a tool for evading employer policy; see the compliance note in the spec
  (§1.4) — personal mailbox, personal device, personal projects.

## 7. Open measurement items

| Item | Where decided |
| --- | --- |
| Self-to-self Gmail `Authentication-Results` shape | P0-3 ADR |
| IMAP IDLE reconnect / UIDVALIDITY behavior in practice | P0-1 ADR |
| `codex exec --json` session id extraction and resume semantics | P0-2 ADR |
| Linux credential storage (libsecret vs encrypted file, 0600) | implementation-phase ADR |
