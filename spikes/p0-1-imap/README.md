# P0-1 spike — Gmail IMAP stability (Go/No-Go)

Read-only observation against the **dedicated test mailbox** (credentials read
at runtime from `~/.secrets/amb-test.env`; never printed, never committed).

## What it measures

| Question (spec §5 P0-1) | How |
| --- | --- |
| IDLE supported & events delivered? | `CAPABILITY` check + `exists`/`expunge`/`flags` listeners while idling |
| ≤29 min proactive reconnect viable? | N rounds of IDLE followed by deliberate logout/reconnect |
| UIDVALIDITY stable across reconnects? | compared between rounds; a change exercises the bounded-rescan path |
| Catch-up after reconnect? | `UID SEARCH <high-water>:*` rehearsal each round |
| Self-sent mail visibility in INBOX | **done (2026-07-19, red-line-3 approved class)** — `send-observe.ts`: 3/3 visible in 15–30 s, `Message-ID` and `X-AMB-*` preserved, In-Reply-To threading confirmed via `X-GM-THRID` |
| Self-to-self `Authentication-Results` (P0-3, same run) | **measured: none exist on legitimate self-mail** — see [ADR-0003](../../docs/adr/0003-self-mail-carries-no-auth-results.md) |

## Run

```sh
# smoke (~1 min): 1 round, 30s IDLE
node spikes/p0-1-imap/observe.ts --rounds 1 --idle-minutes 0.5

# full observation (~80 min): 3 rounds, 25 min IDLE each
node spikes/p0-1-imap/observe.ts --rounds 3 --idle-minutes 25

# send half — SENDS MAIL (red-line-3 approved class: authenticated self-send
# to the dedicated test mailbox only; hard cap 5, explicit opt-in gate):
AMB_SEND_PROBE=1 node spikes/p0-1-imap/send-observe.ts --count 3
```

Requires Node ≥ 22.6 (runs TypeScript directly via type stripping).

Findings land in the P0-1/P0-3 ADRs
([0002](../../docs/adr/0002-p0-1-gmail-imap-smtp-go.md),
[0003](../../docs/adr/0003-self-mail-carries-no-auth-results.md)); both
scripts print sanitized machine-readable summaries (addresses replaced,
DKIM/ARC signature blobs never printed).
