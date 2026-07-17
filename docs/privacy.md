# Privacy

> Status: skeleton — expanded as the implementation lands (Phases 2–5).

## Data flow in one paragraph

Mail never leaves your own mailbox provider: the bridge runs on your device,
talks IMAP/SMTP directly to your provider, and sends results only to your own
address. There is no vendor cloud, no telemetry, and no third-party relay.

## Commitments (testable)

| Data | Where it may live | Where it must never appear |
| --- | --- | --- |
| Mailbox credentials | OS keychain (macOS); Linux storage decided by ADR | git, logs, replies, config files |
| Mail bodies | processed in memory; referenced by id in SQLite | daemon logs (bodies are not logged) |
| Result mails | your mailbox only (recipient = self, enforced mechanically) | any other recipient, attachments |
| Local paths, secrets, large diffs | — | outbound replies (redaction pipeline) and logs |
| Task transcripts | local agent session storage (owned by the agent CLI) | the repository |

Logging is redacted by design: no bodies, no tokens, no full local paths.
Retention/rotation policy is specified in [operations.md](operations.md)
(Phase 5).
