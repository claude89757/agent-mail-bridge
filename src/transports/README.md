# transports/

`MailTransport` interface (`watch` / `fetch` / `send` / `markProcessed`) and its
implementations. First implementation: `imap-smtp` (IMAP IDLE + SMTP with app
passwords). Future: `gmail-api`, `graph`.

- Does: move raw mail in and out reliably; nothing else.
- Used by: `application/` (ingest, deliver).
- Depends on: mail protocol libraries; never on `drivers/` or `domain/` internals.

New mailbox providers plug in here without touching the core (extension axis 1).
