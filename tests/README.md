# tests/

- `unit/` — pure logic, runs on every push.
- `contract/` — protocol-facing checks against containerized IMAP (greenmail) and
  recorded `codex exec --json` transcripts; runs on every push.
- `integration/` — cross-module flows with fakes for the outside world.
- `e2e/` — real mailbox + real codex runs. **Costs model quota and touches the
  dedicated test mailbox only** — never runs in default CI; manual workflow only,
  and each new kind of outbound mail is confirmed with the user first (see AGENTS.md).
