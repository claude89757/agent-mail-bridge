# store/

SQLite persistence and migrations: command/outbox state, Message-ID unique index
(idempotency), UID high-water marks, `readyAt`, clarification tokens.

- Does: durable state with transactional guarantees; schema migrations.
- Used by: `application/`.
- Depends on: SQLite driver (final choice recorded in an ADR during Phase 2).
