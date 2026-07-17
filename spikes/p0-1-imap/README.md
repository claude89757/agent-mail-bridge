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
| Self-sent mail visibility in INBOX | **requires sending mail — blocked on the red-line-3 confirmation**, done as a follow-up run once approved |

## Run

```sh
# smoke (~1 min): 1 round, 30s IDLE
node spikes/p0-1-imap/observe.ts --rounds 1 --idle-minutes 0.5

# full observation (~80 min): 3 rounds, 25 min IDLE each
node spikes/p0-1-imap/observe.ts --rounds 3 --idle-minutes 25
```

Requires Node ≥ 22.6 (runs TypeScript directly via type stripping).

Findings land in the P0-1 ADR (`docs/adr/`), including the machine-readable
summary the script prints at the end.
