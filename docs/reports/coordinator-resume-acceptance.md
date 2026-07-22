# Coordinator resume acceptance report — ADR-0008 red-line-6 closure (red line 5)

> Scope: enabling ADR-0006 multi-turn coordination (`codex exec resume`) after
> proving its read-only wall against real codex — the red-line-6 gap batch E-d
> had fail-closed OFF. Two parts, both spending real model quota (red line 5,
> user-approved): a direct-codex read-only SPIKE (5 calls) and a daemon-level
> multi-turn resume E2E (2 calls). Executed 2026-07-22 for asynchronous review.

## The gap this closes

codex 0.144.6 `exec resume` does NOT accept `--sandbox` (ADR-0004 asymmetry).
A new coordinator turn asserts `--sandbox read-only`; a resumed turn cannot
repeat it. Batch E-d therefore pinned `allowResume` OFF (every turn a fresh
read-only turn, losing cross-mail memory) rather than ship an unverified
read-only wall on resume — RED LINE 6, fail closed. This work supplies the
evidence and flips it on.

## Part 1 — the resume read-only spike (direct codex, filesystem ground truth)

Each probe asks codex to write a file, then checks whether the file actually
landed on disk (NOT codex's self-report). All under a throwaway `os.tmpdir()`
scratch; placeholder paths; 5 codex calls, hard-capped at 8.

| Call | argv | Wrote probe? | Conclusion |
| --- | --- | --- | --- |
| A — new turn | `exec --sandbox read-only …` | **no (blocked)** | new-turn wall holds; probe method sound |
| B — resume, no key | `exec resume <id>` (production's old shape) | **no (blocked)** | resume is read-only BY DEFAULT — inherits the creation sandbox (ADR-0004 confirmed live) |
| C — resume + key | `exec resume <id> -c sandbox_mode="read-only"` | **no (blocked)** | explicit key compatible with read-only |
| D — new, writable | `exec --sandbox workspace-write …` | **yes (wrote)** | control: creation sandbox writable; probe distinguishes pass/block |
| E — resume + key on the D session | `exec resume <D-id> -c sandbox_mode="read-only"` | **no (blocked)** | **decisive**: the key OVERRIDES a workspace-write creation sandbox back to read-only on resume |

codex's self-reports matched the filesystem exactly (A/B/C/E "BLOCKED",
D "SUCCEEDED"). **Verdict:** the resume read-only wall is doubly guaranteed —
creation-sandbox inheritance (B) AND an independently-enforcing
`-c sandbox_mode="read-only"` key (E). Recorded as
[ADR-0008](../adr/0008-coordinator-resume-read-only-verified.md).

## Part 2 — the wiring (driver invariant, not a wiring option)

- `coordinatorDriver.ts` now emits `COORDINATOR_RESUME_SANDBOX_ARGS`
  (`-c sandbox_mode="read-only"`) on the resume branch, BEFORE `extraArgs`, so
  no caller omission can drop the wall — the resume twin of the new turn's
  positively-asserted `--sandbox read-only`. Unit-pinned.
- `buildCoordinatorRuntime` enables `allowResume`; the config schema still
  exposes no `allowResume` knob (resume is a verified invariant, not an operator
  toggle). Full unit suite (969) green, tsc + eslint clean.

## Part 3 — the multi-turn resume E2E (daemon, real codex)

`tests/live/e2e-coordinator-resume-live.test.ts` — a triple-gated live test
(own gate `AMB_LIVE_COORDINATOR_RESUME_E2E`, separate from the other coordinator
E2E's so it never silently doubles that command's spend). The resume proof is
built to be **impossible to fake**: turn 1 plants a nonce
(`amb-resume-nonce-42`) in the coordinator's codex thread; turn 2 (a thread
reply) asks the coordinator to recall it and nothing else. The nonce is NOT a
project/session name, so it never enters turn 2's pushed snapshot (ADR-0007) —
the ONLY place it survives is the resumed codex thread.

| Signal | Turn 1 (clarify) | Turn 2 (resume) | What it proves |
| --- | --- | --- | --- |
| Ingest fate | `READY_FOR_DISPATCH` | `READY_FOR_DISPATCH` | both self-mails passed every gate |
| Coordinator turn | 1 new | 1 **resume** | turn 2 was a real `exec resume` |
| Execution starts | 0 | 0 | read-only throughout; no agent ran |
| Reply marker | `❓ clarification` | `💬 answer` | clarify-live confirmed; turn 2 answered |
| `coordinator_sessions` rows | 1 | 1 (same id) | one conversation per thread; resume reused the id |
| **Nonce recalled in answer** | — | **yes** | **resume carried turn-1 context across the mail boundary** |
| Round-trip | ~43 s | ~43 s | both far inside the 10-min exit metric |
| Leak checks (pass/worktree/home) | all false | all false | C9 scrub held over model text |

Total codex spend: **2** (both coordinator turns, zero execution). Whole-suite
wall-clock **91 s**.

## What this closes

- **Red-line-6 gap: CLOSED, positive.** The resume read-only wall is verified
  two independent ways and shipped as a driver invariant.
- **Multi-turn coordination (ADR-0006): live.** A thread reply resumes the SAME
  codex conversation with real cross-turn memory — the nonce recall is decisive,
  not circumstantial.
- **Clarify path: live.** An under-specified request produced a `❓ clarification`
  reply (coordinator-only capability).
- **Three-layer mapping: live.** `coordinator_sessions` bound the thread to one
  codex thread id, reused unchanged on resume.

## Red-line accounting

- **Red line 1** — only the dedicated test mailbox and throwaway `os.tmpdir()`
  scratch/repos; removed on teardown.
- **Red line 2** — no credential/address/path in git, logs, or replies; both
  reports carry only counts, labels and boolean leak-checks; the nonce is a
  low-entropy non-secret test token.
- **Red line 3** — authenticated self-send only; control mails omit the bridge
  echo markers so ingest treats them as genuine commands.
- **Red line 5** — the spend was pre-estimated (~5 calls, cap 8) and
  user-approved before any run; actual: **7** (5 spike + 2 E2E), each phase
  hard-capped in process.
- **Red line 6** — the whole point: the fail-closed OFF posture was flipped ONLY
  after filesystem-verified proof the wall holds; `--dangerously-bypass-*` /
  `workspace-write` never appeared on any coordinator argv.

## Limitations / still open (honest)

- **Single run per turn**; round-trip times are indicative, not benchmarked.
- **codex-version-bound.** The two resume behaviors (creation inheritance; the
  `sandbox_mode` key overriding on resume) are pinned to codex 0.144.6 — ADR-0008
  lists the regression triggers (CLI major/minor bump; sandbox/config surface
  change) at which to re-run the spike.
- **`dispatch`-on-resume not exercised live.** Turn 2 was a read-only recall; a
  resumed turn that then DISPATCHES (executes) is unit-covered but not driven
  live here (it would spend an execution turn).

## Reproduction

Self-contained (own scratch repo/store/coordinator dir under a temp dir; seeds
the readyAt fence + UID watermark; cleans up in afterAll). Set
`AMB_E2E_COORDINATOR_RESUME_REPORT=<path>` for the metrics JSON. Requires
`~/.secrets/amb-test.env` and an authenticated `codex` CLI on `PATH`.
