# Coordinator E2E acceptance report — ADR-0006/0007 conversational layer (red line 5)

> Scope: the ADR-0006 conversational coordination layer (batch E-d exit),
> proven against a REAL codex. This is the run that answers the batch-D spike
> red line 5 always gated — whether `--sandbox read-only` + `--output-schema` +
> `--ignore-user-config` actually COMPOSE on codex 0.144.6 and yield a
> schema-valid decision on the JSONL stream (ADR-0007). It is the SECOND (and
> only other) test that spends real model quota besides the full-pipeline E2E.
> Executed 2026-07-22 for asynchronous user review.

## What was run

`tests/live/e2e-coordinator-live.test.ts` — a committed, triple-gated live
test (skipped by default and in CI). It assembles the daemon through the
PRODUCTION composition root (`assembleDaemon` +
`buildProductionAssemblyBuilders`) with `coordinator.enabled = true`, wrapping
only the two `SpawnCodex` seams — the execution driver's (`createCodexDriver`)
and the coordinator's (`buildCoordinatorRuntime`) — with ONE shared counter
that HARD-caps codex invocations at 4. Against a throwaway git repo under
`os.tmpdir()` (never a real project) and the dedicated test mailbox:

1. **Scenario A — a pure meta-query.** Self-sends a plain-language question
   ("which projects can you dispatch to? this is only a query, don't dispatch
   anything") with no bridge echo markers. The real mail tick fetches it,
   runs the identity/AUTH gate chain, then — because a coordinator is
   configured and the mail is thread-bound — runs ONE read-only codex
   coordinator turn. The coordinator reads the pushed snapshot and ANSWERS in
   free text (no agent executes). The scrubbed answer is mailed back and read
   over IMAP. **Only the coordinator can produce an answer — the deterministic
   router has no answer capability at all — so this is the decisive proof.**
2. **Scenario B — a natural-language command.** Self-sends "append a line to
   NOTES.md in e2e-scratch-repo, then stop" on a SEPARATE new thread. The
   coordinator DECIDES `dispatch`, the decision flows through the same shared
   execution tail (`executeDispatchVerdict`) as the deterministic path, a REAL
   `codex exec` runs in a bridge-owned worktree, and the scrubbed result is
   mailed back.

Invocation (all three gates required; the run is the MAIN session's, never a
subagent's — the coordinator gate is its OWN variable so the habitual
full-E2E command never silently doubles its spend):

```sh
AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 AMB_LIVE_COORDINATOR_E2E=1 \
  pnpm exec vitest run tests/live/e2e-coordinator-live.test.ts
```

## Results (measured)

| Signal | Scenario A (answer) | Scenario B (dispatch) | What it proves |
| --- | --- | --- | --- |
| Ingest fate | `READY_FOR_DISPATCH` | `READY_FOR_DISPATCH` | the self-mail passed **every** gate incl. AUTH (ADR-0003 holds live) |
| Coordinator turns (codex) | 1 | +1 (cumulative 2) | one read-only coordinator turn per inbound mail |
| Execution starts (codex) | 0 | 1 | answer ran NO agent; dispatch ran exactly one |
| Total codex calls | — | **3** (cap 4) | inside the approved red-line-5 budget |
| `dispatched` (agent executed) | 0 | 1 | answer resolves read-only; dispatch executes |
| Coordinator ANSWER marker (`💬 answer`) | present | — | the reply came from the coordinator, not a fallback |
| `coordinator_sessions` rows persisted | 1 | 2 | BOTH turns DECIDED (minted+persisted a thread id), neither fell back |
| Command → result-mail round-trip | **~47 s** | **~113 s** | both far inside the 10-min exit metric |
| Reply delivered (outbox → SENT, read back) | yes | yes | SMTP send + echo round-trip closed |
| Leak check — password in body/subject | false | false | C9 scrub held over model text (no credential) |
| Leak check — worktree path in body/subject | false | false | C9 scrub masked the absolute worktree path |
| Leak check — home dir in body | false | false | no home-directory string leaked |

Whole-suite wall-clock: **165 s** for both scenarios end to end.

## What this closes

- **Batch-D spike (ADR-0007 carrier): RESOLVED, positive.** `--sandbox
  read-only` + `--output-schema` + `--ignore-user-config` compose on codex
  0.144.6 and the decision arrives cleanly on the JSONL stream as the final
  `agent_message` — no `-o/--output-last-message` fallback was needed. The
  read-only coordinator turn returned a schema-valid `{"decision": {...}}`
  envelope that `parseCoordinatorDecisionEnvelope` accepted. This was the one
  question the unit suite could not answer; it is now answered against the
  real binary.
- **Coordinator ANSWER path: works end to end.** A pure meta-query produced a
  `💬 answer` reply (marker present, `dispatched = 0`, one coordinator turn,
  zero execution turns). Because the deterministic router cannot answer, this
  can ONLY be the coordinator — the conversational read half of ADR-0006 is
  live.
- **Coordinator DISPATCH path: flows through the shared execution tail.** A
  natural-language command the deterministic router's subject-`term` extractor
  would not have routed was understood by the coordinator, decided `dispatch`,
  and executed a real `codex exec` — reusing `executeDispatchVerdict`, the same
  audited tail the deterministic path uses.
- **Both turns DECIDED, not fell back.** Two `coordinator_sessions` rows (one
  per thread) prove each coordinator turn minted and persisted a codex thread
  id — the ADR-0006 three-layer mapping's third layer, populated live.
- **C9 render scrub: verified live over UNTRUSTED MODEL TEXT.** The coordinator
  answer is model output exactly like a driver's, and it carried no credential,
  no absolute worktree path, and no home-directory string.

## Red-line accounting

- **Red line 1** — only the dedicated test mailbox was touched; the only
  project the bridge worked in was a throwaway git repo under `os.tmpdir()`,
  removed on teardown. No real mailbox, no real project.
- **Red line 2** — no credential, real address, or real local path was written
  to git, logs, or reply text. The test emits no console output; its JSON
  report carries only counts, durations, outcome labels and boolean leak-check
  results. Every leak assertion is a boolean, never a printable secret operand.
- **Red line 3** — the only mail sent was authenticated self-send
  (`from == to == self`, "方案 A", previously approved); the control mails
  deliberately omit the bridge's echo markers so ingest treats them as genuine
  commands.
- **Red line 5** — the real coordinator E2E was pre-estimated (~3 codex calls,
  cap 4) and the run was user-approved before any spend; actual spend was
  exactly **3**, enforced in-process by a hard cap that throws before a 5th
  spawn.
- **Red line 6** — `allowResume` stayed OFF (production-hardcoded, no config
  knob): every coordinator turn was a fresh `--sandbox read-only` turn, never
  the unpinned resume-read-only path. Multi-turn coordinator resume remains
  gated on its own spike and is NOT exercised or enabled here.

## Limitations / still open (honest)

- **Single run.** One successful end-to-end pass per scenario; not a
  statistical distribution. The round-trip times are indicative, not a
  benchmarked P95.
- **Multi-turn coordinator resume is NOT validated.** `allowResume = false`
  means each turn is independent; the read-only wall on a RESUMED coordinator
  turn (codex 0.144.6 `exec resume` rejects `--sandbox`) is still an unpinned
  config key and is deliberately not enabled. Conversational clarify that spans
  turns therefore does not yet carry context across mails — a known, fail-closed
  trade (red line 6), tracked for a resume-specific spike.
- **`clarify` path not exercised live.** Scenarios A and B cover answer and
  dispatch; a coordinator `clarify` decision (ambiguous intent) is unit-covered
  but was not driven against real codex here (it needs a deliberately ambiguous
  prompt and would spend an extra turn).
- **Coordinator disabled by default.** `coordinator.enabled` defaults to absent
  (deterministic router only); this E2E is the evidence that flipping it on is
  safe, not a change to the shipped default.

## Reproduction

The test is self-contained: it creates its own scratch repo, SQLite store,
worktrees root and coordinator read-only scratch dir under a temp dir, seeds
the `readyAt` fence and UID watermark so the first tick sees only fresh mail,
and cleans everything up in `afterAll`. Set `AMB_E2E_COORDINATOR_REPORT=<path>`
to capture the metrics JSON. Requires `~/.secrets/amb-test.env` (the dedicated
test mailbox) and an authenticated `codex` CLI on `PATH`.
