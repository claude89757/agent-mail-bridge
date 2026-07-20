# Phase 6 batch 17 — full-pipeline E2E ignition (red line 5)

> **For agentic workers:** this batch is the one live ignition that spends real
> model quota. Unlike code batches it is NOT dispatched to a fresh implementer
> subagent: the MAIN session authors AND runs it, because red line 5 requires
> the quota-spending action to stay under the orchestrator's direct control
> (the test file's own header restates this — live execution is never a
> file-authoring subagent's to perform). A read-only reviewer audits the test
> file afterwards WITHOUT re-running it (a re-run would spend more quota).

**Goal:** Measure the spec §6 MVP exit metric ("README → first result mail in
≤ 10 minutes") against the REAL chain, and confirm ADR-0003 live, in one
bounded, observable, quota-capped run.

**Architecture:** A committed, quadruple-gated live test
(`tests/live/e2e-full-live.test.ts`) assembles the daemon through the
production composition root (`assembleDaemon` +
`buildProductionAssemblyBuilders`), wrapping only `buildDriver` to count and
hard-cap codex calls at 3. It drives the pipeline by calling
`assembled.ticks.mailTick()` manually (not the unbounded shell loop), sends
control mail via bare nodemailer (no bridge echo markers), and reads replies
back over an independent probe transport. A throwaway git repo, SQLite store
and worktrees root live under `os.tmpdir()`; the `readyAt` fence and UID
watermark are seeded before the first tick so it sees only fresh mail (not the
~15k mailbox history).

**Tech stack:** vitest (already a dep — no tsx needed), nodemailer, imapflow
behind the real `ImapReadTransport`, real `codex exec` via the production
`CodexDriver`.

---

## What was built

- `tests/live/e2e-full-live.test.ts` — the E2E, gated behind
  `AMB_LIVE_TEST=1` + `AMB_LIVE_SEND=1` + `AMB_LIVE_E2E=1` + resolvable
  `~/.secrets/amb-test.env`. Two tasks: a fresh command, then a thread reply
  that must resume the SAME codex session. No `console` (house rule applies to
  `tests/live` too); metrics go to a JSON report (`AMB_E2E_REPORT`) carrying
  only counts / durations / outcome labels / boolean leak-check results.

## Key design decisions

1. **vitest test, not a standalone script.** No `tsx` is installed; vitest is,
   handles ESM + `.js` resolution, and matches the `smtp-send-live` /
   `imap-read-live` precedent — a committed, skipped-by-default artifact that
   is the reproducible E2E going forward.
2. **Fourth gate `AMB_LIVE_E2E`.** The escalation from "send one fixed probe"
   (batch 5's `AMB_LIVE_SEND`) to "spend model quota" gets its own explicit
   opt-in, so the habitual send-suite command can never start burning quota.
3. **Codex cap enforced in the driver wrapper**, before spawn: the 3rd
   invocation throws, so a routing/thread bug cannot fan out into unbounded
   spend. Start / resume counted separately so "resume the same session" is a
   real assertion, not a guess.
4. **Fail-closed is quota-safe by construction.** If ADR-0003 were wrong (self
   mail arrives AR-bearing) the AUTH gate quarantines it → 0 dispatch → 0
   quota; if routing missed → clarification → 0 dispatch → 0 quota. Only a
   fully-aligned pipeline reaches codex. The test detects the AR case
   explicitly and reports it as an ADR-0003 falsification (red line 6).
5. **Leak checks are booleans.** The delivered reply body/subject are asserted
   NOT to contain the password, worktrees root, or home dir — never printing
   the secret operand (red line 2).

## Run + results (2026-07-20)

```sh
AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 AMB_LIVE_E2E=1 \
  pnpm exec vitest run tests/live/e2e-full-live.test.ts
```

Pass, 1 test, 104 s wall-clock. Task 1 (new): `READY_FOR_DISPATCH`,
dispatched, ~48 s round-trip, 1 codex start; Task 2 (resume): dispatched,
~52 s, 1 codex resume (total 2, cap 3); every leak check false; both replies
SENT and read back. ADR-0003 confirmed live. Full evidence:
[Phase 6 E2E acceptance](../../reports/phase-6-e2e-acceptance.md).

## Red-line accounting

- RL1 test mailbox + `os.tmpdir()` scratch repo only; RL2 no secret/address/
  path to git/logs/reply/report (no console; boolean leak checks); RL3
  authenticated self-send only (approved class A); RL5 ≤ 3 codex approved,
  actual 2 (hard-capped).

## Review

Read-only audit of the test file (leak-safety, gate correctness, assertion
meaningfulness, codex cap, watermark seeding, ADR-0003 detection, cleanup) —
explicitly forbidden from re-running the live test (it verified the clean skip
under unset gates, typecheck, and lint only). **Verdict: APPROVED**, no
Critical, no secret/address/path leak channel, gating provably blocks any
send/codex under `pnpm test`/CI, assertions substantive not vacuous, the
ADR-0003 falsification path correct and quota-free, cleanup order-safe and
confined to `os.tmpdir()`. Three non-blocking findings, all folded in before
commit:

- **I-1** — the cap permits 3 real calls and blocks the 4th (`>` not `>=`);
  within the approved ≤3 ceiling and the happy path spends 2, but the header
  said "the 3rd throws". Corrected the comment to state the ceiling-3 / 4th-
  throws behaviour accurately (behaviour unchanged — the ≤3 approval stands).
- **M-1** — task 2 now pins `body2.length > 0` before its leak checks (parity
  with task 1, so an empty body cannot vacuously pass) and adds the two
  subject leak checks task 1 already ran.
- **M-2** — `afterAll` now runs each close/rm through a best-effort `step`
  wrapper, so one rejecting close cannot strand the temp dir or a later handle.

M-3 (a benign UIDVALIDITY-change race on the watermark seed, backstopped by
the `readyAt` fence) needed no code change per the reviewer.

## Completion record

- [x] E2E test authored, typecheck + lint + skip-collection green pre-flight
- [x] Live run executed and passed (evidence above)
- [x] Docs refreshed: README status, architecture status, phase-5 exit
      criterion, ADR-0003 live-validation note, threat-model C2, new
      `reports/phase-6-e2e-acceptance.md`
- [x] Memory updated ([[adr3-accepted-e2e-approved]])
- [x] Read-only review APPROVED; I-1/M-1/M-2 folded in; four-gate green again
      (typecheck/lint/build/test) after the fixes
- [ ] Committed + CI green (this commit)
