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
| [0003](0003-self-mail-carries-no-auth-results.md) | Self-submitted mail carries no Authentication-Results — identity-gate polarity must invert | **proposed — user decision pending** |
| — | (remaining spike ADRs: P0-2 Codex driver, P0-4 connector reserve) | — |
