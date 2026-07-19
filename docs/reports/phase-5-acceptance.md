# Phase 5 acceptance report — local productization

> Scope: spec §5 Phase 5 (`setup` / `doctor` / launchd/systemd install /
> `status`/`pause`/`resume`/`logout` / scrubbed log rotation / uninstall
> cleanup). Delivered across the CLI-skeleton batch and batches 12–13;
> usage documentation landed with the batch-14 release-prep materials.
> Written 2026-07-19 for asynchronous user review.

## Deliverables vs. spec

| Spec item | Status | Evidence |
| --- | --- | --- |
| `setup` wizard (5-minute hard target) | **done** (flag-based, non-interactive) | `src/cli/setup.ts`: 0600 config, `readyAt` first-install fence never overwritten, `--force-config` gate; `tests/unit/cli-setup.test.ts`. An interactive wizard is a possible follow-up; the 5-minute target folds into the 10-minute exit metric measured at E2E |
| `doctor` | **done** | five checks (Node ≥ 22 / config / credentials file exactly 0600 in 0700, `stat`-only / database / readyAt), incl. the setuid-bit adversarial case |
| launchd/systemd install | **done** (artifact-writing) | `src/cli/service.ts`: `amb install` writes the plist/user-unit and PRINTS the activation command — the service manager is never executed by amb; tilde-form display discipline test-pinned (batch 13) |
| `status` / `pause` / `resume` | **done** | honest DB-view status (no process probing, mailbox address never echoed); pause via a meta flag, effective within one poll interval (batch 12) |
| `logout` | **honest placeholder** (exit 2) | pending open question 1 (keychain); stated as such in the README command table |
| Scrubbed log rotation | **done** | `src/cli/logSink.ts`: `amb.log`, 1 MiB shift rotation `.1..3`, fail-open (one report, never kills the daemon); file surface sits behind the SAME scrub boundary as the console (scrub-before-tee); the batch-13 review's close()-closure probe is closed by the extended stdio-spy window |
| Uninstall cleanup order | **done** | `amb uninstall`: deactivation command printed → service file removed (the only deletion) → manual cleanup list config→db→worktrees→logs→credentials, order test-pinned |

## Exit criterion

“A clean machine goes from README to the first result mail in ≤ 10
minutes” — **pending measurement**: the README usage documentation is in
place (every command cross-checked against `src/cli/**`), the mail
round-trip halves are live-verified (IMAP read 3/3, SMTP self-send echo
round-trip 12 s), and the full chain (ingest → codex dispatch → redacted
result reply) awaits the red-line-5 E2E approval, which will time this
metric.

## Upstream items outside Phase 5 scope (stated honestly)

- Identity-gate wiring: blocked on the user's ADR-0003 decision (red line 6);
- The interactive clarification flow: blocked on the real-device walkthrough
  (spec open question 2);
- IDLE watch: follow-up by design — the 30 s poll already meets the
  P95 < 60 s acceptance line.

## Red-line compliance

Zero real runs / zero sends / zero model quota across all Phase 5 batches
(every seam faked); credentials guarded by the five-sink stdio spy with
probe-kill evidence (batches 12–13); tilde-form display discipline
test-pinned; zero publishing actions performed.

## Test baseline

726 tests at the start of batch 12 → **838** (833 passed + 5 skipped)
after batch 13; CI green throughout (latest: 63deb34).
