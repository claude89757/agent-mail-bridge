# Architecture Decision Records

Decisions that constrain the architecture are recorded here, one file per
decision, never edited into silence: superseding a decision means writing a new
ADR that references the old one.

## Conventions

- Filename: `NNNN-short-kebab-title.md` (zero-padded, ordered).
- Format: [MADR](https://adr.github.io/madr/)-lite — Status / Context /
  Decision / Consequences; spikes add **Reproduction steps** so every
  Go/No-Go can be re-verified.
- The roadmap spec's decision table D1–D10 predates this directory and remains
  authoritative for those decisions; ADRs start where the spec left off.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-sqlite-driver-better-sqlite3.md) | SQLite driver — better-sqlite3 over node:sqlite | accepted |
| [0002](0002-p0-1-gmail-imap-smtp-go.md) | P0-1 Gmail IMAP/SMTP stability — Go | accepted |
| [0003](0003-self-mail-carries-no-auth-results.md) | Self-submitted mail carries no Authentication-Results — identity-gate polarity must invert | accepted (user, 2026-07-20) |
| [0004](0004-p0-2-codex-exec-session-semantics.md) | P0-2 codex exec session semantics — Go for CodexDriver (P0-4 reserve not pursued) | accepted |
| [0005](0005-release-automation-ci-agent-tags.md) | Release automation via CI — agent tags, CI publishes; credentials never touch the agent | accepted (user, 2026-07-20) |
| [0006](0006-conversational-coordination-layer.md) | 邮件对话式协调层 — 推翻 D5,门后引入 codex 驱动的只读协调 agent | accepted (user, 2026-07-21) |
| [0007](0007-coordinator-context-prompt-injection-not-mcp.md) | 协调层只读上下文改 prompt 预注入 — codex exec 非交互下 MCP 工具不可用(细化 0006) | accepted (user, 2026-07-21) |
