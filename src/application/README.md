# application/

Use-case orchestration: `ingest` → `route` → `dispatch` → `deliver`.

- Does: wire domain decisions to transports, drivers and the store; owns
  transaction boundaries (at-least-once ingest + idempotent effects).
- Used by: `daemon/` and `cli/`.
- Depends on: `domain/`, `transports/`, `drivers/`, `store/` — through their
  public interfaces only.
