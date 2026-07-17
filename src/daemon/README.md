# daemon/

Long-running process: IMAP IDLE keep-alive (≤29 min reconnect cycles), periodic
fallback polling, crash recovery, backoff.

- Does: keep the bridge alive and current; recover to a consistent state after
  sleep, disconnect or crash.
- Used by: launchd / systemd units in `resources/`.
- Depends on: `application/`.
