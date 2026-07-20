# ADR-0003: Self-submitted mail carries no Authentication-Results — identity-gate polarity must invert

- Status: **accepted (user, 2026-07-20)** — polarity inversion approved; the
  identity-gate wiring batch is unblocked. Implementation note below.
- Deciders: bridge maintainers + user (design change against a spec assumption)
- Related: spec §3 identity gate ("DKIM/SPF + From==To==self"), §5 P0-3;
  threat-model C2; `src/domain/authResults.ts` (`parseAuthenticationResults`,
  `checkDkimFactor`); ADR-0002 (same measurement run)

## Context

The spec's identity gate assumed inbound self-commands would carry Gmail
`Authentication-Results` (AR) headers whose DKIM/SPF verdicts a fail-closed
factor (`checkDkimFactor`, built in Phase 3 prework) could require to be
`pass`. P0-3 planned to measure the real self-to-self AR shape before wiring.

## Evidence (2026-07-19, dedicated test mailbox, read-only except the 3 approved probes)

Three mutually consistent observations, all reproducible read-only:

1. **Authenticated SMTP self-send (3/3 probes): NO auth headers at all.**
   Full header-name lists show no `Authentication-Results`, no
   `DKIM-Signature`, no `Received-SPF`, no `ARC-*`; exactly one `Received`
   hop (`by smtp.gmail.com … ESMTPSA`). The mail never traverses the public
   MX path — Gmail short-circuits authenticated self-submission straight
   into the same account's INBOX, skipping the entire inbound
   authentication pipeline.
2. **Gmail web/app-composed self-mail (8/8 historical, `@mail.gmail.com`
   Message-IDs): same short-circuit shape.** No AR, no DKIM-Signature, no
   MX hop. So the "no auth headers" topology is not an SMTP quirk; it is
   how *every* authenticated self-submission path behaves.
3. **External mail (8/8 sampled: Google notices, GitHub, SendGrid, a
   PHPMailer host): ALWAYS `Authentication-Results` + `mx.google.com`
   Received hop**, with dkim/spf/dmarc verdict tokens present (all `pass`
   in the legitimate samples) and sender DKIM signatures.

Honesty note: the first sampling script misclassified external mail as
"from SELF" (it tested the whole header block, and `To:` always contains the
self address); a Message-ID/X-Mailer classifier pass corrected this before
any conclusion was drawn.

## The mismatch

A fail-closed `checkDkimFactor` that **requires** `dkim=pass` would reject
**every legitimate self-command** (they carry no AR to pass). The spec
assumption and external behavior disagree → per red line 6: fail closed,
record the ADR, stop and ask — do not weaken the design to route around.

## Proposed decision (not yet accepted)

Invert the factor's polarity for `From==To==self` inbound mail:

- **AR present ⇒ the mail entered via MX ⇒ external origin ⇒ it cannot be a
  legitimate self-submission ⇒ quarantine as forged-From** (regardless of
  the verdict values — even `dkim=pass` for some other aligned domain).
- **AR absent ⇒ consistent with authenticated internal self-submission ⇒
  this factor passes**; all other gate factors (From==To==self, echo gate,
  readyAt fence, rate caps) still apply unchanged.

`parseAuthenticationResults` stays load-bearing (detecting AR presence and,
with the pinned authserv-id, ignoring attacker-injected fake AR *below*
Gmail's own topmost stamp). `checkDkimFactor`'s pass-requiring form remains
in the codebase for any future non-self-mail use, documented as such.

### Why the inverted branch is still fail-closed

Reaching INBOX *without* traversing MX requires authenticating as the
account (SMTP submission, web session, or IMAP APPEND) — all inside
threat-model assumption "mailbox credentials are not compromised" (§4 A5
residual risk). An external forger cannot avoid MX, and 8/8 MX-path samples
show Gmail always stamps its own AR there.

### What still needs confirming before acceptance

1. **User decision** on the polarity inversion (this ADR's ask).
2. **方案 B forged-From controls** (user sends 1–2 mails with forged
   `From: <self>` from an external mailbox/tool): pins the attack-side
   shape empirically — expected: AR present with failing/absent gmail.com
   alignment, possibly spam-foldered. Recommended but the 8/8 external
   sample already grounds the mechanism.
3. Real-device walkthrough (spec line 213) naturally re-verifies the
   phone-app path produces the no-AR shape end-to-end.

## Accepted decision + implementation note (2026-07-20)

The user accepted the polarity inversion. The wiring batch implements the
reject trigger as **AR presence** — if the mail carries any
`Authentication-Results` header at all, it traversed an MTA authentication
pipeline, so it cannot be a legitimate internal self-submission and is
quarantined (`AUTH_RESULTS_PRESENT`); a mail with no such header passes this
factor. This is **strictly more conservative** than the "pinned authserv-id
filter" this ADR's prose sketched: presence-only cannot fail open on a
Gmail authserv-id string change, and — because inversion means "more AR ⇒
more likely rejected" — an attacker-injected extra AR only helps the reject,
never defeats it. `parseAuthenticationResults` is still used on the reject
branch to extract the topmost `authservId` as reject **evidence** (which MTA
stamped it), not as an accept/ignore filter. If a future non-self-mail path
needs to accept some AR-bearing mail, that reintroduces the authserv-id
trust question under a new ADR; `checkDkimFactor`'s pass-requiring form
remains in the codebase for it.

## Consequences

- The identity-gate DKIM wiring batch stays **blocked** until this ADR is
  accepted or amended by the user.
- Unaffected and proceeding: SMTP send transport (ADR-0002), router,
  clarification, daemon batches.
- `docs/threat-model.md` C2 must reference this ADR once decided.

## Reproduction steps

```sh
# probes (SENDS MAIL — approved class only):
AMB_SEND_PROBE=1 node spikes/p0-1-imap/send-observe.ts --count 3
# read-only topology checks: header-name lists of the probe uids, the
# @mail.gmail.com historical self-mails, and any external senders —
# see spikes/p0-1-imap/README.md for the fetch pattern.
```
