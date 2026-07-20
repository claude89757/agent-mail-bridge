# Phase 6 acceptance report — full-pipeline E2E (red line 5)

> Scope: the spec §6 MVP exit criterion — "a clean machine goes from README
> to the first result mail in ≤ 10 minutes" — measured against the REAL chain,
> plus the live confirmation of ADR-0003 (identity-gate polarity inversion)
> and the C9 render scrub. This is the one run that spends real model quota
> (AGENTS.md red line 5). Executed 2026-07-20 for asynchronous user review.

## What was run

`tests/live/e2e-full-live.test.ts` — a committed, quadruple-gated live test
(skipped by default and in CI). It assembles the daemon through the
PRODUCTION composition root (`assembleDaemon` +
`buildProductionAssemblyBuilders`), wrapping only `buildDriver` to count and
HARD-cap codex invocations at 3. It then, against a throwaway git repo under
`os.tmpdir()` (never a real project) and the dedicated test mailbox:

1. **Task 1 — a brand-new command.** Self-sends an ordinary mail (bare
   nodemailer, no bridge echo markers), lets the real mail tick fetch it over
   IMAP, run it through the real ingest gate chain
   (echo → readyAt → C1 identity → AUTH → window), route it to the scratch
   repo, dispatch a REAL `codex exec` in a bridge-owned worktree, scrub the
   result and mail it back over SMTP, then reads the reply back over IMAP.
2. **Task 2 — a thread reply.** Self-sends a reply on Task 1's thread; thread
   continuity resumes the SAME codex session (a `resumeTask`, not a fresh
   `startTask`) and mails a second scrubbed result back.

Invocation (all four gates required; the run is the MAIN session's, never a
subagent's):

```sh
AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 AMB_LIVE_E2E=1 \
  pnpm exec vitest run tests/live/e2e-full-live.test.ts
```

## Results (measured)

| Signal | Task 1 (new) | Task 2 (resume) | What it proves |
| --- | --- | --- | --- |
| Ingest fate | `READY_FOR_DISPATCH` | `READY_FOR_DISPATCH` | the self-mail passed **every** gate incl. AUTH — ADR-0003 holds live |
| Dispatched (codex executed) | 1 | 1 | a real codex task ran each time |
| codex calls (start / resume) | 1 / 0 | 1 / 1 | resume reused the same session, not a new one |
| Total codex calls | — | **2** (cap 3) | inside the approved red-line-5 budget |
| Command → result-mail round-trip | **~48 s** | **~52 s** | both far inside the 10-min exit metric |
| Reply delivered (outbox → SENT, read back) | yes | yes | the SMTP send + echo round-trip closed |
| Leak check — password in body/subject | false | false | C9 scrub held (no credential) |
| Leak check — worktree path in body/subject | false | false | C9 scrub masked the absolute worktree path |
| Leak check — home dir in body | false | false | no home-directory string leaked |

Whole-suite wall-clock: **104 s** for both tasks end to end.

## What this closes

- **Exit metric (spec §6): MET.** README → first result mail is dominated by
  the ~48 s machine round-trip; the 10-minute budget is spent almost entirely
  on a human doing first-time setup, not on the pipeline.
- **ADR-0003: confirmed live.** The authenticated self-mail arrived carrying
  no `Authentication-Results` header and therefore passed the wired AUTH
  factor (`READY_FOR_DISPATCH`). The test is written to fail loudly, and
  WITHOUT spending any quota, had the mail instead been quarantined
  `AUTH_RESULTS_PRESENT` (which would have falsified the ADR under red line 6).
  It was not.
- **Thread-continuity resume: works end to end** against real `codex`
  session semantics (ADR-0004), returning to the original worktree.
- **C9 render scrub: verified live** — the delivered replies carried no
  credential, no absolute worktree path, and no home-directory string.

## Red-line accounting

- **Red line 1** — only the dedicated test mailbox was touched; the only
  project the bridge worked in was a throwaway git repo under `os.tmpdir()`,
  removed on teardown. No real mailbox, no real project.
- **Red line 2** — no credential, real address, or real local path was
  written to git, logs, or reply text. The test emits no console output; its
  JSON report carries only counts, durations, outcome labels and boolean
  leak-check results. Every leak assertion is a boolean, never a printable
  secret operand.
- **Red line 3** — the only mail sent was authenticated self-send
  (`from == to == self`, "方案 A", previously approved); the control mails
  deliberately omit the bridge's echo markers so ingest treats them as
  genuine commands.
- **Red line 5** — real E2E budget was pre-approved (≤ 3 codex calls); actual
  spend was exactly **2**, enforced in-process by a hard cap that throws
  before a 3rd spawn.

## Limitations / still open (honest)

- **Single run.** One successful end-to-end pass; not a statistical
  distribution. The round-trip times are indicative, not a benchmarked P95.
- **方案 B forged-From controls** (external-origin mail with a forged
  `From: <self>`) remain un-exercised (ADR-0003 item 2) — a user-side probe,
  never blocking, and the AUTH gate rejects on AR *presence* regardless.
- **Interactive clarification flow** (`1`/`2`/`new`) still awaits the
  real-device walkthrough (spec open question 2) — out of scope here.

## Reproduction

The test is self-contained: it creates its own scratch repo, SQLite store and
worktrees root under a temp dir, seeds the `readyAt` fence and UID watermark
so the first tick sees only fresh mail, and cleans everything up in
`afterAll`. Set `AMB_E2E_REPORT=<path>` to capture the metrics JSON. Requires
`~/.secrets/amb-test.env` (the dedicated test mailbox) and an authenticated
`codex` CLI on `PATH`.
