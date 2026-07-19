# daemon/

Single-step daemon functions ("ticks", decisions D-P4B11-2/3): startup
recovery (`INTERRUPTED_BY_RESTART`), expired-clarification sweep, the mail
tick (mailbox status → watermark → fetch → ingest → in-place dispatch →
reply) and the orphan-recovery tick, plus the outbox lifecycle glue around
every send (`replySender.ts`: C3 send order, UNCERTAIN isolation, echo
reconciliation). Everything is injected and single-step testable; the
long-running shell — loop/IDLE keep-alive (≤29 min reconnect cycles),
signals, backoff, `cli start` wiring, launchd/systemd units in `resources/`
— is the daemon-shell batch's. ACK sending is likewise deferred: ticks
dispatch synchronously, so the result reply arrives in the same step and an
ACK only becomes meaningful with the shell's async execution
(`composeAckReply` already exists for it).

- Does: keep the bridge alive and current one tick at a time; recover to a
  consistent state after sleep, disconnect or crash; own the outbox row
  lifecycle around every send.
- Used by: the daemon shell (next batch) / launchd / systemd units in
  `resources/`.
- Depends on: `application/`, `domain/`, `store/`, `transports/`,
  `drivers/` — orchestration layer, same import treatment as
  `application/`.
