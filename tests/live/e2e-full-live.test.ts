/**
 * FULL-PIPELINE END-TO-END verification (Phase 3/4/5 exit, spec §6 MVP
 * acceptance): one real self-mail drives the entire bridge — real IMAP
 * ingest → identity/AUTH gate → deterministic route → REAL `codex exec`
 * in a bridge-owned git worktree → scrubbed reply → real SMTP send → read
 * back over IMAP — and a thread reply resumes the SAME codex session.
 *
 * THIS FILE SPENDS REAL MODEL QUOTA. It is the ONLY test that drives a real
 * `codex` task (AGENTS.md red line 5). Every other "live" test tops out at a
 * read-only IMAP pass (`imap-read-live.test.ts`) or a single self-send
 * (`smtp-send-live.test.ts`); this one additionally invokes `codex` up to a
 * HARD cap of 3 times per run (the red-line-5 approved ceiling; the happy path
 * spends exactly 2 — one new task, one resume). The cap is enforced in-process
 * by the driver wrapper below, which increments BEFORE it spawns and throws
 * once the count would exceed 3 — a 4th invocation never spawns — so a
 * routing/thread bug can never fan out into unbounded quota spend.
 *
 * FOUR gate conditions, ALL required before anything here runs:
 *   1. `AMB_LIVE_TEST=1` — batch-2's live-mailbox opt-in (touch a real
 *      mailbox at all);
 *   2. `AMB_LIVE_SEND=1` — batch-5's SEND opt-in (emit real mail);
 *   3. `AMB_LIVE_E2E=1`  — this file's own opt-in, NEW and separate BECAUSE
 *      it is the escalation from "send one fixed probe mail" to "drive a real
 *      codex task that costs model quota". Keying it on `AMB_LIVE_SEND` alone
 *      would have let the habitual send-suite command silently start spending
 *      quota the day this file landed; a third single-purpose variable makes
 *      the quota escalation its own explicit act (the same argument batch 5
 *      made for splitting SEND off from TEST);
 *   4. `loadLiveCreds()` resolves real credentials from its DEFAULT path
 *      (`~/.secrets/amb-test.env` — the dedicated TEST mailbox, red line 1).
 *
 *   AMB_LIVE_TEST=1 AMB_LIVE_SEND=1 AMB_LIVE_E2E=1 \
 *     pnpm exec vitest run tests/live/e2e-full-live.test.ts
 *
 * A bare `pnpm test` sets none, so this suite always reports "skipped" there
 * and in CI; the live execution itself is performed by the MAIN session,
 * never by a file-authoring subagent (batch-2/5 rule). Per red line 3, the
 * only mechanically reachable recipient is the test mailbox itself
 * (`from === to === selfAddress`, "方案 A" — authenticated self-send, already
 * approved), and this file's control mails are sent that way via a bare
 * nodemailer submission (deliberately WITHOUT the bridge's `X-AMB-Outbox-ID`
 * echo markers, so ingest treats them as genuine inbound commands, not
 * `SYSTEM_ECHO`).
 *
 * ADR-0003 LIVE VALIDATION: the identity gate's AUTH factor (accepted
 * 2026-07-20) rejects any `From==To==self` mail carrying an
 * `Authentication-Results` header, on the assumption that Gmail short-circuits
 * an AUTHENTICATED self-submission straight to INBOX with no such header. This
 * test is the first thing that actually verifies that assumption against the
 * live server: a control mail that reaches `READY_FOR_DISPATCH` confirms it;
 * one quarantined `AUTH_RESULTS_PRESENT` FALSIFIES ADR-0003 (red line 6) and
 * the test fails loudly WITHOUT having spent any quota (the gate fails closed
 * before dispatch).
 *
 * ISOLATION: a throwaway git repo under `os.tmpdir()` is the only project the
 * bridge is allowed to touch (red line 1 — never the user's real projects);
 * the SQLite store, the worktrees root, and the config all live in the same
 * temp dir and are removed in `afterAll`. The bridge is assembled through the
 * PRODUCTION composition root (`assembleDaemon` +
 * `buildProductionAssemblyBuilders`) so this exercises the real wiring; only
 * `buildDriver` is wrapped, to count and cap codex calls.
 *
 * SCRUB / LEAK DISCIPLINE (red line 2, batch-2 rule):
 *  - the delivered reply's body and subject are asserted NOT to contain the
 *    app password, the absolute worktrees root, or the home dir — the live
 *    proof of the C9 render scrub. Every such assertion is a BOOLEAN
 *    (`.includes(...) === false`); the secret operand is never an assertion's
 *    printable value.
 *  - `no-console` applies here exactly as in `src/` (this file is not exempt),
 *    so progress/metrics go to a JSON report file (`AMB_E2E_REPORT`, default
 *    `os.tmpdir()/amb-e2e-report.json`) that carries ONLY counts, durations,
 *    outcome labels and boolean leak-check results — never a path or secret.
 *  - an UNEXPECTED live failure (an SMTP/IMAP error, a codex spawn error) can
 *    still propagate a raw provider/error string through vitest's reporter
 *    that may embed the real address: accepted for debuggability with the
 *    batch-2 compensating rule — such raw output MUST be scrubbed before it is
 *    pasted into any committed record or public text.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BridgeConfig } from '../../src/cli/config.js';
import { buildProductionAssemblyBuilders } from '../../src/cli/start.js';
import { assembleDaemon } from '../../src/daemon/assembly.js';
import type { AssembledDaemon, AssemblyBuilders } from '../../src/daemon/assembly.js';
import type { MailTickReport } from '../../src/daemon/ticks.js';
import { normalizeMessageId } from '../../src/domain/mail.js';
import type { AgentDriver, AgentTaskHandle, AgentTaskInput } from '../../src/drivers/types.js';
import { openDatabase } from '../../src/store/database.js';
import { buildImapflowFactory, createImapReadTransport } from '../../src/transports/imapRead.js';
import type { IncomingMail, MailTransport } from '../../src/transports/types.js';
import { loadLiveCreds } from '../helpers/liveCreds.js';

const HOST = 'imap.gmail.com';
const PORT = 993;
const MAILBOX = 'INBOX';

/** Hard ceiling on real codex invocations per run (expected: exactly 2). */
const CODEX_CALL_CAP = 3;

/** Whole-test budget: two mail round trips + two real codex runs. */
const TEST_TIMEOUT_MS = 900_000;
const SETUP_TIMEOUT_MS = 120_000;
/** Per-phase deadline for a self-mail to become visible + be ingested
 *  (ADR-0002 measured 15-30s typical send->INBOX; generous slack for the
 *  codex run folded into the dispatching tick). */
const MAIL_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;
/** The spec §6 MVP exit metric: a real command round-trips to its result mail
 *  in under 10 minutes. */
const EXIT_METRIC_MS = 600_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** ALL FOUR gates — see the file header for why the E2E gate is separate. */
const liveEnabled =
  process.env.AMB_LIVE_TEST === '1' &&
  process.env.AMB_LIVE_SEND === '1' &&
  process.env.AMB_LIVE_E2E === '1';
// Module scope, DEFAULT (real) path — resolved only when all gates are set,
// dereferenced ONLY inside callbacks (collection-time caveat, batch-2 header).
const creds = liveEnabled ? loadLiveCreds() : null;

describe.skipIf(!liveEnabled || creds === null)('full pipeline E2E (live, real codex)', () => {
  let assembled: AssembledDaemon | undefined;
  let probeTransport: MailTransport | undefined;
  let probeDb: ReturnType<typeof openDatabase> | undefined;
  let smtp: Transporter | undefined;

  let scratchDir = '';
  let worktreesRoot = '';

  let baselineUidValidity = '';
  let baselineSinceUid = 0;

  // Counted by the driver wrapper; asserted by the test.
  let codexStartCalls = 0;
  let codexResumeCalls = 0;

  const reportData: Record<string, unknown> = {};

  function assertCodexCap(): void {
    if (codexStartCalls + codexResumeCalls > CODEX_CALL_CAP) {
      throw new Error(
        `E2E hard stop: codex call cap ${String(CODEX_CALL_CAP)} exceeded ` +
          `(start=${String(codexStartCalls)}, resume=${String(codexResumeCalls)})`,
      );
    }
  }

  async function writeReport(patch: Record<string, unknown>): Promise<void> {
    Object.assign(reportData, patch);
    const target = process.env.AMB_E2E_REPORT ?? join(tmpdir(), 'amb-e2e-report.json');
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

  /** Runs mail ticks until the command row for `normalizedId` exists, then
   *  returns THAT tick's report plus the row's fate. The tick that ingests a
   *  READY mail also dispatches it (blocking through the real codex run), so
   *  the returned report already reflects the dispatch outcome. */
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
        throw new Error(`E2E: reply carrying its outbox id was not visible within ${String(deadlineMs)}ms`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  beforeAll(async () => {
    if (creds === null) {
      throw new Error('unreachable: describe.skipIf excludes creds === null from a running beforeAll');
    }

    // Throwaway project the bridge is allowed to work in — under os.tmpdir(),
    // NEVER the user's real projects (red line 1).
    scratchDir = await mkdtemp(join(tmpdir(), 'amb-e2e-'));
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

    // Production builders, with buildDriver wrapped to count + cap the only
    // quota-spending calls (startTask / resumeTask).
    const base = buildProductionAssemblyBuilders();
    const builders: AssemblyBuilders = {
      ...base,
      buildDriver: (): AgentDriver => {
        const real = base.buildDriver();
        return {
          capabilities: () => real.capabilities(),
          startTask: async (input: AgentTaskInput): Promise<AgentTaskHandle> => {
            codexStartCalls += 1;
            assertCodexCap();
            return real.startTask(input);
          },
          resumeTask: async (sessionId: string, input: AgentTaskInput): Promise<AgentTaskHandle> => {
            codexResumeCalls += 1;
            assertCodexCap();
            return real.resumeTask(sessionId, input);
          },
          streamEvents: (handle) => real.streamEvents(handle),
          close: () => real.close(),
        };
      },
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
    // Best-effort, per-resource: one rejecting close() must not strand the
    // scratch dir or a later handle. This is teardown of throwaway state
    // under os.tmpdir() — swallow each step's failure but always run the next
    // (a leaked temp dir/handle is harmless and must never mask the result).
    // `() => unknown` so a sync close() returning a chainable handle (e.g.
    // better-sqlite3's `Database`) is accepted; `await` just discards it.
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
    'routes a real self-mail to a real codex run, mails a scrubbed reply back, then resumes on a thread reply',
    async () => {
      if (creds === null) {
        throw new Error('unreachable: gated');
      }

      // ---- Task 1: a brand-new command ----
      const t1SentAt = Date.now();
      const control1Raw = await sendControlMail({
        subject: 'e2e-scratch-repo e2e task one',
        body: "Append the line 'e2e-task-1-ok' to NOTES.md, then stop. Keep the change minimal.",
      });
      const norm1 = normalizeMessageId(control1Raw);
      if (norm1 === null) {
        throw new Error('E2E: nodemailer Message-ID for task 1 did not normalize');
      }

      const t1 = await pumpUntilProcessed(norm1, MAIL_DEADLINE_MS);

      // ADR-0003 live check: a legitimate self-mail must carry NO
      // Authentication-Results and therefore pass the AUTH gate.
      if (t1.status === 'REJECTED' && t1.statusReason === 'AUTH_RESULTS_PRESENT') {
        throw new Error(
          'ADR-0003 FALSIFIED (red line 6): the authenticated self-mail arrived carrying an ' +
            'Authentication-Results header and was quarantined AUTH_RESULTS_PRESENT — the identity ' +
            'gate is closed against legitimate self-mail. STOP and revisit ADR-0003 before any ' +
            'further ignition. (No codex quota was spent: the gate fails closed before dispatch.)',
        );
      }
      // Reached dispatch but codex did not execute ⇒ almost certainly codex is
      // not authenticated on this host (or the driver reported `failed`).
      if (t1.status === 'READY_FOR_DISPATCH' && t1.report.dispatched === 0) {
        throw new Error(
          'E2E: task 1 passed every gate (READY_FOR_DISPATCH) but codex did not execute ' +
            `(dispatched=0, replies=${String(t1.report.replies.length)}, ` +
            `codexStartCalls=${String(codexStartCalls)}). Likely codex is not logged in ` +
            '(`codex login`) or the driver reported failure. No further tasks attempted.',
        );
      }
      expect(t1.status).toBe('READY_FOR_DISPATCH');
      expect(t1.report.dispatched).toBe(1);
      expect(codexStartCalls).toBe(1);
      expect(codexResumeCalls).toBe(0);
      expect(t1.report.replies.length).toBe(1);
      const reply1 = t1.report.replies[0];
      if (reply1 === undefined || reply1.outboxId === null) {
        throw new Error('E2E: task 1 dispatch produced no registered reply row');
      }
      expect(reply1.status).toBe('SENT');

      // Read the reply back and prove the C9 render scrub held live.
      const replyMail1 = await findReplyByOutboxId(reply1.outboxId, MAIL_DEADLINE_MS);
      const t1RoundTripMs = Date.now() - t1SentAt;
      const body1 = replyMail1.bodyText ?? '';
      const subject1 = replyMail1.headers.get('subject')?.[0] ?? '';
      const leak1 = {
        passInBody: body1.includes(creds.pass),
        worktreeInBody: body1.includes(worktreesRoot),
        homeInBody: body1.includes(homedir()),
        passInSubject: subject1.includes(creds.pass),
        worktreeInSubject: subject1.includes(worktreesRoot),
      };
      expect(body1.length).toBeGreaterThan(0);
      expect(leak1.passInBody).toBe(false);
      expect(leak1.worktreeInBody).toBe(false);
      expect(leak1.homeInBody).toBe(false);
      expect(leak1.passInSubject).toBe(false);
      expect(leak1.worktreeInSubject).toBe(false);

      // The MVP exit metric.
      expect(t1RoundTripMs).toBeLessThan(EXIT_METRIC_MS);

      // Persist task-1 evidence NOW so a later task-2 failure cannot erase it.
      await writeReport({
        task1: {
          status: t1.status,
          dispatched: t1.report.dispatched,
          roundTripMs: t1RoundTripMs,
          exitMetricMs: EXIT_METRIC_MS,
          exitMetricMet: t1RoundTripMs < EXIT_METRIC_MS,
          codexStartCalls,
          codexResumeCalls,
          replyStatus: reply1.status,
          replyBodyNonEmpty: body1.length > 0,
          leakChecks: leak1,
        },
      });

      // ---- Task 2: a reply on the same thread → resume the same session ----
      const t2SentAt = Date.now();
      const control2Raw = await sendControlMail({
        subject: 'e2e-scratch-repo e2e task two',
        body: "Now also append the line 'e2e-task-2-ok' to NOTES.md, then stop.",
        inReplyTo: control1Raw,
      });
      const norm2 = normalizeMessageId(control2Raw);
      if (norm2 === null) {
        throw new Error('E2E: nodemailer Message-ID for task 2 did not normalize');
      }

      const t2 = await pumpUntilProcessed(norm2, MAIL_DEADLINE_MS);
      if (t2.status === 'READY_FOR_DISPATCH' && t2.report.dispatched === 0) {
        throw new Error(
          'E2E: task 2 passed every gate but codex did not execute ' +
            `(dispatched=0, codexResumeCalls=${String(codexResumeCalls)}, ` +
            `codexStartCalls=${String(codexStartCalls)}).`,
        );
      }
      expect(t2.status).toBe('READY_FOR_DISPATCH');
      expect(t2.report.dispatched).toBe(1);
      // Thread continuity must win: the SAME codex session is resumed, not a
      // fresh one started.
      expect(codexResumeCalls).toBe(1);
      expect(codexStartCalls).toBe(1);
      expect(codexStartCalls + codexResumeCalls).toBe(2);
      const reply2 = t2.report.replies[0];
      if (reply2 === undefined || reply2.outboxId === null) {
        throw new Error('E2E: task 2 dispatch produced no registered reply row');
      }
      expect(reply2.status).toBe('SENT');

      const replyMail2 = await findReplyByOutboxId(reply2.outboxId, MAIL_DEADLINE_MS);
      const t2RoundTripMs = Date.now() - t2SentAt;
      const body2 = replyMail2.bodyText ?? '';
      const subject2 = replyMail2.headers.get('subject')?.[0] ?? '';
      const leak2 = {
        passInBody: body2.includes(creds.pass),
        worktreeInBody: body2.includes(worktreesRoot),
        homeInBody: body2.includes(homedir()),
        passInSubject: subject2.includes(creds.pass),
        worktreeInSubject: subject2.includes(worktreesRoot),
      };
      // Empty-body guard (parity with task 1): a '' body would make every
      // .includes() vacuously false, so pin non-emptiness before the checks.
      expect(body2.length).toBeGreaterThan(0);
      expect(leak2.passInBody).toBe(false);
      expect(leak2.worktreeInBody).toBe(false);
      expect(leak2.homeInBody).toBe(false);
      expect(leak2.passInSubject).toBe(false);
      expect(leak2.worktreeInSubject).toBe(false);

      await writeReport({
        task2: {
          status: t2.status,
          dispatched: t2.report.dispatched,
          roundTripMs: t2RoundTripMs,
          resumedSameSession: codexResumeCalls === 1,
          codexStartCalls,
          codexResumeCalls,
          totalCodexCalls: codexStartCalls + codexResumeCalls,
          replyStatus: reply2.status,
          leakChecks: leak2,
        },
      });
    },
    TEST_TIMEOUT_MS,
  );
});
