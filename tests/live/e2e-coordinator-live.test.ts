/**
 * COORDINATOR END-TO-END verification (ADR-0006 / ADR-0007, coordination
 * batch E-d exit): the conversational layer proven against a REAL codex.
 * A self-mail whose intent only a MODEL can read is driven through the whole
 * bridge with `coordinator.enabled = true`: real IMAP ingest → identity/AUTH
 * gate → the read-only codex COORDINATOR turn (`--sandbox read-only
 * --output-schema`, ADR-0007's pushed-context carrier) → the coordinator's
 * decision → [dispatch: a real `codex exec` in a bridge-owned worktree |
 * answer: the coordinator's own free text] → scrubbed reply → real SMTP send
 * → read back over IMAP.
 *
 * This is the batch-D spike red line 5 always gated: whether `--sandbox
 * read-only` + `--output-schema` + `--ignore-user-config` actually COMPOSE on
 * codex 0.144.6 and yield a schema-valid decision on the JSONL stream. Only a
 * real coordinator turn can answer it; the unit suite proves every branch with
 * ZERO quota but cannot prove the carrier. Scenario A (a pure meta-query) is
 * the DECISIVE proof: the deterministic router has no "answer" capability at
 * all, so a `💬 answer` reply can ONLY have come from a working coordinator.
 *
 * THIS FILE SPENDS REAL MODEL QUOTA — it is the SECOND (and only other)
 * quota-spending test besides `e2e-full-live.test.ts`, and it spends MORE per
 * mail: every thread-bound command first costs one read-only coordinator turn,
 * and a `dispatch` decision costs a second (execution) turn on top. A HARD cap
 * of 4 codex invocations per run is enforced in-process by the spawn wrapper
 * below (it counts BEFORE it spawns and throws once the count would exceed 4),
 * so a routing/decision bug can never fan out into unbounded spend. The happy
 * path spends exactly 3: scenario A = 1 coordinator turn, scenario B = 1
 * coordinator + 1 execution turn.
 *
 * THREE gate conditions, ALL required before anything here runs — the same
 * TEST/SEND opt-ins as every live test, plus this file's OWN third gate:
 *   1. `AMB_LIVE_TEST=1` — touch a real mailbox at all (batch 2);
 *   2. `AMB_LIVE_SEND=1` — emit real mail (batch 5);
 *   3. `AMB_LIVE_COORDINATOR_E2E=1` — this file's own quota-escalation opt-in,
 *      SEPARATE from `e2e-full-live`'s `AMB_LIVE_E2E` for the identical reason
 *      that file split its gate off from `AMB_LIVE_SEND`: the coordinator E2E
 *      spends ADDITIONAL quota (a model turn PER inbound mail), so keying it on
 *      `AMB_LIVE_E2E` would let the habitual full-E2E command silently double
 *      its spend the day this file landed. A distinct variable makes each
 *      quota-spending suite its own explicit act. `AMB_LIVE_E2E` runs ONLY the
 *      full pipeline E2E; THIS variable runs ONLY the coordinator E2E; set both
 *      to run both.
 *
 *   AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 AMB_LIVE_COORDINATOR_E2E=1 \
 *     pnpm exec vitest run tests/live/e2e-coordinator-live.test.ts
 *
 * A bare `pnpm test` sets none, so this suite always reports "skipped" there
 * and in CI; the live execution is performed by the MAIN session, never by a
 * file-authoring subagent (batch-2/5 rule). Per red line 3 the only reachable
 * recipient is the test mailbox itself (`from === to === selfAddress`, the
 * approved authenticated self-send); control mails go out via a bare nodemailer
 * submission WITHOUT the bridge's `X-AMB-Outbox-ID` echo markers, so ingest
 * treats them as genuine inbound commands (the bridge's own replies, which DO
 * carry the markers, ingest as `SYSTEM_ECHO` and never re-drive the pipeline).
 *
 * WIRING: assembled through the PRODUCTION composition root (`assembleDaemon` +
 * `buildProductionAssemblyBuilders`) with `coordinator.enabled = true`, so this
 * exercises the real E-d-3 wiring. Only the two `SpawnCodex` seams are wrapped
 * — the execution driver's (`createCodexDriver`) and the coordinator's
 * (`buildCoordinatorRuntime`) — with ONE shared counter/cap; the coordinator's
 * construction is otherwise byte-for-byte the production `buildCoordinatorRuntime`
 * (nothing test-only). `allowResume` is now ON in production (ADR-0008), but
 * scenarios A and B are two DISTINCT new threads, so neither resumes — each is a
 * fresh read-only turn regardless. Multi-turn resume is exercised by the
 * separate resume E2E (`e2e-coordinator-resume-live.test.ts`).
 *
 * ISOLATION (red line 1): a throwaway git repo under `os.tmpdir()` is the only
 * project the bridge may touch; the SQLite store, the worktrees root, the
 * coordinator's read-only scratch dir and the config all live in the same temp
 * dir, removed in `afterAll`.
 *
 * SCRUB / LEAK DISCIPLINE (red line 2):
 *  - every delivered reply's body and subject are asserted NOT to contain the
 *    app password, the absolute worktrees root, or the home dir — the live
 *    proof the C9 render scrub holds over BOTH the execution driver's text and
 *    the coordinator's untrusted model text. Each such assertion is a BOOLEAN
 *    (`.includes(...) === false`); the secret operand is never a printable value.
 *  - `no-console` applies here exactly as in `src/`: progress/metrics go to a
 *    JSON report (`AMB_E2E_COORDINATOR_REPORT`, default
 *    `os.tmpdir()/amb-e2e-coordinator-report.json`) carrying ONLY counts,
 *    durations, outcome labels and boolean leak-check results — never a path or
 *    secret.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BridgeConfig } from '../../src/cli/config.js';
import { buildCoordinatorRuntime, buildProductionAssemblyBuilders } from '../../src/cli/start.js';
import { assembleDaemon } from '../../src/daemon/assembly.js';
import type { AssembledDaemon, AssemblyBuilders } from '../../src/daemon/assembly.js';
import type { MailTickReport } from '../../src/daemon/ticks.js';
import { normalizeMessageId } from '../../src/domain/mail.js';
import { buildDefaultSpawnCodex, createCodexDriver } from '../../src/drivers/codexDriver.js';
import type { SpawnCodex } from '../../src/drivers/codexDriver.js';
import { openDatabase } from '../../src/store/database.js';
import { buildImapflowFactory, createImapReadTransport } from '../../src/transports/imapRead.js';
import type { IncomingMail, MailTransport } from '../../src/transports/types.js';
import { loadLiveCreds } from '../helpers/liveCreds.js';

const HOST = 'imap.gmail.com';
const PORT = 993;
const MAILBOX = 'INBOX';

/** Hard ceiling on real codex invocations per run (expected: exactly 3 —
 *  scenario A = 1 coordinator turn, scenario B = 1 coordinator + 1 execution). */
const CODEX_CALL_CAP = 4;

/** Whole-test budget: two mail round trips + up to three real codex turns. */
const TEST_TIMEOUT_MS = 900_000;
const SETUP_TIMEOUT_MS = 120_000;
/** Per-phase deadline for a self-mail to become visible + fully processed
 *  (send→INBOX ~15-30s, plus the coordinator turn and — on dispatch — the
 *  execution turn folded into the ingesting tick). */
const MAIL_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;
/** Spec §6 MVP exit metric: a real command round-trips to its result mail in
 *  under 10 minutes. The coordinator turn is inside this budget. */
const EXIT_METRIC_MS = 600_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** ALL THREE gates — see the file header for why the coordinator gate is its
 *  own variable, distinct from `e2e-full-live`'s `AMB_LIVE_E2E`. */
const liveEnabled =
  process.env.AMB_LIVE_TEST === '1' &&
  process.env.AMB_LIVE_SEND === '1' &&
  process.env.AMB_LIVE_COORDINATOR_E2E === '1';
// Module scope, DEFAULT (real) path — resolved only when all gates are set,
// dereferenced ONLY inside callbacks (collection-time caveat, batch-2 header).
const creds = liveEnabled ? loadLiveCreds() : null;

describe.skipIf(!liveEnabled || creds === null)('coordinator E2E (live, real codex)', () => {
  let assembled: AssembledDaemon | undefined;
  let probeTransport: MailTransport | undefined;
  let probeDb: ReturnType<typeof openDatabase> | undefined;
  let smtp: Transporter | undefined;

  let scratchDir = '';
  let worktreesRoot = '';

  let baselineUidValidity = '';
  let baselineSinceUid = 0;

  // Counted by the shared spawn wrapper; asserted by the test. A coordinator
  // turn is the ONLY codex call carrying `--output-schema`; an execution start
  // is the ONLY one carrying `workspace-write` — mutually exclusive, so argv
  // inspection classifies every spawn without ambiguity.
  let codexCoordinatorCalls = 0;
  let codexExecStartCalls = 0;
  let codexExecResumeCalls = 0;
  let codexUnclassifiedCalls = 0;

  const reportData: Record<string, unknown> = {};

  function assertCodexCap(): void {
    const total =
      codexCoordinatorCalls + codexExecStartCalls + codexExecResumeCalls + codexUnclassifiedCalls;
    if (total > CODEX_CALL_CAP) {
      throw new Error(
        `E2E hard stop: codex call cap ${String(CODEX_CALL_CAP)} exceeded ` +
          `(coordinator=${String(codexCoordinatorCalls)}, execStart=${String(codexExecStartCalls)}, ` +
          `execResume=${String(codexExecResumeCalls)}, unclassified=${String(codexUnclassifiedCalls)})`,
      );
    }
  }

  /** Count-BEFORE-spawn classifier shared by both codex seams. */
  function countSpawn(argv: readonly string[]): void {
    if (argv.includes('--output-schema')) {
      codexCoordinatorCalls += 1;
    } else if (argv.includes('workspace-write')) {
      codexExecStartCalls += 1;
    } else if (argv[0] === 'exec' && argv[1] === 'resume') {
      codexExecResumeCalls += 1;
    } else {
      codexUnclassifiedCalls += 1;
    }
    assertCodexCap();
  }

  async function writeReport(patch: Record<string, unknown>): Promise<void> {
    Object.assign(reportData, patch);
    const target =
      process.env.AMB_E2E_COORDINATOR_REPORT ?? join(tmpdir(), 'amb-e2e-coordinator-report.json');
    await writeFile(target, JSON.stringify(reportData, null, 2));
  }

  async function sendControlMail(opts: { subject: string; body: string }): Promise<string> {
    if (smtp === undefined || creds === null) {
      throw new Error('E2E: smtp/creds not ready');
    }
    const info = await smtp.sendMail({
      from: creds.user,
      to: creds.user,
      subject: opts.subject,
      text: opts.body,
    });
    return info.messageId;
  }

  function probeCommandStatus(
    normalizedId: string,
  ): { status: string; statusReason: string | null } | undefined {
    if (probeDb === undefined) {
      throw new Error('E2E: probeDb not ready');
    }
    return probeDb
      .prepare<[string], { status: string; statusReason: string | null }>(
        'SELECT status, status_reason AS statusReason FROM commands WHERE message_id = ?',
      )
      .get(normalizedId);
  }

  /** How many mail threads have a persisted coordinator codex thread id — a
   *  row appears ONLY on a SUCCEEDED coordinator turn (a failed/fell-back turn
   *  carries no id), so this count is the live proof the coordinator decided
   *  rather than falling through to the deterministic router. */
  function probeCoordinatorSessionCount(): number {
    if (probeDb === undefined) {
      throw new Error('E2E: probeDb not ready');
    }
    const row = probeDb
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM coordinator_sessions')
      .get();
    return row?.n ?? 0;
  }

  /** Runs mail ticks until the command row for `normalizedId` exists, then
   *  returns THAT tick's report plus the row's fate. The tick that ingests a
   *  READY mail also runs the coordinator turn (and, on dispatch, the execution
   *  turn) synchronously, so the returned report already reflects the outcome. */
  async function pumpUntilProcessed(
    normalizedId: string,
    deadlineMs: number,
  ): Promise<{ report: MailTickReport; status: string; statusReason: string | null }> {
    if (assembled === undefined) {
      throw new Error('E2E: daemon not assembled');
    }
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const report = await assembled.ticks.mailTick();
      const row = probeCommandStatus(normalizedId);
      if (row !== undefined) {
        return { report, status: row.status, statusReason: row.statusReason };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `E2E: control mail was not visible/ingested within ${String(deadlineMs)}ms ` +
            '(is IMAP delivery healthy?)',
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Polls the (independent) probe transport until the reply carrying
   *  `outboxId` is delivered, and returns it as parsed `IncomingMail`. */
  async function findReplyByOutboxId(outboxId: string, deadlineMs: number): Promise<IncomingMail> {
    if (probeTransport === undefined) {
      throw new Error('E2E: probe transport not ready');
    }
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const mails = await probeTransport.fetchSince(MAILBOX, baselineUidValidity, baselineSinceUid);
      const found = mails.find((mail) => mail.headers.get('x-amb-outbox-id')?.[0] === outboxId);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `E2E: reply carrying its outbox id was not visible within ${String(deadlineMs)}ms`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Body/subject leak probe (red line 2) — every field is a BOOLEAN; the
   *  secret operands (`creds.pass`, `worktreesRoot`, home) are the NEEDLES, so
   *  a failing assertion prints `true`/`false`, never the secret itself. */
  function leakChecks(mail: IncomingMail): {
    passInBody: boolean;
    worktreeInBody: boolean;
    homeInBody: boolean;
    passInSubject: boolean;
    worktreeInSubject: boolean;
    bodyLength: number;
  } {
    if (creds === null) {
      throw new Error('unreachable: gated');
    }
    const body = mail.bodyText ?? '';
    const subject = mail.headers.get('subject')?.[0] ?? '';
    return {
      passInBody: body.includes(creds.pass),
      worktreeInBody: body.includes(worktreesRoot),
      homeInBody: body.includes(homedir()),
      passInSubject: subject.includes(creds.pass),
      worktreeInSubject: subject.includes(worktreesRoot),
      bodyLength: body.length,
    };
  }

  function assertNoLeak(checks: ReturnType<typeof leakChecks>): void {
    // Empty-body guard: a '' body would make every .includes() vacuously
    // false, so pin non-emptiness before the checks.
    expect(checks.bodyLength).toBeGreaterThan(0);
    expect(checks.passInBody).toBe(false);
    expect(checks.worktreeInBody).toBe(false);
    expect(checks.homeInBody).toBe(false);
    expect(checks.passInSubject).toBe(false);
    expect(checks.worktreeInSubject).toBe(false);
  }

  beforeAll(async () => {
    if (creds === null) {
      throw new Error('unreachable: describe.skipIf excludes creds === null from a running beforeAll');
    }

    // Throwaway project the bridge is allowed to work in — under os.tmpdir(),
    // NEVER the user's real projects (red line 1).
    scratchDir = await mkdtemp(join(tmpdir(), 'amb-e2e-coord-'));
    const projectRoot = join(scratchDir, 'roots');
    worktreesRoot = join(scratchDir, 'worktrees');
    const dbPath = join(scratchDir, 'bridge.db');
    const repoDir = join(projectRoot, 'e2e-scratch-repo');
    await mkdir(repoDir, { recursive: true });
    await mkdir(worktreesRoot, { recursive: true });
    await writeFile(join(repoDir, 'NOTES.md'), '# E2E scratch notes\n');
    const git = (args: readonly string[]): void => {
      execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
    };
    git(['init', '-b', 'main']);
    const author = ['-c', 'user.email=e2e@example.com', '-c', 'user.name=amb-e2e'];
    git([...author, 'add', 'NOTES.md']);
    git([...author, 'commit', '-m', 'init']);

    // Production builders, with BOTH codex seams wrapped by one shared,
    // capped spawn. `buildDriver` / `buildCoordinator` are otherwise the exact
    // production factories (`createCodexDriver` / `buildCoordinatorRuntime`);
    // only `spawnCodex` is swapped for the counting one — nothing test-only.
    const base = buildProductionAssemblyBuilders();
    const realSpawn = buildDefaultSpawnCodex();
    const cappedSpawn: SpawnCodex = (argv, opts) => {
      countSpawn(argv);
      return realSpawn(argv, opts);
    };
    const builders: AssemblyBuilders = {
      ...base,
      buildDriver: () => createCodexDriver({ spawnCodex: cappedSpawn }),
      buildCoordinator: (input) => buildCoordinatorRuntime({ ...input, spawnCodex: cappedSpawn }),
    };

    const config: BridgeConfig = {
      version: 1,
      selfAddress: creds.user,
      credentialsEnvFile: join(homedir(), '.secrets', 'amb-test.env'),
      dbPath,
      projects: { roots: [projectRoot] },
      worktreesRoot,
      baseRef: 'HEAD',
      pollIntervalSeconds: 30,
      mailbox: MAILBOX,
      dryRun: false,
      // The ADR-0006 opt-in under test: turns on the read-only coordinator turn
      // ahead of the deterministic router for every thread-bound command.
      coordinator: { enabled: true },
    };

    assembled = await assembleDaemon(config, builders);
    probeDb = openDatabase(dbPath);
    probeTransport = createImapReadTransport({
      factory: buildImapflowFactory({ host: HOST, port: PORT, user: creds.user, pass: creds.pass }),
    });
    smtp = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: creds.user, pass: creds.pass },
      // Red line 2 — never let nodemailer's debug logger print the wire.
      logger: false,
    });

    // Seed the first-install fence and the UID watermark BEFORE any mail is
    // sent, so the first tick sees only mail newer than now — not the ~15k
    // historical messages P0-1 measured in this mailbox.
    assembled.metaStore.setReadyAtIfUnset(new Date(Date.now() - 5 * 60_000).toISOString());
    const status = await probeTransport.mailboxStatus(MAILBOX);
    baselineUidValidity = status.uidValidity;
    baselineSinceUid = status.uidNext - 1;
    assembled.metaStore.advanceWatermark(MAILBOX, baselineUidValidity, baselineSinceUid);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // Best-effort, per-resource teardown of throwaway state under os.tmpdir()
    // — swallow each step's failure but always run the next (a leaked temp
    // dir/handle is harmless and must never mask the result). `() => unknown`
    // so a sync close() returning a chainable handle is accepted.
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch {
        // teardown-only; nothing here holds a credential (creds reach only the
        // transport), so a leaked handle/dir carries no secret.
      }
    };
    await step(() => assembled?.close());
    await step(() => probeTransport?.close());
    await step(() => probeDb?.close());
    await step(() => smtp?.close());
    if (scratchDir !== '') {
      await step(() => rm(scratchDir, { recursive: true, force: true }));
    }
  });

  it(
    'answers a meta-query read-only, then dispatches an NL command through the coordinator, both scrubbed',
    async () => {
      if (creds === null) {
        throw new Error('unreachable: gated');
      }

      // ---- Scenario A: a pure meta-query → coordinator ANSWER, no execution ----
      // Only the coordinator can answer this; the deterministic router has no
      // "answer" capability, so a `💬 answer` reply is proof the carrier works.
      const aSentAt = Date.now();
      const controlARaw = await sendControlMail({
        subject: 'e2e-coordinator meta query',
        body:
          '这是一次查询,不要派发任何任务:桥当前索引了哪些可以派活的项目?' +
          '请直接用中文把项目名称列出来回答我。',
      });
      const normA = normalizeMessageId(controlARaw);
      if (normA === null) {
        throw new Error('E2E: nodemailer Message-ID for scenario A did not normalize');
      }

      const a = await pumpUntilProcessed(normA, MAIL_DEADLINE_MS);

      // ADR-0003 live check: a legitimate self-mail carries NO
      // Authentication-Results and must pass the AUTH gate.
      if (a.status === 'REJECTED' && a.statusReason === 'AUTH_RESULTS_PRESENT') {
        throw new Error(
          'ADR-0003 FALSIFIED (red line 6): the authenticated self-mail arrived carrying an ' +
            'Authentication-Results header and was quarantined AUTH_RESULTS_PRESENT — the identity ' +
            'gate is closed against legitimate self-mail. STOP and revisit ADR-0003. (No codex ' +
            'quota was spent: the gate fails closed before any coordinator turn.)',
        );
      }
      expect(a.status).toBe('READY_FOR_DISPATCH');
      // The coordinator answered ⇒ NO agent executed.
      expect(a.report.dispatched).toBe(0);
      expect(codexCoordinatorCalls).toBe(1);
      expect(codexExecStartCalls).toBe(0);
      // Exactly one reply (the answer). A coordinator fall-back would instead
      // leave the deterministic router to fail this un-routable mail closed to
      // an EXTRACTION/ROUTING notice — caught by the marker assertion below.
      expect(a.report.replies.length).toBe(1);
      const replyA = a.report.replies[0];
      if (replyA === undefined || replyA.outboxId === null) {
        throw new Error(
          'E2E scenario A: the coordinator produced no registered reply row — the read-only ' +
            'coordinator turn likely FAILED (fell back), so ADR-0007 does not hold on this codex ' +
            `build (coordinatorCalls=${String(codexCoordinatorCalls)}). Is codex logged in?`,
        );
      }
      expect(replyA.status).toBe('SENT');

      const replyMailA = await findReplyByOutboxId(replyA.outboxId, MAIL_DEADLINE_MS);
      const aRoundTripMs = Date.now() - aSentAt;
      const bodyA = replyMailA.bodyText ?? '';
      // The `💬 answer` marker is `composeCoordinatorAnswerReply`'s alone — a
      // deterministic reply (fall-back) would never carry it.
      if (!bodyA.includes('💬 answer')) {
        throw new Error(
          'E2E scenario A: the reply is not a coordinator ANSWER (no "💬 answer" marker) — the ' +
            'coordinator turn fell back to the deterministic router, so the read-only + ' +
            'output-schema carrier (ADR-0007) is NOT validated on this codex build. Inspect the ' +
            'JSON report for counts; do NOT claim the coordinator E2E passed.',
        );
      }
      const leakA = leakChecks(replyMailA);
      assertNoLeak(leakA);
      expect(aRoundTripMs).toBeLessThan(EXIT_METRIC_MS);

      // Persist scenario-A evidence NOW so a later scenario-B failure cannot
      // erase it.
      await writeReport({
        scenarioA_answer: {
          status: a.status,
          dispatched: a.report.dispatched,
          roundTripMs: aRoundTripMs,
          exitMetricMs: EXIT_METRIC_MS,
          exitMetricMet: aRoundTripMs < EXIT_METRIC_MS,
          codexCoordinatorCalls,
          codexExecStartCalls,
          answerMarkerPresent: bodyA.includes('💬 answer'),
          replyStatus: replyA.status,
          coordinatorSessionRows: probeCoordinatorSessionCount(),
          leakChecks: {
            passInBody: leakA.passInBody,
            worktreeInBody: leakA.worktreeInBody,
            homeInBody: leakA.homeInBody,
            passInSubject: leakA.passInSubject,
            worktreeInSubject: leakA.worktreeInSubject,
          },
        },
      });

      // ---- Scenario B: an NL command → coordinator DISPATCH → real execution ----
      // A separate NEW thread (no in-reply-to): threadKey falls back to this
      // mail's own Message-ID, so the coordinator engages with a fresh session.
      const bSentAt = Date.now();
      const controlBRaw = await sendControlMail({
        subject: 'e2e-coordinator dispatch request',
        body:
          '请在 e2e-scratch-repo 项目里,把一行文本 e2e-coord-dispatch-ok 追加到 NOTES.md 文件末尾,' +
          '然后停止。改动尽量小。',
      });
      const normB = normalizeMessageId(controlBRaw);
      if (normB === null) {
        throw new Error('E2E: nodemailer Message-ID for scenario B did not normalize');
      }

      const b = await pumpUntilProcessed(normB, MAIL_DEADLINE_MS);
      if (b.status === 'READY_FOR_DISPATCH' && b.report.dispatched === 0) {
        throw new Error(
          'E2E scenario B: the command passed every gate (READY_FOR_DISPATCH) but no agent ' +
            `executed (dispatched=0, coordinatorCalls=${String(codexCoordinatorCalls)}, ` +
            `execStart=${String(codexExecStartCalls)}). Either the coordinator declined to ` +
            'dispatch (check the reply) or codex is not logged in / the driver reported failure.',
        );
      }
      expect(b.status).toBe('READY_FOR_DISPATCH');
      expect(b.report.dispatched).toBe(1);
      // Cumulative: scenario A's coordinator turn + scenario B's coordinator
      // turn = 2; scenario B's execution start = 1; no resumes.
      expect(codexCoordinatorCalls).toBe(2);
      expect(codexExecStartCalls).toBe(1);
      expect(codexExecResumeCalls).toBe(0);
      expect(codexUnclassifiedCalls).toBe(0);

      const replyB = b.report.replies[0];
      if (replyB === undefined || replyB.outboxId === null) {
        throw new Error('E2E scenario B: dispatch produced no registered reply row');
      }
      expect(replyB.status).toBe('SENT');

      const replyMailB = await findReplyByOutboxId(replyB.outboxId, MAIL_DEADLINE_MS);
      const bRoundTripMs = Date.now() - bSentAt;
      const leakB = leakChecks(replyMailB);
      assertNoLeak(leakB);
      expect(bRoundTripMs).toBeLessThan(EXIT_METRIC_MS);

      // Both coordinator turns minted + persisted a codex thread id ⇒ both
      // DECIDED (neither fell back to the deterministic router). Two distinct
      // threads (A and B) ⇒ exactly two rows.
      const coordinatorSessionRows = probeCoordinatorSessionCount();
      expect(coordinatorSessionRows).toBe(2);

      await writeReport({
        scenarioB_dispatch: {
          status: b.status,
          dispatched: b.report.dispatched,
          roundTripMs: bRoundTripMs,
          exitMetricMs: EXIT_METRIC_MS,
          exitMetricMet: bRoundTripMs < EXIT_METRIC_MS,
          codexCoordinatorCalls,
          codexExecStartCalls,
          codexExecResumeCalls,
          codexUnclassifiedCalls,
          totalCodexCalls:
            codexCoordinatorCalls +
            codexExecStartCalls +
            codexExecResumeCalls +
            codexUnclassifiedCalls,
          replyStatus: replyB.status,
          coordinatorSessionRows,
          leakChecks: {
            passInBody: leakB.passInBody,
            worktreeInBody: leakB.worktreeInBody,
            homeInBody: leakB.homeInBody,
            passInSubject: leakB.passInSubject,
            worktreeInSubject: leakB.worktreeInSubject,
          },
        },
      });
    },
    TEST_TIMEOUT_MS,
  );
});
