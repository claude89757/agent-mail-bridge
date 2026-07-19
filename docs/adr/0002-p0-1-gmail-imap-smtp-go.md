# ADR-0002: P0-1 Gmail IMAP/SMTP stability — Go

- Status: accepted (2026-07-19, evidence complete)
- Deciders: bridge maintainers
- Related: spec §5 P0-1, §3.2 (reconnect strategy), threat-model C3 (echo
  gate), C4 (readyAt fence); spike `spikes/p0-1-imap/`
- Send actions ran under the red-line-3 approval of 2026-07-19 (authenticated
  SMTP self-send to the dedicated test mailbox, batch of 3).

## Context

Phase 1 gates the whole IMAP+SMTP transport design on measured Gmail behavior:
IDLE stability, UIDVALIDITY behavior, reconnect cost, and — the half that
required a send approval — whether a self-sent SMTP mail becomes visible in
INBOX at all, how fast, and whether the loop-prevention markers
(sender-supplied `Message-ID`, custom `X-AMB-*` header) survive delivery.

## Evidence

### Read-only half (2026-07-17; `observe.ts`, Node 24.4.1, imapflow 1.4.7, TLS 993)

| Metric | Result |
| --- | --- |
| Connect+login latency | 2525–2732 ms (3 rounds; first-ever connect 7451 ms) |
| IDLE capability / survival | present; 25 min × 3 rounds, zero drops |
| Push latency (external mail) | EXISTS delivered in real time (mail arrived 19 min into an IDLE round) |
| UIDVALIDITY | stable across all reconnects |
| Proactive reconnect | logout→reconnect ≈ 8 s, clean each time |
| Catch-up rehearsal | `UID SEARCH <uidNext>:*` returns 1 uid even when nothing is new (RFC 3501 `*` inversion) — filtering `uid > watermark` is mandatory (`src/domain/uid.ts`) |
| INBOX baseline | ≈15.9k pre-existing messages — the readyAt fence (C4) is not optional |

### Send half (2026-07-19; `send-observe.ts`, 3 probes, authenticated SMTP 465 → self)

| Question | Result |
| --- | --- |
| Self-sent mail visible in INBOX? | 3/3 visible, via EXISTS push on an open IMAP connection |
| Visibility latency (SMTP accept → EXISTS) | 15.4 s / 30.2 s / 29.7 s — self-send is *slower* than external push; product feedback loops must budget ~30 s |
| Sender-supplied `Message-ID` preserved? | 3/3 preserved byte-identical (custom domain `@amb-probe.invalid`) |
| Custom header (`X-AMB-Probe`) preserved? | 3/3 preserved — `X-AMB-Outbox-ID` echo-gate design (C3) is viable |
| Threading | reply probe (`In-Reply-To`/`References` to probe 1) landed in the SAME `X-GM-THRID` as its parent; unrelated probe got its own thread — clarification threads (C8) can rely on In-Reply-To at the provider level |
| `UID SEARCH` attribution | all 3 probes found via `<baseline uidNext>:*` and matched by `X-AMB-Probe` |

## Decision

**Go** for the IMAP (read/IDLE) + SMTP (send) transport pair as designed:

1. IDLE with proactive reconnect ≤29 min (spec §3.2) is validated as
   conservative; silent-death fallback polling stays.
2. Loop prevention keeps the two-pronged design (own `Message-ID` +
   `X-AMB-Outbox-ID`), both empirically delivery-safe.
3. The daemon's user-feedback expectations must assume ~30 s self-send
   visibility latency (measured, not assumed).

## Consequences

- The SMTP send transport can be implemented against measured reality
  (nodemailer, port 465 implicit TLS, fixed recipient = self).
- Authentication-header topology discovered during the same run is a
  *separate, design-changing* finding — split into ADR-0003 (P0-3) rather
  than buried here.

## Reproduction steps

```sh
# read-only half (safe anywhere the creds file exists)
node spikes/p0-1-imap/observe.ts --rounds 3 --idle-minutes 25
# send half — SENDS MAIL; red-line-3 approved class only
AMB_SEND_PROBE=1 node spikes/p0-1-imap/send-observe.ts --count 3
```

Both print sanitized machine-readable summaries; raw output must still be
scrubbed before pasting into any committed record.
