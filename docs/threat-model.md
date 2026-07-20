# Threat Model — v0.1 (in progress)

> Status: originally written before the first line of pipeline code (Phase 0);
> updated at the Phase 2 exit with test evidence for the controls that are now
> implemented (see the **Evidence** lines under §5 — the
> [Phase 2 acceptance report](reports/phase-2-acceptance.md) maps each to spec
> criteria). Sources: roadmap spec §1.3/§3.3/§3.4 and the archived
> pre-development research. Items marked **[P0-x]** await measurement in the
> Phase 1 spikes; where reality disagrees with an assumption here, the bridge
> fails closed and this document plus an ADR are updated first.

## 1. What the system is

A local daemon that watches one personal mailbox over IMAP, treats mail the
owner sends to themself as control input, dispatches tasks to a local coding
agent (Codex first) inside bridge-owned git worktrees, and replies with results
over SMTP. No third-party relay: the mail provider is the only intermediary.

## 2. Assets

| Asset | Why it matters |
| --- | --- |
| Local repositories and uncommitted work | the agent can write code; the user's working tree must never be touched |
| Local shell execution (via the agent) | remote code execution is the worst-case outcome |
| Mailbox app password / IMAP+SMTP credentials | full mailbox takeover if leaked |
| Mail contents (both directions) | may contain code excerpts, task context |
| Model quota / compute | attacker-triggered runs cost real money |
| The user's trust in the project | one security incident sinks an open-source security tool |

## 3. Trust assumptions

1. **The mailbox account is the security boundary.** Whoever fully controls the
   mailbox (password, delegate access, device session) controls the bridge.
   We make forging *into* that mailbox from outside useless, but we do not
   defend against a compromised account itself.
2. **Mail bodies are untrusted user input, never configuration.** Bodies can
   carry prompt-injection payloads; they only ever reach the sandboxed task,
   never the router's control decisions (the v0.1 router calls no model at all,
   decision D5).
3. The local machine, its OS keychain, and the installed agent CLI are trusted.
4. The mail provider's `Authentication-Results` evaluation (DKIM/SPF) is
   trusted as an identity oracle. **[P0-3]** measures its exact shape for
   self-to-self Gmail delivery; if the header is absent on the internal path,
   equivalent `Received`/provider-specific evidence replaces it — decided by
   measurement, not assumption.

## 4. Attackers and scenarios

| # | Attacker | Scenario | Primary controls (§5) |
| --- | --- | --- | --- |
| A1 | External sender, no account access | Forges `From: you@provider` to inject a command | C1, C2 |
| A2 | External sender | Sends prompt-injection body hoping it reaches an agent with tools | C1–C2 stop dispatch; C6/C7 bound the blast radius if any body reaches a task |
| A3 | Anyone | Replays an old control mail or a stale clarification reply | C4, C5, C8 |
| A4 | The bridge itself | Self-triggering loop: result mail re-ingested as a command | C3 |
| A5 | Compromised mailbox account | Sends valid self-mail commands | out of scope for identity checks; C6/C7 cap what execution can do; pause/logout is the kill switch |
| A6 | Malicious repo content (fetched deps, hooks) | Task escapes the sandbox or writes outside the worktree | C6, C7 (agent sandbox `workspace-write`, no network by default; bridge-owned worktree; path realpath checks) |
| A7 | Curious eyes on the repo / logs / replies | Credentials or private paths leak | C9, C10 |

## 5. Controls

Every control is testable; MVP acceptance (spec §6) requires evidence.

- **C1 — Strict self-addressing.** RFC 5322 addr-spec of `From` and `To` must
  both equal the configured self address; empty `CC`; multi-recipient rejected;
  aliases/`+tag` rejected in v0.1.
  *Evidence:* `src/domain/identity.ts` + `tests/unit/domain-identity.test.ts`
  (all five violation classes + priority order); integration: 5/5 forged-From
  mails rejected in the mixed-stream test
  (`tests/integration/ingest-pipeline.test.ts`).
- **C2 — Provider authentication factor.** `Authentication-Results` must show
  `dkim=pass` with the signing domain aligned to the self domain (gmail.com
  publishes DMARC `p=none`, so we must check this ourselves — the provider will
  not reject forgeries for us). Exact self-to-self form: **[P0-3]**.
  *Evidence (partial):* the deterministic half is implemented — tolerant
  parser + fail-closed verdict (`src/domain/authResults.ts`,
  `tests/unit/domain-auth-results.test.ts`): single-pass comment stripping
  and the sole `/\s+/` regex keep it ReDoS-free (adversarial review
  stress-tested 4 MB crafted inputs and parser state-confusion sequences);
  exact-equality domain match pins subdomains to `DOMAIN_MISMATCH` both
  directions, and homograph/NFC-variant domains never compare equal (fail
  closed). **P0-3 measured (2026-07-19): legitimate self-submitted mail
  carries NO `Authentication-Results` at all** (SMTP and web/app paths
  short-circuit past MX), while every MX-ingested external sample carries
  them. [ADR-0003](adr/0003-self-mail-carries-no-auth-results.md) was
  **accepted (2026-07-20)** and the factor is now **wired into ingest**
  (`checkSelfSubmissionAuthFactor`, `src/application/ingest.ts` between the
  C1 and time-window gates): the polarity is inverted for `From==To==self`
  mail — **AR present ⇒ external MX origin ⇒ quarantine `AUTH_RESULTS_PRESENT`;
  none present ⇒ authenticated internal self-submission passes**. The reject
  trigger is AR *presence* (raw header existence), strictly more conservative
  than a `dkim=pass` verdict check or an authserv-id allowlist — it cannot
  fail open on a Gmail authserv-id string change, and because inversion means
  "more AR ⇒ more likely rejected" an attacker-injected extra AR only helps
  the reject. The topmost `authservId` is extracted as reject **evidence**
  only, never an accept filter; `checkDkimFactor`'s pass-requiring form stays
  in the codebase for any future non-self-mail path. *Evidence:* the MVP
  "forged From ⇒ 0 trigger" DKIM half is a synthetic-fixture integration test
  asserting outcome `rejected` + reason `AUTH_RESULTS_PRESENT` + `intent
  count === 0` (`tests/integration/ingest-pipeline.test.ts`); the gate order
  `echo → readyAt → C1 → AUTH → window` is pinned (echo-before-AUTH so the
  bridge's own replies are never quarantined, C1-before-AUTH so non-self mail
  leaks no AR verdict, AUTH-before-window so forged mail terminates `rejected`
  not parked `QUEUED_WINDOW`); security review APPROVED after challenging the
  fail-closed posture with 3 penetration probes (parsed-length presence,
  verdict-trust reintroduction, echo-order swap — each caught by existing
  tests) and replaying 4+3 mutations. **Confirmed live (2026-07-20):** the
  full-pipeline E2E drove a real authenticated self-mail through the wired
  gate and it reached `READY_FOR_DISPATCH` (no AR present), exactly as
  ADR-0003 predicts — the test would have surfaced an `AUTH_RESULTS_PRESENT`
  quarantine as a falsification and did not
  ([Phase 6 E2E acceptance](reports/phase-6-e2e-acceptance.md)). Real
  forged-From controls (方案 B) stay a user gate; the 8/8 external MX sample
  already grounds the mechanism.
- **C3 — Echo gate.** Bridge-sent mail carries an own `Message-ID` and
  `X-AMB-Outbox-ID`; both are recorded before send, so inbound copies are
  classified `SYSTEM_ECHO` and never routed.
  *Evidence:* outbox rows recorded before the send resolves (fake transport
  mirrors the real order, `tests/helpers/fakeTransport.ts`); 20/20 reflected
  replies classified `echo`, zero intents
  (`tests/integration/ingest-pipeline.test.ts`, exact-equality assertion).
  The REAL send path now enforces the same order — mint → `await
  registerOutbox` → SMTP submit, register-failure ⇒ the mail is never
  submitted, pending-register pinned with a deferred-promise test
  (`src/transports/imapRead.ts` send, batch-5) — and both echo markers
  round-tripped live through Gmail: 1 production-path self-send came back
  with the minted `Message-ID` byte-identical and `x-amb-outbox-id` first
  instance equal to the registered outbox id
  (`tests/live/smtp-send-live.test.ts`, 1/1 in 12 s, 2026-07-19). The
  daemon side now closes the send-state loop (`src/daemon/replySender.ts`,
  `src/daemon/ticks.ts`): a resolved send transitions the outbox row
  SENDING→SENT; a rejected send transitions it to UNCERTAIN and is NEVER
  retried automatically (a mutation injecting a second `transport.send`
  is killed by a dedicated test — "isolate and reconcile, never blind
  resend", effectively-once); the ONLY path out of UNCERTAIN is
  reconciliation against the bridge's own echo arriving back (normalized
  `Message-ID` match — stored normalized precisely so the echo gate's key
  and the reconciliation key are the same key), and a mutation relaxing
  reconciliation to non-UNCERTAIN rows is likewise test-killed. Crash
  windows that strand a SENDING row now converge: the daemon shell runs
  `sweepStrandedSending` at every startup (after intent crash recovery,
  before the poll loop — order pinned by the startup-sequence test in
  `tests/unit/daemon-shell.test.ts`), moving SENDING→UNCERTAIN so the
  row rejoins the reconciliation track instead of sitting outside it
  forever (SENT rows untouched, `tests/unit/daemon-ticks.test.ts`).
- **C4 — Time fence.** `INTERNALDATE` ≥ persisted `readyAt` from first setup:
  a fresh install can never execute historical mail.
  *Evidence:* `BEFORE_READY` rejection + fail-closed `NO_READY_AT` when unset
  (`tests/unit/ingest.test.ts`); `readyAt` is written once by `amb setup` and
  never overwritten (`tests/unit/cli-setup.test.ts`, first-value-wins test).
- **C5 — Idempotency.** Message-ID unique index in SQLite; at-least-once
  ingest with exactly-one persistent dispatch intent per control mail; crash /
  redelivery / reorder produce no duplicate dispatch.
  *Evidence:* 150 shuffled deliveries of 50 mails ⇒ exactly 50 commands/50
  intents (`tests/integration/ingest-pipeline.test.ts`); rollback at every
  transaction boundary + file-backed restart
  (`tests/integration/crash-recovery.test.ts`); intent-id collision fails
  closed (`src/application/ingest.ts` guard).
- **C6 — Execution ceiling.** `codex exec --sandbox workspace-write` maximum;
  `danger-full-access` and `--dangerously-bypass-*` are forbidden; mail cannot
  change model, sandbox, or approval settings.
  *Evidence (partial):* `CodexDriver` builds its argv as a fixed array —
  element-exact-equality tests pin `--sandbox workspace-write` on task
  start and the ABSENCE of every forbidden flag (`--dangerously-*`,
  `danger-full-access`, and `--ephemeral`, which would break resume); the
  resume argv carries no sandbox flag at all because the sandbox is fixed
  at session creation (ADR-0004's measured option asymmetry — mail could
  not lower it later even if it tried). A resume session id must match a
  lowercase-UUID whitelist before it may enter the argv (no shell anywhere,
  prompt is a single argv element), and `dryRun` reaching the driver throws
  without spawning (`src/drivers/codexDriver.ts`,
  `tests/unit/codex-driver.test.ts`). The dispatch use case
  (`src/application/dispatch.ts`) now pins the consumption side: the driver
  only ever receives a cwd that came out of `createTaskWorktree` (C7's
  output) or a persisted `worktree_path` whose directory must still exist
  (resume fails closed on a missing tree rather than picking a new one),
  dry-run intents are short-circuited to `SKIPPED_DRY_RUN` before any
  worktree or driver call (the driver's own dryRun throw stays an
  unreachable second line), and a driver stream that ends without its
  contractual terminal event throws fail-closed — a mutation replacing
  that throw with a fabricated terminal outcome is killed by a dedicated
  test, so execution results can not be silently invented
  (`tests/unit/dispatch.test.ts`). Real-task E2E remains user-gated
  (red line 5).
- **C7 — Worktree isolation.** Writes happen only in bridge-owned worktrees
  created from an explicit base commit under a controlled root; the user's
  worktrees and uncommitted changes are never touched; merging back is a local,
  human action. Project targeting is allowlist + realpath, no symlink escape,
  and mail cannot name arbitrary paths.
  *Evidence (partial):* the worktree manager is implemented
  (`src/application/worktreeManager.ts`, 38 tests incl. real-git
  integration): taskId whitelist, realpath prefix containment, base ref
  resolved to an explicit sha via `rev-parse --verify --end-of-options`
  with the returned sha format-validated before it may enter the
  `worktree add` argv, `--detach` always, remove never forces by default,
  and a call-sequence assertion proves no git subcommand beyond
  `worktree add`/`remove` ever runs (no checkout/reset). Symlink planted at
  the target path is rejected by the `exists()` gate
  (mutation-verified — git alone would check out through it), the dangling
  variant by git's own refusal. The "mail cannot name arbitrary paths" half
  now has its enforcement point: the project allowlist/index
  (`src/application/projectIndex.ts`, 36 tests) is built once from
  operator-configured roots/aliases, offers exact name/alias lookup only
  (path-flavored terms return nothing, no fuzzy matching a crafted body
  could probe), reports-and-excludes symlinked children escaping their
  root, and is the sole source of paths handed to the worktree manager —
  which re-realpaths at execution time. Router wiring of the lookup is
  Phase 4.
- **C8 — Clarification binding.** Clarification replies must match token +
  thread + candidate-set version and TTL; late or stale replies are quarantined.
  *Evidence (partial):* the deterministic half is implemented and test-pinned
  (38 tests). The domain (`src/domain/clarificationState.ts`) provides the
  fourth state machine (PENDING → CONSUMED/EXPIRED/SUPERSEDED, terminals
  dead-end) and `checkClarificationBinding`: fail-closed four-factor check
  with a FIXED reason priority (NOT_PENDING > TOKEN_MISMATCH > VERSION_STALE >
  EXPIRED_AT_REPLY) so a dead record's status is reported before anything
  about the reply — an attacker probing a resolved thread learns nothing
  about its token/version/TTL from the reason; token compares `===` verbatim
  (no trim, no case folding), missing extractions (`null`) reject, and
  `now === expiresAt` already rejects (lexicographic ISO comparison, readyAt
  convention). The store (`src/store/clarificationStore.ts`, migration 003,
  STRICT + FK enforced) guarantees "never two PENDING per command":
  `create` supersedes (reason `REISSUED`) then inserts inside ONE
  transaction — atomicity mutation-verified twice, independently by
  implementer and reviewer (stripping the transaction wrapper flips the
  rollback tests red). The routing side of "low confidence always clarifies"
  is now a pinned pure function: `routeCommand` (`src/domain/routing.ts`)
  admits exactly four verdicts (continue thread session / dispatch on a
  UNIQUE exact match / clarify on ambiguity / clarify on no-match), takes
  pre-extracted values plus pre-executed lookup results only — it never
  sees the full index, so fuzzy matching is structurally impossible at
  this layer, not merely forbidden — and the thread↔session mapping it
  consults persists with a first-write invariant on the driver session id
  (`src/store/sessionStore.ts`, migration 004: a recorded id is never
  silently replaced; a different id is an anomaly and throws, per
  ADR-0004's measured stable-thread_id semantics). The lookup → verdict →
  execution wiring is now in place (`src/application/dispatch.ts`): a
  CLARIFY verdict short-circuits with ZERO side effects — the intent row
  stays PENDING untouched and spies pin that no session row, worktree, or
  driver call happens — and clarification-beats-dry-run is
  mutation-verified (execution is the only thing dry-run can skip). The
  daemon ticks add the EXPIRED trigger (`sweepExpiredClarifications`,
  sharing the exact `<=` boundary with the reply-time rejection so sweep
  and reject can never disagree about the same instant) and a
  pre-walkthrough stopgap for unroutable commands: ONE "cannot route"
  reply (candidate names only, never paths, scrubbed), deduplicated
  through the outbox row itself, with the intent deliberately HELD at
  PENDING — no guessing, no retry storm, upgraded to the real
  clarification flow (token + record riding the outbox transaction +
  reply parsing) once the real-device walkthrough locks the mail format
  (spec line 213).
- **C9 — Outbound hygiene.** Replies go to self only (CC/BCC/attachments
  mechanically impossible), size-capped, with secrets, absolute paths, and
  large diffs redacted.
  *Evidence (partial):* the transport half is mechanical now —
  `OutboundMail` has no recipient field at the seam, `send()` builds
  `to === from === selfAddress` internally, and a sorted-exact-keys
  assertion pins the submitted message to EXACTLY six fields so a future
  cc/bcc/replyTo turns tests red before it can widen where mail goes
  (`src/transports/imapRead.ts`, `tests/unit/imap-read-transport.test.ts`);
  CRLF header injection is neutralized by nodemailer's header encoding
  (review-verified at 9.0.3, documented at `buildDefaultSmtpSend`).
  The rendering half — the NON-OPTIONAL obligation carried since the
  batch-6 review (`CodexDriver` scrubs only its synthesized `failed`
  errorText; `agent-message`/`tool-activity` text flows through UNSCRUBBED
  by design) — is now implemented and pinned
  (`src/domain/replyComposition.ts`, `tests/unit/reply-composition.test.ts`):
  every composer routes ALL driver-event text, terminal text, failure
  reasons, and the subject line through one scrub funnel (worktree/home
  literals → `<cwd>`/`<home>` placeholders, then keyword-value masking,
  then a ≥48-char token heuristic — order pinned by tests because
  reversing it tears paths into recoverable fragments), normalizes the
  subject to a single line BEFORE scrubbing (the review's adversarial
  probe showed newline-glue could otherwise rebuild a `password:\nvalue`
  pair — the funnel lesson: normalize before masking), size-caps with
  scrub-before-truncate (a secret straddling the cut line can not
  survive as a fragment), and never renders project PATHS at all in
  clarification candidate lists (pinned as "don't render", independent
  of scrubbing). Leak canaries are mutation-verified layer by layer
  (13 kills across implementer + reviewer, 44 adversarial probes, a
  20k-seed idempotency fuzz, and ReDoS timing checks). Honest residuals,
  documented in the module: the secret heuristics are a FLOOR not a
  guarantee, large-diff redaction is implemented as capping (no diff
  syntax detection), and path masking is literal and case-sensitive — a
  deliberately case-mangled path would survive, accepted because event
  paths originate from the bridge's own byte-identical cwd argument and
  the mail's only recipient is the operator themselves. Note one NEW
  inbound content source since batch 10: `IncomingMail.bodyText` (decoded
  mail bodies now flow through the pipeline as the task prompt). Prompts
  are consumed by the driver, not echoed into replies; anything of them
  that resurfaces in agent event text exits through the same composition
  funnel above, and live tests never print body content (boolean/length
  assertions only). Send wiring (outcome → compose → transport) is the
  daemon batch's.
- **C10 — Credential hygiene.** App password in the OS keychain (macOS;
  Linux story tracked as an open question), never in git/logs/replies; public
  repo enforces secret scanning in CI from day one.
  *Evidence (partial):* `amb doctor`/`amb setup` verify the credentials env
  file is exactly mode 0600 in a 0700 directory via `stat` only — the file
  content is never read by the CLI (`src/cli/doctor.ts`,
  `tests/unit/cli-doctor.test.ts` incl. the setuid-bit case); gitleaks runs in
  CI. The daemon composition root reads the file at runtime fail-closed
  (missing key ⇒ error naming the KEY only, never echoing values,
  `src/daemon/assembly.ts`), and a five-sink stdio guard test pins that
  running the production credentials + transport wiring emits neither user
  nor password on `console.log/error/warn` or raw
  `process.stdout/stderr.write` — review-injected leak probes at two
  positions (a `console.error` inside the production transport builder and
  a raw `stderr.write` inside the file reader) each turn exactly this one
  test red (`tests/unit/cli-start.test.ts`, zero-connection: hoisted
  `imapflow` mock also pins `logger === false`, no `debug`, `secure:
  true`, creds reaching only the `auth` field). That residual is now
  closed: the `assembleDaemon` body AND its `close()` closure (which
  lexically captures the credentials) run under the same five-sink spy —
  the batch-12/13 review probes at both positions each turn exactly one
  test red (`tests/unit/daemon-assembly.test.ts`). The daemon's file-log
  surface (`src/cli/logSink.ts`, shift-rotated `amb.log`) sits BEHIND the
  same scrub funnel as the console — every line is scrubbed before the
  tee, and the sink's own failure reporter is scrub-wrapped in production
  (`src/cli/start.ts`) because raw fs errors can embed expanded home
  paths. `amb status` reports the DB view only and never echoes the
  mailbox address; `amb install`/`uninstall` print every path in `~/`
  tilde form (test-pinned against the expanded homedir appearing).
  Keychain storage itself is still the open ADR noted above.

## 6. Explicit non-goals (v0.1)

- No defense against a fully compromised mailbox account or local machine
  (see A5; documented as the user's residual risk).
- No interactive approval-by-mail (excluded from v0.1; needs one-time nonce +
  short TTL + diff-hash binding — designed in the app-server phase).
- No guarantee of unbounded offline catch-up: beyond the provider's retention
  windows the bridge enters bounded recovery or asks the human.
- Exactly-once delivery is not claimed anywhere; the system is
  effectively-once via idempotency and quarantine-based reconciliation.
- Not a tool for evading employer policy; see the compliance note in the spec
  (§1.4) — personal mailbox, personal device, personal projects.

## 7. Open measurement items

| Item | Where decided | Status |
| --- | --- | --- |
| Self-to-self Gmail `Authentication-Results` shape | [ADR-0003](adr/0003-self-mail-carries-no-auth-results.md) | **measured — there are none on legitimate self-mail**; polarity-inverted gate **accepted (2026-07-20) and wired** into ingest (presence-only reject) |
| IMAP IDLE reconnect / UIDVALIDITY behavior in practice | [ADR-0002](adr/0002-p0-1-gmail-imap-smtp-go.md) | **complete — Go** (read + send halves measured; self-send visibility ~15–30 s) |
| `codex exec --json` session id extraction and resume semantics | [ADR-0004](adr/0004-p0-2-codex-exec-session-semantics.md) | **complete — Go** (`thread.started.thread_id`, resume retains context with a stable id, bogus id fails loud; P0-4 reserve not pursued) |
| Linux credential storage (libsecret vs encrypted file, 0600) | implementation-phase ADR | open; CLI meanwhile enforces 0600/0700 on the env file (C10) |
