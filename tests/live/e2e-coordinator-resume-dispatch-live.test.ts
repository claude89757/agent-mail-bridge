/**
 * COORDINATOR RESUME-THEN-DISPATCH end-to-end (ADR-0006 + ADR-0008): the last
 * cell of the resume coverage matrix — a RESUMED coordinator turn that DECIDES
 * `dispatch` and drives a real `codex exec`, not just a read-only answer/clarify.
 *
 * Turn 1 is an under-specified request → the coordinator CLARIFIES (creates its
 * codex session, runs no agent). Turn 2, a reply on the same thread, supplies
 * the task → the daemon RESUMES the coordinator's codex thread, the resumed
 * coordinator DECIDES `dispatch`, and the decision flows through the shared
 * execution tail (`executeDispatchVerdict`) into a real `codex exec` in a
 * bridge-owned worktree, whose scrubbed result is mailed back.
 *
 * Two things make this decisive beyond the read-only resume E2E:
 *   - `codexCoordResumeCalls == 1` — turn 2's coordinator turn was a real
 *     `exec resume`, carrying the driver's `-c sandbox_mode="read-only"` wall;
 *   - the `coordinator_sessions` row's `updated_at` ADVANCES on turn 2 — proof
 *     the resumed coordinator turn SUCCEEDED and re-upserted (it DECIDED the
 *     dispatch), rather than failing closed to the deterministic router; combined
 *     with `dispatched == 1` + `codexExecStartCalls == 1`, the dispatch is the
 *     resumed coordinator's, executed for real.
 *
 * THIS FILE SPENDS REAL MODEL QUOTA — three codex turns (turn 1 clarify, turn 2
 * coordinator resume, turn 2 execution). Hard cap 4 in process (counts BEFORE
 * spawn, throws past 4).
 *
 * THREE gates, ALL required — TEST/SEND plus this file's OWN fourth-variant gate,
 * DISTINCT from the read-only resume E2E's because this run spends an ADDITIONAL
 * execution turn (a further quota escalation → its own explicit act):
 *   1. `AMB_LIVE_TEST=1`;  2. `AMB_LIVE_SEND=1`;
 *   3. `AMB_LIVE_COORDINATOR_RESUME_DISPATCH_E2E=1`.
 *
 *   AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 AMB_LIVE_COORDINATOR_RESUME_DISPATCH_E2E=1 \
 *     pnpm exec vitest run tests/live/e2e-coordinator-resume-dispatch-live.test.ts
 *
 * WIRING / ISOLATION / SCRUB: identical discipline to the other coordinator
 * live E2Es (production composition root, `coordinator.enabled = true`,
 * `allowResume` ON via ADR-0008; both SpawnCodex seams share one cap; throwaway
 * repo/store/scratch under os.tmpdir(); every reply leak-checked boolean-only;
 * JSON report to `AMB_E2E_COORDINATOR_RESUME_DISPATCH_REPORT`).
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

/** A distinctive line the dispatched task appends — asserted absent from every
 *  reply as a payload, low-entropy (gitleaks). */
const DISPATCH_LINE = 'e2e-resume-dispatch-ok';

/** Hard ceiling (expected: 3 — 1 coord-new clarify, 1 coord-resume, 1 exec). */
const CODEX_CALL_CAP = 4;

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
  process.env.AMB_LIVE_COORDINATOR_RESUME_DISPATCH_E2E === '1';
const creds = liveEnabled ? loadLiveCreds() : null;

describe.skipIf(!liveEnabled || creds === null)(
  'coordinator resume-then-dispatch E2E (live, real codex)',
  () => {
    let assembled: AssembledDaemon | undefined;
    let probeTransport: MailTransport | undefined;
    let probeDb: ReturnType<typeof openDatabase> | undefined;
    let smtp: Transporter | undefined;

    let scratchDir = '';
    let worktreesRoot = '';
    let baselineUidValidity = '';
    let baselineSinceUid = 0;

    let codexCoordNewCalls = 0;
    let codexCoordResumeCalls = 0;
    let codexExecStartCalls = 0;
    let codexExecResumeCalls = 0;
    let codexUnclassifiedCalls = 0;

    const reportData: Record<string, unknown> = {};

    function assertCodexCap(): void {
      const total =
        codexCoordNewCalls +
        codexCoordResumeCalls +
        codexExecStartCalls +
        codexExecResumeCalls +
        codexUnclassifiedCalls;
      if (total > CODEX_CALL_CAP) {
        throw new Error(
          `E2E hard stop: codex call cap ${String(CODEX_CALL_CAP)} exceeded ` +
            `(coordNew=${String(codexCoordNewCalls)}, coordResume=${String(codexCoordResumeCalls)}, ` +
            `execStart=${String(codexExecStartCalls)}, execResume=${String(codexExecResumeCalls)}, ` +
            `unclassified=${String(codexUnclassifiedCalls)})`,
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
      } else if (isResume) {
        codexExecResumeCalls += 1;
      } else {
        codexUnclassifiedCalls += 1;
      }
      assertCodexCap();
    }

    async function writeReport(patch: Record<string, unknown>): Promise<void> {
      Object.assign(reportData, patch);
      const target =
        process.env.AMB_E2E_COORDINATOR_RESUME_DISPATCH_REPORT ??
        join(tmpdir(), 'amb-e2e-coordinator-resume-dispatch-report.json');
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

    /** The coordinator thread rows: id + updated_at. A SUCCEEDED resume turn
     *  re-upserts (same id, updated_at moves) — a fell-back turn leaves the row
     *  untouched, so an advanced updated_at is proof the resumed coordinator
     *  DECIDED (here: dispatched), not fell through to the deterministic router. */
    function probeCoordinatorSessions(): { count: number; ids: string[]; updatedAts: string[] } {
      if (probeDb === undefined) {
        throw new Error('E2E: probeDb not ready');
      }
      const rows = probeDb
        .prepare<[], { id: string; updatedAt: string }>(
          'SELECT coordinator_thread_id AS id, updated_at AS updatedAt FROM coordinator_sessions',
        )
        .all();
      return {
        count: rows.length,
        ids: rows.map((r) => r.id),
        updatedAts: rows.map((r) => r.updatedAt),
      };
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
        const mails = await probeTransport.fetchSince(
          MAILBOX,
          baselineUidValidity,
          baselineSinceUid,
        );
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
        throw new Error('unreachable: describe.skipIf excludes creds === null from beforeAll');
      }

      scratchDir = await mkdtemp(join(tmpdir(), 'amb-e2e-coord-rd-'));
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
      'turn 1 clarifies, turn 2 RESUMES the coordinator which then DISPATCHES a real codex run',
      async () => {
        if (creds === null) {
          throw new Error('unreachable: gated');
        }

        // ---- Turn 1: under-specified → coordinator CLARIFY (creates session, no agent) ----
        const t1SentAt = Date.now();
        const control1Raw = await sendControlMail({
          subject: 'e2e-coordinator resume-dispatch turn one',
          body:
            '我想在 e2e-scratch-repo 项目里做个小改动,但具体做什么我还没想好。' +
            '你先别动手,回我一个问题确认要做的事。',
        });
        const norm1 = normalizeMessageId(control1Raw);
        if (norm1 === null) {
          throw new Error('E2E: nodemailer Message-ID for turn 1 did not normalize');
        }

        const t1 = await pumpUntilProcessed(norm1, MAIL_DEADLINE_MS);
        if (t1.status === 'REJECTED' && t1.statusReason === 'AUTH_RESULTS_PRESENT') {
          throw new Error(
            'ADR-0003 FALSIFIED (red line 6): the authenticated self-mail was quarantined ' +
              'AUTH_RESULTS_PRESENT. (No codex quota spent: the gate fails closed first.)',
          );
        }
        expect(t1.status).toBe('READY_FOR_DISPATCH');
        expect(t1.report.dispatched).toBe(0);
        expect(codexCoordNewCalls).toBe(1);
        expect(codexCoordResumeCalls).toBe(0);
        expect(codexExecStartCalls).toBe(0);
        const reply1 = t1.report.replies[0];
        if (reply1 === undefined || reply1.outboxId === null) {
          throw new Error(
            'E2E turn 1: the coordinator produced no registered reply — the read-only turn likely ' +
              `FAILED (fell back). coordNew=${String(codexCoordNewCalls)}.`,
          );
        }
        expect(reply1.status).toBe('SENT');

        const replyMail1 = await findReplyByOutboxId(reply1.outboxId, MAIL_DEADLINE_MS);
        const body1 = replyMail1.bodyText ?? '';
        const t1IsClarify = body1.includes('❓ clarification');
        const t1IsAnswer = body1.includes('💬 answer');
        if (!t1IsClarify && !t1IsAnswer) {
          throw new Error(
            'E2E turn 1: reply is neither clarify nor answer — the coordinator fell back, so no ' +
              'coordinator session was created and turn 2 cannot resume. STOP.',
          );
        }
        assertNoLeak(leakChecks(replyMail1));

        const afterT1 = probeCoordinatorSessions();
        expect(afterT1.count).toBe(1);
        const turn1ThreadId = afterT1.ids[0] ?? '';
        const turn1UpdatedAt = afterT1.updatedAts[0] ?? '';
        expect(turn1ThreadId.length).toBeGreaterThan(0);

        await writeReport({
          turn1_clarify: {
            status: t1.status,
            dispatched: t1.report.dispatched,
            roundTripMs: Date.now() - t1SentAt,
            codexCoordNewCalls,
            codexCoordResumeCalls,
            codexExecStartCalls,
            replyMarker: t1IsClarify ? 'clarification' : 'answer',
            coordinatorSessionRows: afterT1.count,
          },
        });

        // ---- Turn 2: reply supplies the task → RESUME → coordinator DISPATCHES → real codex ----
        const t2SentAt = Date.now();
        const control2Raw = await sendControlMail({
          subject: 'e2e-coordinator resume-dispatch turn two',
          body:
            `想好了:就在这个项目的 NOTES.md 末尾追加一行 ${DISPATCH_LINE},然后停。改动尽量小。动手吧。`,
          inReplyTo: control1Raw,
        });
        const norm2 = normalizeMessageId(control2Raw);
        if (norm2 === null) {
          throw new Error('E2E: nodemailer Message-ID for turn 2 did not normalize');
        }

        const t2 = await pumpUntilProcessed(norm2, MAIL_DEADLINE_MS);
        if (t2.status === 'READY_FOR_DISPATCH' && t2.report.dispatched === 0) {
          throw new Error(
            'E2E turn 2: passed the gate but no agent executed — the resumed coordinator did NOT ' +
              `dispatch (dispatched=0, coordResume=${String(codexCoordResumeCalls)}, ` +
              `execStart=${String(codexExecStartCalls)}). It may have clarified again, or codex is ` +
              'not logged in.',
          );
        }
        expect(t2.status).toBe('READY_FOR_DISPATCH');
        // The headline: the RESUMED coordinator turn decided dispatch, and it executed.
        expect(t2.report.dispatched).toBe(1);
        expect(codexCoordResumeCalls).toBe(1);
        expect(codexCoordNewCalls).toBe(1);
        expect(codexExecStartCalls).toBe(1);
        expect(codexExecResumeCalls).toBe(0);
        expect(codexUnclassifiedCalls).toBe(0);

        const reply2 = t2.report.replies[0];
        if (reply2 === undefined || reply2.outboxId === null) {
          throw new Error('E2E turn 2: dispatch produced no registered reply row');
        }
        expect(reply2.status).toBe('SENT');

        const replyMail2 = await findReplyByOutboxId(reply2.outboxId, MAIL_DEADLINE_MS);
        const t2RoundTripMs = Date.now() - t2SentAt;
        const body2 = replyMail2.bodyText ?? '';
        // A dispatch RESULT, never a clarify — a resumed re-clarify would have
        // left dispatched=0 above, but pin the marker too.
        expect(body2.includes('❓ clarification')).toBe(false);
        assertNoLeak(leakChecks(replyMail2));
        expect(t2RoundTripMs).toBeLessThan(EXIT_METRIC_MS);

        // Same thread ⇒ still one coordinator row, id unchanged, and updated_at
        // ADVANCED ⇒ the resumed coordinator turn SUCCEEDED and re-upserted (it
        // DECIDED the dispatch, not fell back to the deterministic router).
        const afterT2 = probeCoordinatorSessions();
        expect(afterT2.count).toBe(1);
        expect(afterT2.ids[0]).toBe(turn1ThreadId);
        const turn2UpdatedAt = afterT2.updatedAts[0] ?? '';
        const coordinatorReUpserted = turn2UpdatedAt > turn1UpdatedAt;
        expect(coordinatorReUpserted).toBe(true);

        await writeReport({
          turn2_resume_dispatch: {
            status: t2.status,
            dispatched: t2.report.dispatched,
            roundTripMs: t2RoundTripMs,
            codexCoordNewCalls,
            codexCoordResumeCalls,
            codexExecStartCalls,
            codexExecResumeCalls,
            codexUnclassifiedCalls,
            totalCodexCalls:
              codexCoordNewCalls +
              codexCoordResumeCalls +
              codexExecStartCalls +
              codexExecResumeCalls,
            resumedSameThreadId: afterT2.ids[0] === turn1ThreadId,
            coordinatorReUpserted,
            replyIsClarify: body2.includes('❓ clarification'),
            coordinatorSessionRows: afterT2.count,
            leakChecks: {
              passInBody: leakChecks(replyMail2).passInBody,
              worktreeInBody: leakChecks(replyMail2).worktreeInBody,
              homeInBody: leakChecks(replyMail2).homeInBody,
              passInSubject: leakChecks(replyMail2).passInSubject,
              worktreeInSubject: leakChecks(replyMail2).worktreeInSubject,
            },
          },
        });
      },
      TEST_TIMEOUT_MS,
    );
  },
);
