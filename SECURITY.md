# Security Policy

## Reporting a vulnerability

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/claude89757/agent-mail-bridge/security/advisories/new)
("Report a vulnerability" under this repository's Security tab). This is the
only reporting channel — the project deliberately publishes no security
contact mailbox.

Please do not open a public issue for anything you believe is exploitable.

Response target: you will get an acknowledgement within 7 days. Fix and
disclosure timelines depend on severity and are agreed in the advisory
thread.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Scope

The project's threat model is public —
[docs/threat-model.md](docs/threat-model.md) — and maps claims to tests
instead of hiding residual risks. Reports that challenge any stated claim or
residual risk in it are especially welcome.

Out of scope:

- the security of your own mailbox account (provider-side compromise,
  phishing, credential theft outside this software);
- vulnerabilities in the Codex CLI itself — report those upstream to its
  maintainers.
