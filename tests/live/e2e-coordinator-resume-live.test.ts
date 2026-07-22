/**
 * COORDINATOR MULTI-TURN RESUME end-to-end (ADR-0006 three-layer mapping +
 * ADR-0008 resume read-only): proves a mail-thread reply RESUMES the SAME codex
 * coordinator conversation — with real cross-turn memory — against real codex.
 *
 * The resume proof is designed to be IMPOSSIBLE TO FAKE. Turn 1 plants a nonce
 * (`amb-resume-nonce-42`) in the coordinator's codex thread and asks an
 * under-specified question so the coordinator CLARIFIES (no agent runs). Turn 2,
 * a reply on the same thread, asks the coordinator to recall that nonce and
 * NOTHING else — the nonce is NOT a project/session name, so it never appears in
 * turn 2's pushed read-only snapshot (ADR-0007). The ONLY place it survives is
 * the resumed codex thread. So a turn-2 answer that contains the nonce can ONLY
 * mean `codex exec resume` carried turn-1 context across the mail boundary.
 *
 * This also exercises `allowResume` ON (ADR-0008) end to end: turn 2's coordinator
 * turn is a real `exec resume <thread_id>` carrying the driver's read-only wall
 * (`-c sandbox_mode="read-only"`), the spike-verified resume sandbox.
 *
 * THIS FILE SPENDS REAL MODEL QUOTA — two coordinator turns (turn 1 clarify +
 * turn 2 resumed answer), NO execution turn on the happy path. Hard cap 3 in
 * process (counts BEFORE spawn, throws past 3).
 *
 * THREE gate conditions, ALL required — TEST/SEND plus this file's OWN third
 * gate, DISTINCT from `e2e-coordinator-live`'s `AMB_LIVE_COORDINATOR_E2E` for
 * the same reason that file split from the full E2E: this is a further quota
 * escalation (a resumed second turn), so it must be its own explicit act rather
 * than silently doubling the coordinator-E2E command's spend:
 *   1. `AMB_LIVE_TEST=1`     — touch a real mailbox (batch 2);
 *   2. `AMB_LIVE_SEND=1`     — emit real mail (batch 5);
 *   3. `AMB_LIVE_COORDINATOR_RESUME_E2E=1` — this file's resume-quota opt-in.
 *
 *   AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 AMB_LIVE_COORDINATOR_RESUME_E2E=1 \
 *     pnpm exec vitest run tests/live/e2e-coordinator-resume-live.test.ts
 *
 * WIRING / ISOLATION / SCRUB: identical discipline to `e2e-coordinator-live`
 * (production composition root with `coordinator.enabled = true`; both SpawnCodex
 * seams wrapped by one shared cap; throwaway repo + store + coordinator scratch
 * under `os.tmpdir()`, removed in afterAll; every reply leak-checked boolean-only;
 * JSON report to `AMB_E2E_COORDINATOR_RESUME_REPORT`, counts/labels/booleans only).
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

/** The cross-turn memory probe. Low-entropy on purpose (gitleaks), and NOT a
 *  project/session name so it can NEVER be in turn 2's pushed snapshot — only
 *  the resumed codex thread can carry it. */
const RESUME_NONCE = 'amb-resume-nonce-42';

/** Hard ceiling on real codex calls per run (expected: exactly 2 coordinator
 *  turns — one new clarify, one resumed answer; zero execution). */
const CODEX_CALL_CAP = 3;

const TEST_TIMEOUT_MS = 900_000;
const SETUP_TIMEOUT_MS = 120_000;
const MAIL_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;
const EXIT_METRIC_MS = 600_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const liveEnabled =
  process.env.AMB_LIVE_TEST === '1' &&
  process.env.AMB_LIVE_SEND === '1' &&
  process.env.AMB_LIVE_COORDINATOR_RESUME_E2E === '1';
const creds = liveEnabled ? loadLiveCreds() : null;

describe.skipIf(!liveEnabled || creds === null)('coordinator multi-turn resume E2E (live, real codex)', () => {
  let assembled: AssembledDaemon | undefined;
  let probeTransport: MailTransport | undefined;
  let probeDb: ReturnType<typeof openDatabase> | undefined;
  let smtp: Transporter | undefined;

  let scratchDir = '';
  let worktreesRoot = '';
  let baselineUidValidity = '';
  let baselineSinceUid = 0;

  // A coordinator NEW turn carries `--output-schema` and is NOT `exec resume`;
  // a coordinator RESUME turn carries `--output-schema` AND `exec resume`; an
  // execution start carries `workspace-write`. Mutually exclusive → argv
  // inspection classifies every spawn.
  let codexCoordNewCalls = 0;
  let codexCoordResumeCalls = 0;
  let codexExecStartCalls = 0;
  let codexUnclassifiedCalls = 0;

  const reportData: Record<string, unknown> = {};

  function assertCodexCap(): void {
    const total =
      codexCoordNewCalls + codexCoordResumeCalls + codexExecStartCalls + codexUnclassifiedCalls;
    if (total > CODEX_CALL_CAP) {
      throw new Error(
        `E2E hard stop: codex call cap ${String(CODEX_CALL_CAP)} exceeded ` +
          `(coordNew=${String(codexCoordNewCalls)}, coordResume=${String(codexCoordResumeCalls)}, ` +
          `execStart=${String(codexExecStartCalls)}, unclassified=${String(codexUnclassifiedCalls)})`,
      );
    }
  }

  function countSpawn(argv: readonly string[]): void {
    const isResume = argv[0] === 'exec' && argv[1] === 'resume';
    if (argv.includes('--output-schema')) {
      if (isResume) {
        codexCoordResumeCalls += 1;
      } else {
        codexCoordNewCalls += 1;
      }
    } else if (argv.includes('workspace-write')) {
      codexExecStartCalls += 1;
    } else {
      codexUnclassifiedCalls += 1;
    }
    assertCodexCap();
  }

  async function writeReport(patch: Record<string, unknown>): Promise<void> {
    Object.assign(reportData, patch);
    const target =
      process.env.AMB_E2E_COORDINATOR_RESUME_REPORT ??
      join(tmpdir(), 'amb-e2e-coordinator-resume-report.json');
    await writeFile(target, JSON.stringify(reportData, null, 2));
  }

  async function sendControlMail(opts: {
    subject: string;
    body: string;
    inReplyTo?: string;
  }): Promise<string> {
    if (smtp === undefined || creds === null) {
      throw new Error('E2E: smtp/creds not ready');
    }
    const info = await smtp.sendMail({
      from: creds.user,
      to: creds.user,
      subject: opts.subject,
      text: opts.body,
      ...(opts.inReplyTo !== undefined
        ? { inReplyTo: opts.inReplyTo, references: opts.inReplyTo }
        : {}),
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

  /** The coordinator thread ids persisted so far (one row per mail thread). A
   *  resume that reused turn 1's id leaves EXACTLY ONE row whose id is unchanged
   *  — the three-layer mapping's third layer, live. */
  function probeCoordinatorSessions(): { count: number; ids: string[] } {
    if (probeDb === undefined) {
      throw new Error('E2E: probeDb not ready');
    }
    const rows = probeDb
      .prepare<[], { id: string }>('SELECT coordinator_thread_id AS id FROM coordinator_sessions')
      .all();
    return { count: rows.length, ids: rows.map((r) => r.id) };
  }

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
          `E2E: control mail was not visible/ingested within ${String(deadlineMs)}ms`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

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

    scratchDir = await mkdtemp(join(tmpdir(), 'amb-e2e-coord-resume-'));
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

    const base = buildProductionAssemblyBuilders();
    const realSpawn = buildDefaultSpawnCodex();
    const cappedSpawn: SpawnCodex = (argv, opts) => {
      countSpawn(argv);
      return realSpawn(argv, opts);
    };
    const builders: AssemblyBuilders = {
      ...base,
      buildDriver: () => createCodexDriver({ spawnCodex: cappedSpawn }),
      // Real production coordinator wiring — `allowResume: true` (ADR-0008) — with
      // only the spawn seam capped.
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
      logger: false,
    });

    assembled.metaStore.setReadyAtIfUnset(new Date(Date.now() - 5 * 60_000).toISOString());
    const status = await probeTransport.mailboxStatus(MAILBOX);
    baselineUidValidity = status.uidValidity;
    baselineSinceUid = status.uidNext - 1;
    assembled.metaStore.advanceWatermark(MAILBOX, baselineUidValidity, baselineSinceUid);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch {
        // teardown-only; nothing here holds a credential.
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
    'turn 1 clarifies (planting a nonce), turn 2 resumes the SAME codex thread and recalls it',
    async () => {
      if (creds === null) {
        throw new Error('unreachable: gated');
      }

      // ---- Turn 1: under-specified request → coordinator CLARIFY, nonce planted ----
      const t1SentAt = Date.now();
      const control1Raw = await sendControlMail({
        subject: 'e2e-coordinator resume turn one',
        body:
          `暗号:${RESUME_NONCE}(请先记住它)。另外,请在 e2e-scratch-repo 项目里帮我改点东西——` +
          '具体改什么我还没定,你先回我一个问题确认要改的内容,先别动手。',
      });
      const norm1 = normalizeMessageId(control1Raw);
      if (norm1 === null) {
        throw new Error('E2E: nodemailer Message-ID for turn 1 did not normalize');
      }

      const t1 = await pumpUntilProcessed(norm1, MAIL_DEADLINE_MS);
      if (t1.status === 'REJECTED' && t1.statusReason === 'AUTH_RESULTS_PRESENT') {
        throw new Error(
          'ADR-0003 FALSIFIED (red line 6): the authenticated self-mail was quarantined ' +
            'AUTH_RESULTS_PRESENT. (No codex quota spent: the gate fails closed before any turn.)',
        );
      }
      expect(t1.status).toBe('READY_FOR_DISPATCH');
      // A clarify/answer runs NO agent.
      expect(t1.report.dispatched).toBe(0);
      expect(codexCoordNewCalls).toBe(1);
      expect(codexCoordResumeCalls).toBe(0);
      expect(codexExecStartCalls).toBe(0);
      expect(t1.report.replies.length).toBe(1);
      const reply1 = t1.report.replies[0];
      if (reply1 === undefined || reply1.outboxId === null) {
        throw new Error(
          'E2E turn 1: the coordinator produced no registered reply row — the read-only ' +
            `coordinator turn likely FAILED (fell back). coordNew=${String(codexCoordNewCalls)}.`,
        );
      }
      expect(reply1.status).toBe('SENT');

      const replyMail1 = await findReplyByOutboxId(reply1.outboxId, MAIL_DEADLINE_MS);
      const t1RoundTripMs = Date.now() - t1SentAt;
      const body1 = replyMail1.bodyText ?? '';
      // A coordinator read-only reply (clarify preferred, answer tolerated) — a
      // deterministic fall-back reply would carry neither marker.
      const t1IsClarify = body1.includes('❓ clarification');
      const t1IsAnswer = body1.includes('💬 answer');
      if (!t1IsClarify && !t1IsAnswer) {
        throw new Error(
          'E2E turn 1: reply is neither clarify nor answer — the coordinator fell back to the ' +
            'deterministic router, so no coordinator session was created and turn 2 cannot resume. ' +
            'STOP: the coordinator carrier is not working on this codex build.',
        );
      }
      const leak1 = leakChecks(replyMail1);
      assertNoLeak(leak1);

      // The coordinator minted + persisted its thread id (proof it DECIDED, not
      // fell back) — the id turn 2 must resume.
      const afterT1 = probeCoordinatorSessions();
      expect(afterT1.count).toBe(1);
      const turn1ThreadId = afterT1.ids[0] ?? '';
      expect(turn1ThreadId.length).toBeGreaterThan(0);

      await writeReport({
        turn1_clarify: {
          status: t1.status,
          dispatched: t1.report.dispatched,
          roundTripMs: t1RoundTripMs,
          codexCoordNewCalls,
          codexCoordResumeCalls,
          codexExecStartCalls,
          replyMarker: t1IsClarify ? 'clarification' : t1IsAnswer ? 'answer' : 'none',
          clarifyMarkerPresent: t1IsClarify,
          coordinatorSessionRows: afterT1.count,
          leakChecks: {
            passInBody: leak1.passInBody,
            worktreeInBody: leak1.worktreeInBody,
            homeInBody: leak1.homeInBody,
            passInSubject: leak1.passInSubject,
            worktreeInSubject: leak1.worktreeInSubject,
          },
        },
      });

      // ---- Turn 2: reply on the SAME thread → RESUME → recall the nonce ----
      // Turn 2's body does NOT contain the nonce; it is not a project/session
      // name, so it is NOT in the pushed snapshot. Only the resumed codex thread
      // holds it. A turn-2 answer containing it ⇒ resume carried turn-1 context.
      const t2SentAt = Date.now();
      const control2Raw = await sendControlMail({
        subject: 'e2e-coordinator resume turn two',
        body:
          '先别改动了。请只用中文回答一个问题:我在这个对话最开始让你记住的那个暗号是什么?' +
          '只回暗号本身,别的什么都别做。',
        inReplyTo: control1Raw,
      });
      const norm2 = normalizeMessageId(control2Raw);
      if (norm2 === null) {
        throw new Error('E2E: nodemailer Message-ID for turn 2 did not normalize');
      }

      const t2 = await pumpUntilProcessed(norm2, MAIL_DEADLINE_MS);
      expect(t2.status).toBe('READY_FOR_DISPATCH');
      expect(t2.report.dispatched).toBe(0);
      // The decisive counter: turn 2 was a real `exec resume` coordinator turn.
      expect(codexCoordResumeCalls).toBe(1);
      expect(codexCoordNewCalls).toBe(1);
      expect(codexExecStartCalls).toBe(0);
      expect(codexUnclassifiedCalls).toBe(0);

      const reply2 = t2.report.replies[0];
      if (reply2 === undefined || reply2.outboxId === null) {
        throw new Error('E2E turn 2: the resumed coordinator produced no registered reply row');
      }
      expect(reply2.status).toBe('SENT');

      const replyMail2 = await findReplyByOutboxId(reply2.outboxId, MAIL_DEADLINE_MS);
      const t2RoundTripMs = Date.now() - t2SentAt;
      const body2 = replyMail2.bodyText ?? '';
      const leak2 = leakChecks(replyMail2);
      assertNoLeak(leak2);
      expect(t2RoundTripMs).toBeLessThan(EXIT_METRIC_MS);

      // Same thread ⇒ still exactly one coordinator row, and the resumed id is
      // UNCHANGED (ADR-0004: the thread id re-emits identically on resume).
      const afterT2 = probeCoordinatorSessions();
      expect(afterT2.count).toBe(1);
      expect(afterT2.ids[0]).toBe(turn1ThreadId);

      // THE RESUME PROOF: the nonce, recalled from the resumed codex thread,
      // appears in turn 2's answer. It was never in turn 2's mail nor its snapshot.
      const nonceRecalled = body2.includes(RESUME_NONCE);

      await writeReport({
        turn2_resume: {
          status: t2.status,
          dispatched: t2.report.dispatched,
          roundTripMs: t2RoundTripMs,
          codexCoordNewCalls,
          codexCoordResumeCalls,
          codexExecStartCalls,
          codexUnclassifiedCalls,
          totalCodexCalls: codexCoordNewCalls + codexCoordResumeCalls + codexExecStartCalls,
          resumedSameThreadId: afterT2.ids[0] === turn1ThreadId,
          nonceRecalled,
          coordinatorSessionRows: afterT2.count,
          leakChecks: {
            passInBody: leak2.passInBody,
            worktreeInBody: leak2.worktreeInBody,
            homeInBody: leak2.homeInBody,
            passInSubject: leak2.passInSubject,
            worktreeInSubject: leak2.worktreeInSubject,
          },
        },
      });

      if (!nonceRecalled) {
        throw new Error(
          'E2E turn 2: RESUME NOT PROVEN — the answer did not contain the nonce planted in turn 1. ' +
            'Either `exec resume` did not carry cross-turn context, or the coordinator declined to ' +
            'answer. Inspect the JSON report; do NOT claim multi-turn resume works.',
        );
      }

      // Report evidence is persisted; assert clarify-live LAST so a non-clarify
      // turn 1 does not erase the (already proven) resume result.
      expect(t1IsClarify).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
