import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreateWorktreeInput } from '../../src/application/worktreeManager.js';
import { deriveIntentId, normalizeMessageId } from '../../src/domain/mail.js';
import type { NormalizedMessageId } from '../../src/domain/mail.js';
import type { ProjectEntry, ProjectIndex } from '../../src/application/projectIndex.js';
import type {
  CoordinatorRunInput,
  CoordinatorRunOutcome,
  RunCoordinatorTurn,
} from '../../src/drivers/coordinatorDriver.js';
import type { DriverEvent } from '../../src/drivers/types.js';
import { buildRegisterOutbox } from '../../src/daemon/replySender.js';
import {
  dispatchReadyCommand,
  recoverInterruptedIntents,
  runMailTick,
  runOrphanTick,
  sweepExpiredClarifications,
  sweepStrandedSending,
} from '../../src/daemon/ticks.js';
import type { CoordinatorTickConfig, MailTickDeps } from '../../src/daemon/ticks.js';
import { openDatabase } from '../../src/store/database.js';
import { ClarificationStore } from '../../src/store/clarificationStore.js';
import { CommandStore } from '../../src/store/commandStore.js';
import { CoordinatorSessionStore } from '../../src/store/coordinatorSessionStore.js';
import { IntentStore } from '../../src/store/intentStore.js';
import { MetaStore } from '../../src/store/metaStore.js';
import { OutboxStore } from '../../src/store/outboxStore.js';
import { SessionStore } from '../../src/store/sessionStore.js';
import { createIngest } from '../../src/application/ingest.js';
import type { IncomingMail } from '../../src/transports/types.js';
import { FakeAgentDriver } from '../helpers/fakeAgentDriver.js';
import { FakeMailTransport, FAKE_MAILBOX, FAKE_UID_VALIDITY } from '../helpers/fakeTransport.js';

// Guards D-P4B11-3 (the four daemon ticks) and the dispatch glue they share,
// from docs/superpowers/plans/2026-07-19-phase-4-batch11-daemon-ticks.md.
// Test style follows dispatch.test.ts / ingest.test.ts: REAL in-memory
// stores (every state machine stays armed), FakeMailTransport wired with the
// REAL buildRegisterOutbox (so outbox rows flow through production
// registration), FakeAgentDriver scripts, injected worktree/directory fakes,
// a deterministic ticking clock. ZERO real codex, ZERO real mail (red lines
// — the whole batch runs against fakes).
//
// Fixture discipline (public repo): placeholder addresses/message ids,
// synthetic /tmp/fixtures/* paths, low-entropy tokens.

type Db = ReturnType<typeof openDatabase>;

const SELF = 'bridge-user@example.com';
const READY_AT = '2026-07-17T00:00:00.000Z';
const SEED_NOW = '2026-07-18T00:00:00.000Z';
const PROJECT_PATH = '/tmp/fixtures/roots/proj-a';
const WORKTREES_ROOT = '/tmp/fixtures/worktrees';
const HOME = '/tmp/fixtures/home-x';
const EXPECTED_WORKTREE = `${WORKTREES_ROOT}/amb-session-1`;

/** The default driver segment ends with a resultText that NAMES the worktree
 *  path — the happy-path test pins that the reply's ScrubContext really came
 *  from the post-dispatch session row (path -> `<cwd>`). */
const COMPLETED_EVENT: DriverEvent = {
  kind: 'completed',
  resultText: `all done in ${EXPECTED_WORKTREE}`,
};
const DEFAULT_SEGMENT: readonly DriverEvent[] = [
  { kind: 'agent-message', text: 'working on it' },
  COMPLETED_EVENT,
];

let openDbs: Db[];

beforeEach(() => {
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
});

interface SetupOptions {
  entries?: readonly ProjectEntry[];
  script?: readonly (readonly DriverEvent[])[];
  dryRun?: boolean;
}

interface Harness {
  db: Db;
  commandStore: CommandStore;
  intentStore: IntentStore;
  sessionStore: SessionStore;
  outboxStore: OutboxStore;
  metaStore: MetaStore;
  clarificationStore: ClarificationStore;
  transport: FakeMailTransport;
  driver: FakeAgentDriver;
  deps: MailTickDeps;
  /** Runs the production ingest directly — orphan-tick tests use this to
   *  stage "ingested but never dispatched" crash states. */
  ingestDirect: (mail: IncomingMail) => void;
  clock: () => string;
}

function setup(options: SetupOptions = {}): Harness {
  const db = openDatabase(':memory:');
  openDbs.push(db);

  const commandStore = new CommandStore(db);
  const intentStore = new IntentStore(db);
  const sessionStore = new SessionStore(db);
  const outboxStore = new OutboxStore(db);
  const metaStore = new MetaStore(db);
  const clarificationStore = new ClarificationStore(db);
  metaStore.setReadyAtIfUnset(READY_AT);

  let tick = 0;
  const clock = (): string => new Date(Date.UTC(2026, 6, 19, 0, 0, tick++)).toISOString();

  const transport = new FakeMailTransport({
    registerOutbox: buildRegisterOutbox({ db, outboxStore, clock }),
  });
  const driver = new FakeAgentDriver(options.script ?? [DEFAULT_SEGMENT]);

  const entries: readonly ProjectEntry[] = options.entries ?? [
    { name: 'proj-a', path: PROJECT_PATH, aliases: ['alpha'] },
  ];
  const index: ProjectIndex = {
    entries,
    lookup(term) {
      const normalized = term.trim().toLowerCase();
      return entries.filter(
        (entry) => entry.name === normalized || entry.aliases.includes(normalized),
      );
    },
  };

  const ingestConfig = { selfAddress: SELF, dryRun: options.dryRun ?? false };

  const deps: MailTickDeps = {
    db,
    transport,
    commandStore,
    intentStore,
    sessionStore,
    outboxStore,
    metaStore,
    index,
    driver,
    createWorktree: async (input: CreateWorktreeInput) => ({
      worktreePath: `${WORKTREES_ROOT}/${input.taskId}`,
      baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    directoryExists: async () => true,
    worktreesRoot: WORKTREES_ROOT,
    baseRef: 'main',
    homeDir: HOME,
    mailbox: FAKE_MAILBOX,
    ingestConfig,
    clock,
  };

  const ingestDirect = createIngest({
    db,
    commandStore,
    intentStore,
    outboxStore,
    metaStore,
    config: ingestConfig,
  });

  return {
    db,
    commandStore,
    intentStore,
    sessionStore,
    outboxStore,
    metaStore,
    clarificationStore,
    transport,
    driver,
    deps,
    ingestDirect: (mail) => {
      ingestDirect(mail, new Date(clock()));
    },
    clock,
  };
}

function commandMail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: '<cmd-1@example.com>',
    headers: new Map([['subject', ['proj-a run tests']]]),
    from: [SELF],
    to: [SELF],
    cc: [],
    bodyText: 'run the quarterly cleanup task',
    internalDate: '2026-07-18T12:00:00.000Z',
    uid: 1,
    uidValidity: FAKE_UID_VALIDITY,
    mailbox: FAKE_MAILBOX,
    ...overrides,
  };
}

function intentIdOf(rawMessageId: string): string {
  const normalized = normalizeMessageId(rawMessageId);
  if (normalized === null) {
    throw new Error(`test fixture bug: ${rawMessageId} does not normalize`);
  }
  return deriveIntentId(normalized);
}

describe('recoverInterruptedIntents (D-P4B11-3)', () => {
  function seedIntent(harness: Harness, intentId: string, messageId: string): void {
    const { record } = harness.commandStore.insertIfAbsent({
      messageId,
      status: 'RECEIVED',
      statusReason: null,
      internalDate: SEED_NOW,
      uid: null,
      uidValidity: null,
      now: SEED_NOW,
    });
    harness.intentStore.createForCommand(intentId, record.id, false, SEED_NOW);
  }

  it('fails every RUNNING intent with the EXACT INTERRUPTED_BY_RESTART reason, leaving other statuses alone', () => {
    const harness = setup();
    seedIntent(harness, 'di-b', 'run-b@example.com');
    seedIntent(harness, 'di-a', 'run-a@example.com');
    seedIntent(harness, 'di-c', 'stay-c@example.com');
    harness.intentStore.transition('di-a', 'RUNNING', null, SEED_NOW);
    harness.intentStore.transition('di-b', 'RUNNING', null, SEED_NOW);

    const result = recoverInterruptedIntents({
      intentStore: harness.intentStore,
      clock: harness.clock,
    });

    // findByStatus id order, not seeding order.
    expect(result.recovered).toEqual(['di-a', 'di-b']);
    expect(harness.intentStore.getById('di-a')?.status).toBe('FAILED');
    expect(harness.intentStore.getById('di-a')?.statusReason).toBe('INTERRUPTED_BY_RESTART');
    expect(harness.intentStore.getById('di-b')?.statusReason).toBe('INTERRUPTED_BY_RESTART');
    expect(harness.intentStore.getById('di-c')?.status).toBe('PENDING');
  });

  it('is a no-op on an empty RUNNING set', () => {
    const harness = setup();

    expect(
      recoverInterruptedIntents({ intentStore: harness.intentStore, clock: harness.clock }),
    ).toEqual({ recovered: [] });
  });
});

describe('sweepExpiredClarifications (D-P4B11-3)', () => {
  it('expires PENDING records with expires_at <= now — the exactly-equal boundary included — and leaves future ones PENDING', () => {
    const harness = setup();
    // One command PER clarification: create() supersedes any existing
    // PENDING row for the SAME command, so sharing one command would leave
    // only the last record PENDING.
    const commandIdFor = (messageId: string): number =>
      harness.commandStore.insertIfAbsent({
        messageId,
        status: 'RECEIVED',
        statusReason: null,
        internalDate: SEED_NOW,
        uid: null,
        uidValidity: null,
        now: SEED_NOW,
      }).record.id;
    const base = {
      token: 'Aa-Aa-Tok-0001',
      candidateSetJson: '[]',
      candidateSetVersion: 1,
      now: SEED_NOW,
    };
    const past = harness.clarificationStore.create({
      ...base,
      commandId: commandIdFor('clar-past@example.com'),
      threadKey: 'thread-past@example.com',
      expiresAt: '2026-07-18T23:59:59.000Z',
    });
    // First clock draw inside the sweep is 2026-07-19T00:00:00.000Z — this
    // record expires at EXACTLY that instant (the shared <= boundary).
    const boundary = harness.clarificationStore.create({
      ...base,
      commandId: commandIdFor('clar-boundary@example.com'),
      threadKey: 'thread-boundary@example.com',
      expiresAt: '2026-07-19T00:00:00.000Z',
    });
    const future = harness.clarificationStore.create({
      ...base,
      commandId: commandIdFor('clar-future@example.com'),
      threadKey: 'thread-future@example.com',
      expiresAt: '2026-07-20T00:00:00.000Z',
    });

    const result = sweepExpiredClarifications({
      clarificationStore: harness.clarificationStore,
      clock: harness.clock,
    });

    expect(result.expired).toEqual([past.id, boundary.id]);
    expect(harness.clarificationStore.findByThreadKey('thread-past@example.com')?.status).toBe(
      'EXPIRED',
    );
    expect(harness.clarificationStore.findByThreadKey('thread-boundary@example.com')?.status).toBe(
      'EXPIRED',
    );
    expect(harness.clarificationStore.findByThreadKey('thread-future@example.com')?.status).toBe(
      'PENDING',
    );
    expect(future.status).toBe('PENDING');
  });

  it('is a no-op with nothing pending-expired', () => {
    const harness = setup();

    expect(
      sweepExpiredClarifications({
        clarificationStore: harness.clarificationStore,
        clock: harness.clock,
      }),
    ).toEqual({ expired: [] });
  });
});

describe('runMailTick (D-P4B11-3)', () => {
  it('happy full chain: fetch → ingest ready → markProcessed → dispatch → RESULT reply SENT, watermark advanced', async () => {
    const harness = setup();
    const mail = commandMail();
    harness.transport.deliver(mail);

    const report = await runMailTick(harness.deps);

    expect(report).toEqual({
      fetched: 1,
      outcomes: { duplicate: 0, echo: 0, rejected: 0, 'queued-window': 0, ready: 1 },
      dispatched: 1,
      replies: [{ outboxId: 'fake-outbox-1', status: 'SENT' }],
      failures: [],
    });

    // \Seen is applied whatever happens next.
    expect(harness.transport.processedMails).toEqual([mail]);

    // The driver ran inside the bridge-owned worktree with the mail body as
    // the prompt.
    expect(harness.driver.startTaskCalls).toEqual([
      { prompt: 'run the quarterly cleanup task', cwd: EXPECTED_WORKTREE, dryRun: false },
    ]);

    // The intent reached COMPLETED (state machine armed: PENDING→RUNNING→
    // COMPLETED all ran) under its derived id.
    const intentId = intentIdOf('<cmd-1@example.com>');
    expect(harness.intentStore.getById(intentId)?.status).toBe('COMPLETED');

    // RESULT reply: subject from the original subject, meta names the
    // project by its path's last segment, and the worktree path in the
    // driver's resultText was scrubbed via the post-dispatch session row.
    const sent = harness.transport.sentMails[0];
    expect(sent?.kind).toBe('RESULT');
    expect(sent?.commandId).toBe(1);
    expect(sent?.subjectRedacted).toBe('Re: proj-a run tests');
    expect(sent?.bodyRedacted).toContain('✅ completed (DISPATCH_NEW)');
    expect(sent?.bodyRedacted).toContain('project: proj-a');
    expect(sent?.bodyRedacted).toContain(`intent: ${intentId}`);
    expect(sent?.bodyRedacted).toContain('all done in <cwd>');
    expect(sent?.bodyRedacted).not.toContain(WORKTREES_ROOT);

    // Outbox row settled SENT under the normalized reconciliation key.
    const row = harness.outboxStore.findByCommandId(1)[0];
    expect(row?.status).toBe('SENT');
    expect(row?.messageId).toBe('fake-1@bridge-user.example.com');

    // Watermark reached the ingested uid.
    expect(harness.metaStore.getWatermark(FAKE_MAILBOX, FAKE_UID_VALIDITY)).toBe(1);

    // Session mapping recorded worktree + driver session.
    const session = harness.sessionStore.findByThreadKey('cmd-1@example.com');
    expect(session?.worktreePath).toBe(EXPECTED_WORKTREE);
    expect(session?.driverSessionId).toBe('fake-session-1');
  });

  it('processes fetched mail in ascending uid order and marks EVERY outcome processed (rejected mail included)', async () => {
    const harness = setup({ script: [] });
    // Delivered out of order; both REJECTED (attacker From fails C1).
    harness.transport.deliver(
      commandMail({ messageId: '<later@example.com>', uid: 3, from: ['mallory@example.net'] }),
    );
    harness.transport.deliver(
      commandMail({ messageId: '<earlier@example.com>', uid: 1, from: ['mallory@example.net'] }),
    );

    const report = await runMailTick(harness.deps);

    expect(report.outcomes.rejected).toBe(2);
    expect(report.dispatched).toBe(0);
    expect(report.replies).toEqual([]);
    expect(harness.transport.processedMails.map((mail) => mail.uid)).toEqual([1, 3]);
    expect(harness.transport.sentMails).toEqual([]);
  });

  it('echo reconciliation: an echo whose normalized Message-ID matches an UNCERTAIN outbox row confirms it SENT; non-UNCERTAIN rows are never touched', async () => {
    const harness = setup({ script: [] });
    harness.outboxStore.create({
      id: 'outbox-uncertain',
      messageId: 'echo-1@example.com',
      commandId: null,
      kind: 'RESULT',
      now: SEED_NOW,
    });
    harness.outboxStore.transition('outbox-uncertain', 'SENDING', SEED_NOW);
    harness.outboxStore.transition('outbox-uncertain', 'UNCERTAIN', SEED_NOW);
    harness.outboxStore.create({
      id: 'outbox-sending',
      messageId: 'echo-2@example.com',
      commandId: null,
      kind: 'RESULT',
      now: SEED_NOW,
    });
    harness.outboxStore.transition('outbox-sending', 'SENDING', SEED_NOW);
    // Echo mail shape mirrors reflectOutbound: empty address lists, the
    // echo gate matches on the recorded message id.
    harness.transport.deliver(
      commandMail({ messageId: '<echo-1@example.com>', uid: 1, from: [], to: [], cc: [] }),
    );
    harness.transport.deliver(
      commandMail({ messageId: '<echo-2@example.com>', uid: 2, from: [], to: [], cc: [] }),
    );

    const report = await runMailTick(harness.deps);

    expect(report.outcomes.echo).toBe(2);
    // The ONLY path out of UNCERTAIN (C3 reconciliation closes here).
    expect(harness.outboxStore.findByMessageId('echo-1@example.com')?.status).toBe('SENT');
    // A SENDING row is NOT reconciled — its send is still in flight, not
    // confirmed by this echo.
    expect(harness.outboxStore.findByMessageId('echo-2@example.com')?.status).toBe('SENDING');
    expect(report.failures).toEqual([]);
  });

  it('one poisoned mail lands in failures (message scrubbed) and does not stop the rest of the batch', async () => {
    const harness = setup();
    harness.transport.deliver(commandMail({ messageId: '<poisoned@example.com>', uid: 1 }));
    harness.transport.deliver(commandMail({ messageId: '<healthy@example.com>', uid: 2 }));
    const original = harness.transport.markProcessed.bind(harness.transport);
    harness.transport.markProcessed = (mail: IncomingMail): Promise<void> => {
      if (mail.uid === 1) {
        return Promise.reject(
          new Error(`imap: flag store failed under ${HOME}/.imap token=${'a'.repeat(48)}`),
        );
      }
      return original(mail);
    };

    const report = await runMailTick(harness.deps);

    expect(report.failures).toEqual([
      {
        uid: 1,
        stage: 'MARK_PROCESSED',
        // Red line 2: the report is log material — home path and token value
        // must arrive pre-scrubbed.
        message: 'imap: flag store failed under <home>/.imap token=<redacted>',
      },
    ]);
    expect(report.outcomes.ready).toBe(2);
    expect(report.dispatched).toBe(1);
    expect(report.replies).toEqual([{ outboxId: 'fake-outbox-1', status: 'SENT' }]);
    // The healthy mail's full chain still ran.
    expect(harness.intentStore.getById(intentIdOf('<healthy@example.com>'))?.status).toBe(
      'COMPLETED',
    );
    // The poisoned mail's intent is left PENDING — exactly the orphan
    // tick's input state.
    expect(harness.intentStore.getById(intentIdOf('<poisoned@example.com>'))?.status).toBe(
      'PENDING',
    );
  });

  it('fetchSince throwing is fatal for the tick and propagates to the shell', async () => {
    const harness = setup({ script: [] });
    harness.transport.fetchSince = () =>
      Promise.reject(new Error('UIDVALIDITY changed mid-fetch'));

    await expect(runMailTick(harness.deps)).rejects.toThrow('UIDVALIDITY changed mid-fetch');
  });

  it('UIDVALIDITY change rescans from watermark 0 on the new key and converges by Message-ID dedupe', async () => {
    const harness = setup();
    harness.transport.deliver(commandMail({ uid: 5 }));
    const first = await runMailTick(harness.deps);
    expect(first.dispatched).toBe(1);

    // The server reissued UIDs: same logical mail, new validity, re-fetched
    // from 0 because the watermark key changed.
    harness.transport.scriptedMailboxStatus = { uidValidity: '1690000099', uidNext: 6 };
    harness.transport.deliver(commandMail({ uid: 5, uidValidity: '1690000099' }));

    const second = await runMailTick(harness.deps);

    expect(second).toEqual({
      fetched: 1,
      outcomes: { duplicate: 1, echo: 0, rejected: 0, 'queued-window': 0, ready: 0 },
      dispatched: 0,
      replies: [],
      failures: [],
    });
    // No second dispatch, no second reply — idempotent convergence.
    expect(harness.transport.sentMails).toHaveLength(1);
    expect(harness.intentStore.countAll()).toBe(1);
    // The NEW key's watermark advanced; the old key's is untouched.
    expect(harness.metaStore.getWatermark(FAKE_MAILBOX, '1690000099')).toBe(5);
    expect(harness.metaStore.getWatermark(FAKE_MAILBOX, FAKE_UID_VALIDITY)).toBe(5);
  });

  it('extraction-incomplete (no subject, no body): intent two-step finalized EXTRACTION_INCOMPLETE, EXTRACTION-stage ERROR reply sent', async () => {
    const harness = setup({ script: [] });
    harness.transport.deliver(
      commandMail({ messageId: '<bare@example.com>', headers: new Map(), bodyText: null }),
    );

    const report = await runMailTick(harness.deps);

    expect(report.dispatched).toBe(0);
    expect(report.replies).toEqual([{ outboxId: 'fake-outbox-1', status: 'SENT' }]);
    const intent = harness.intentStore.getById(intentIdOf('<bare@example.com>'));
    expect(intent?.status).toBe('FAILED');
    expect(intent?.statusReason).toBe('EXTRACTION_INCOMPLETE');
    const sent = harness.transport.sentMails[0];
    expect(sent?.kind).toBe('ERROR');
    expect(sent?.subjectRedacted).toBe('amb: task update');
    expect(sent?.bodyRedacted).toContain('❌ dispatch failed (EXTRACTION)');
    expect(sent?.bodyRedacted).toContain('EXTRACTION_INCOMPLETE: missing prompt');
  });

  it('clarification stopgap (no match): one ROUTING-stage ERROR reply, intent stays PENDING', async () => {
    const harness = setup({ script: [] });
    harness.transport.deliver(
      commandMail({
        messageId: '<lost@example.com>',
        headers: new Map([['subject', ['unknown-proj do something']]]),
      }),
    );

    const report = await runMailTick(harness.deps);

    expect(report.dispatched).toBe(0);
    expect(report.replies).toEqual([{ outboxId: 'fake-outbox-1', status: 'SENT' }]);
    expect(harness.intentStore.getById(intentIdOf('<lost@example.com>'))?.status).toBe('PENDING');
    const sent = harness.transport.sentMails[0];
    expect(sent?.kind).toBe('ERROR');
    expect(sent?.bodyRedacted).toContain('❌ dispatch failed (ROUTING)');
    expect(sent?.bodyRedacted).toContain('cannot route: no match');
  });

  it('clarification stopgap (ambiguous): reason lists candidate NAMES only, never paths', async () => {
    const harness = setup({
      script: [],
      entries: [
        { name: 'proj-a', path: '/tmp/fixtures/roots/proj-a', aliases: ['shared'] },
        { name: 'proj-b', path: '/tmp/fixtures/roots/proj-b', aliases: ['shared'] },
      ],
    });
    harness.transport.deliver(
      commandMail({
        messageId: '<which@example.com>',
        headers: new Map([['subject', ['shared do something']]]),
      }),
    );

    await runMailTick(harness.deps);

    const sent = harness.transport.sentMails[0];
    expect(sent?.bodyRedacted).toContain(
      'cannot route: ambiguous (2 candidates: proj-a, proj-b)',
    );
    expect(sent?.bodyRedacted).not.toContain('/tmp/fixtures/roots');
  });

  it('dry-run config: skipped-dry-run yields a RESULT dry-run report reply, no driver call', async () => {
    const harness = setup({ script: [], dryRun: true });
    harness.transport.deliver(commandMail());

    const report = await runMailTick(harness.deps);

    expect(report.dispatched).toBe(0);
    expect(report.replies).toEqual([{ outboxId: 'fake-outbox-1', status: 'SENT' }]);
    expect(harness.intentStore.getById(intentIdOf('<cmd-1@example.com>'))?.status).toBe(
      'SKIPPED_DRY_RUN',
    );
    const sent = harness.transport.sentMails[0];
    expect(sent?.kind).toBe('RESULT');
    expect(sent?.bodyRedacted).toContain('🔍 dry-run (DISPATCH_NEW)');
    expect(harness.driver.startTaskCalls).toEqual([]);
  });
});

describe('runOrphanTick (D-P4B11-3)', () => {
  it('re-fetches a crash-orphaned READY command by uid-1 and dispatches it in place, RESULT reply included', async () => {
    const harness = setup();
    const mail = commandMail();
    harness.transport.deliver(mail);
    // Crash state: ingested (READY + PENDING intent) but never dispatched.
    harness.ingestDirect(mail);
    const intentId = intentIdOf('<cmd-1@example.com>');
    expect(harness.intentStore.getById(intentId)?.status).toBe('PENDING');

    const report = await runOrphanTick(harness.deps);

    expect(report).toEqual({
      scanned: 1,
      dispatched: 1,
      replies: [{ outboxId: 'fake-outbox-1', status: 'SENT' }],
      finalized: [],
      skipped: [],
    });
    expect(harness.intentStore.getById(intentId)?.status).toBe('COMPLETED');
    expect(harness.transport.sentMails[0]?.kind).toBe('RESULT');
    expect(harness.driver.startTaskCalls).toHaveLength(1);
  });

  it('skips an intent whose command already carries an ERROR outbox row (clarification held): told once, never re-told', async () => {
    const harness = setup({ script: [] });
    harness.transport.deliver(
      commandMail({
        messageId: '<lost@example.com>',
        headers: new Map([['subject', ['unknown-proj do something']]]),
      }),
    );
    // First pass: the mail tick sends the one-time cannot-route notice.
    await runMailTick(harness.deps);
    expect(harness.transport.sentMails).toHaveLength(1);
    const intentId = intentIdOf('<lost@example.com>');

    const report = await runOrphanTick(harness.deps);

    expect(report.skipped).toEqual([{ intentId, reason: 'CLARIFICATION_HELD' }]);
    expect(report.dispatched).toBe(0);
    expect(report.finalized).toEqual([]);
    // No second notice, intent still awaiting the clarification batch.
    expect(harness.transport.sentMails).toHaveLength(1);
    expect(harness.intentStore.getById(intentId)?.status).toBe('PENDING');
  });

  it('skips an intent whose command is not READY_FOR_DISPATCH', async () => {
    const harness = setup({ script: [] });
    const { record } = harness.commandStore.insertIfAbsent({
      messageId: 'received-only@example.com',
      status: 'RECEIVED',
      statusReason: null,
      internalDate: SEED_NOW,
      uid: 1,
      uidValidity: FAKE_UID_VALIDITY,
      now: SEED_NOW,
    });
    harness.intentStore.createForCommand('di-received', record.id, false, SEED_NOW);

    const report = await runOrphanTick(harness.deps);

    expect(report.skipped).toEqual([{ intentId: 'di-received', reason: 'COMMAND_NOT_READY' }]);
    expect(harness.intentStore.getById('di-received')?.status).toBe('PENDING');
  });

  it('finalizes ORPHAN_COMMAND_MISSING when the command row is gone (defensive, FK makes it unreachable)', async () => {
    const harness = setup({ script: [] });
    const { record } = harness.commandStore.insertIfAbsent({
      messageId: 'vanishing@example.com',
      status: 'RECEIVED',
      statusReason: null,
      internalDate: SEED_NOW,
      uid: 1,
      uidValidity: FAKE_UID_VALIDITY,
      now: SEED_NOW,
    });
    harness.intentStore.createForCommand('di-vanish', record.id, false, SEED_NOW);
    // The FK prevents actually deleting the row — model the defensive branch
    // by wrapping the lookup (dispatch.test.ts's instrumentation precedent).
    harness.commandStore.getById = () => undefined;

    const report = await runOrphanTick(harness.deps);

    expect(report.finalized).toEqual([
      { intentId: 'di-vanish', reason: 'ORPHAN_COMMAND_MISSING' },
    ]);
    const intent = harness.intentStore.getById('di-vanish');
    expect(intent?.status).toBe('FAILED');
    expect(intent?.statusReason).toBe('ORPHAN_COMMAND_MISSING');
  });

  it('finalizes ORPHAN_NO_UID when the command has no uid to re-fetch by', async () => {
    const harness = setup({ script: [] });
    const { record } = harness.commandStore.insertIfAbsent({
      messageId: 'no-uid@example.com',
      status: 'RECEIVED',
      statusReason: null,
      internalDate: SEED_NOW,
      uid: null,
      uidValidity: null,
      now: SEED_NOW,
    });
    harness.commandStore.updateStatus(record.id, 'READY_FOR_DISPATCH', null, SEED_NOW);
    harness.intentStore.createForCommand('di-no-uid', record.id, false, SEED_NOW);

    const report = await runOrphanTick(harness.deps);

    expect(report.finalized).toEqual([{ intentId: 'di-no-uid', reason: 'ORPHAN_NO_UID' }]);
    expect(harness.intentStore.getById('di-no-uid')?.statusReason).toBe('ORPHAN_NO_UID');
  });

  it('finalizes ORPHAN_UNRECOVERABLE when the re-fetch itself throws (validity changed)', async () => {
    const harness = setup({ script: [] });
    const mail = commandMail();
    harness.transport.deliver(mail);
    harness.ingestDirect(mail);
    harness.transport.fetchSince = () =>
      Promise.reject(new Error('UIDVALIDITY changed since ingest'));
    const intentId = intentIdOf('<cmd-1@example.com>');

    const report = await runOrphanTick(harness.deps);

    expect(report.finalized).toEqual([{ intentId, reason: 'ORPHAN_UNRECOVERABLE' }]);
    expect(harness.intentStore.getById(intentId)?.statusReason).toBe('ORPHAN_UNRECOVERABLE');
  });

  it('finalizes ORPHAN_MAIL_GONE when the uid no longer exists in the mailbox (expunged)', async () => {
    const harness = setup({ script: [] });
    const { record } = harness.commandStore.insertIfAbsent({
      messageId: 'gone@example.com',
      status: 'RECEIVED',
      statusReason: null,
      internalDate: SEED_NOW,
      uid: 9,
      uidValidity: FAKE_UID_VALIDITY,
      now: SEED_NOW,
    });
    harness.commandStore.updateStatus(record.id, 'READY_FOR_DISPATCH', null, SEED_NOW);
    harness.intentStore.createForCommand('di-gone', record.id, false, SEED_NOW);

    const report = await runOrphanTick(harness.deps);

    expect(report.finalized).toEqual([{ intentId: 'di-gone', reason: 'ORPHAN_MAIL_GONE' }]);
    expect(harness.intentStore.getById('di-gone')?.statusReason).toBe('ORPHAN_MAIL_GONE');
  });
});

// D-P5B12-2: register-then-crash residue (SENDING rows with no in-flight
// send left to settle them) is swept onto the reconciliation track at
// startup — UNCERTAIN is the only honest state (whether SMTP happened is
// unknowable), and the echo pass is its only exit.
describe('sweepStrandedSending (D-P5B12-2)', () => {
  it('moves every SENDING row to UNCERTAIN and leaves PENDING/SENT/UNCERTAIN rows untouched', () => {
    const harness = setup();
    const now = harness.clock();
    const mk = (id: string, msg: string): void => {
      harness.outboxStore.create({
        id,
        messageId: msg,
        commandId: null,
        kind: 'RESULT',
        now,
      });
    };
    mk('ob-stranded-1', 'stranded-1@example.com');
    harness.outboxStore.transition('ob-stranded-1', 'SENDING', now);
    mk('ob-stranded-2', 'stranded-2@example.com');
    harness.outboxStore.transition('ob-stranded-2', 'SENDING', now);
    mk('ob-pending', 'pending@example.com');
    mk('ob-sent', 'sent@example.com');
    harness.outboxStore.transition('ob-sent', 'SENDING', now);
    harness.outboxStore.transition('ob-sent', 'SENT', now);
    mk('ob-uncertain', 'uncertain@example.com');
    harness.outboxStore.transition('ob-uncertain', 'SENDING', now);
    harness.outboxStore.transition('ob-uncertain', 'UNCERTAIN', now);

    const result = sweepStrandedSending({ outboxStore: harness.outboxStore, clock: harness.clock });

    expect(result.swept).toEqual(['ob-stranded-1', 'ob-stranded-2']);
    expect(harness.outboxStore.findByStatus('SENDING')).toEqual([]);
    expect(harness.outboxStore.findByStatus('UNCERTAIN').map((row) => row.id)).toEqual([
      'ob-stranded-1',
      'ob-stranded-2',
      'ob-uncertain',
    ]);
    expect(harness.outboxStore.findByStatus('PENDING').map((row) => row.id)).toEqual(['ob-pending']);
    expect(harness.outboxStore.findByStatus('SENT').map((row) => row.id)).toEqual(['ob-sent']);
  });

  it('is a no-op with no SENDING rows', () => {
    const harness = setup();

    const result = sweepStrandedSending({ outboxStore: harness.outboxStore, clock: harness.clock });

    expect(result.swept).toEqual([]);
  });

  it('a swept row is reconcilable: a later echo of its Message-ID confirms it SENT (the one exit from UNCERTAIN)', async () => {
    const harness = setup();
    const now = harness.clock();
    harness.outboxStore.create({
      id: 'ob-recover',
      messageId: 'recover-me@example.com',
      commandId: null,
      kind: 'RESULT',
      now,
    });
    harness.outboxStore.transition('ob-recover', 'SENDING', now);
    sweepStrandedSending({ outboxStore: harness.outboxStore, clock: harness.clock });

    harness.transport.reflectOutbound(
      { outboxId: 'ob-recover', messageId: '<recover-me@example.com>' },
      '2026-07-18T12:00:00.000Z',
    );
    const report = await runMailTick(harness.deps);

    expect(report.outcomes.echo).toBe(1);
    expect(harness.outboxStore.findByMessageId('recover-me@example.com')?.status).toBe('SENT');
  });
});

// Review-minor ① (batch-11): the alreadyTold dedupe INSIDE the dispatch glue,
// reached directly — both tick entry points shield it (the mail tick via
// Message-ID dedupe, the orphan tick via its CLARIFICATION_HELD pre-check),
// so only a direct second call proves the in-glue check itself works.
describe('dispatchReadyCommand alreadyTold dedupe (direct, D-P5B12-2)', () => {
  it('second direct call for the same clarification-needed command sends NOTHING (reply null, zero new mail)', async () => {
    const harness = setup({ script: [] });
    const mail = commandMail({
      messageId: '<lost-direct@example.com>',
      headers: new Map([['subject', ['unknown-proj do something']]]),
    });
    harness.transport.deliver(mail);
    harness.ingestDirect(mail);
    const intentId = intentIdOf('<lost-direct@example.com>');
    const command = harness.commandStore.getByMessageId('lost-direct@example.com');
    if (command === null) {
      throw new Error('test fixture bug: command row missing after ingest');
    }

    const first = await dispatchReadyCommand(harness.deps, mail, command.id, intentId);
    expect(first.executed).toBe(false);
    expect(first.reply).toEqual({ outboxId: 'fake-outbox-1', status: 'SENT' });
    expect(harness.transport.sentMails).toHaveLength(1);

    const second = await dispatchReadyCommand(harness.deps, mail, command.id, intentId);

    expect(second.executed).toBe(false);
    expect(second.reply).toBeNull();
    expect(harness.transport.sentMails).toHaveLength(1);
    expect(harness.intentStore.getById(intentId)?.status).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------
// ADR-0006 coordinator path (batch E-d wiring)
// ---------------------------------------------------------------------------

const COORD_UUID = '11111111-2222-3333-4444-555555555555';
const COORD_CWD = '/tmp/fixtures/coord-cwd';
const COORD_SCHEMA_PATH = '/tmp/fixtures/coord-schema.json';

interface CoordProbe {
  /** The REAL coordinator-session store the daemon persisted resume ids into. */
  sessionStore: CoordinatorSessionStore;
  /** Every input the daemon fed the (fake) coordinator turn, in call order. */
  inputs: CoordinatorRunInput[];
}

/** Attaches a scripted coordinator to `harness.deps`: a fake
 *  `runCoordinatorTurn` that returns `outcomes[n]` on its n-th call (the last
 *  one repeats) and records its inputs, over a REAL `CoordinatorSessionStore`
 *  on the harness db — so persistence + resume threading are exercised for
 *  real, only the model turn is faked. */
function attachCoordinator(harness: Harness, outcomes: readonly CoordinatorRunOutcome[]): CoordProbe {
  const sessionStore = new CoordinatorSessionStore(harness.db);
  const inputs: CoordinatorRunInput[] = [];
  let call = 0;
  const runCoordinatorTurn: RunCoordinatorTurn = (input) => {
    inputs.push(input);
    const outcome = outcomes[Math.min(call, outcomes.length - 1)];
    call += 1;
    if (outcome === undefined) {
      throw new Error('test fixture bug: attachCoordinator needs at least one outcome');
    }
    return Promise.resolve(outcome);
  };
  harness.deps.coordinator = {
    runCoordinatorTurn,
    coordinatorSessionStore: sessionStore,
    coordinatorCwd: COORD_CWD,
    schemaPath: COORD_SCHEMA_PATH,
  } satisfies CoordinatorTickConfig;
  return { sessionStore, inputs };
}

/** Delivers + ingests a command mail (mirrors the alreadyTold direct test),
 *  returning the ids a direct `dispatchReadyCommand` call needs. */
function seedReady(harness: Harness, mail: IncomingMail): { commandId: number; intentId: string } {
  harness.transport.deliver(mail);
  harness.ingestDirect(mail);
  const normalized = normalizeMessageId(mail.messageId);
  if (normalized === null) {
    throw new Error(`test fixture bug: ${mail.messageId} does not normalize`);
  }
  const command = harness.commandStore.getByMessageId(normalized);
  if (command === null) {
    throw new Error('test fixture bug: command row missing after ingest');
  }
  return { commandId: command.id, intentId: deriveIntentId(normalized) };
}

describe('dispatchReadyCommand coordinator path (ADR-0006, batch E-d)', () => {
  it('answer → intent RESOLVED, 💬 answer RESULT reply, coordinator session persisted', async () => {
    const harness = setup();
    const coord = attachCoordinator(harness, [
      {
        kind: 'decided',
        decision: { kind: 'answer', text: 'two tasks are running.' },
        sessionId: COORD_UUID,
      },
    ]);
    const mail = commandMail({ messageId: '<coord-answer@example.com>' });
    const { commandId, intentId } = seedReady(harness, mail);

    const result = await dispatchReadyCommand(harness.deps, mail, commandId, intentId);

    expect(result.executed).toBe(false);
    expect(result.reply?.status).toBe('SENT');
    expect(harness.intentStore.getById(intentId)?.status).toBe('RESOLVED');

    const sent = harness.transport.sentMails.at(-1);
    expect(sent?.bodyRedacted).toContain('💬 answer');
    expect(sent?.bodyRedacted).toContain('two tasks are running.');
    expect(harness.outboxStore.findByCommandId(commandId)[0]?.kind).toBe('RESULT');

    // no agent ran, and the coordinator's OWN thread id is persisted for resume
    expect(harness.driver.startTaskCalls).toHaveLength(0);
    expect(harness.sessionStore.findByThreadKey('coord-answer@example.com')).toBeUndefined();
    expect(
      coord.sessionStore.findByThreadKey('coord-answer@example.com')?.coordinatorThreadId,
    ).toBe(COORD_UUID);
  });

  it('clarify → intent RESOLVED, ❓ clarification reply carrying option names', async () => {
    const harness = setup();
    const coord = attachCoordinator(harness, [
      {
        kind: 'decided',
        decision: {
          kind: 'clarify',
          question: 'which project did you mean?',
          options: ['proj-a', 'proj-b'],
        },
        sessionId: COORD_UUID,
      },
    ]);
    const mail = commandMail({ messageId: '<coord-clarify@example.com>' });
    const { commandId, intentId } = seedReady(harness, mail);

    const result = await dispatchReadyCommand(harness.deps, mail, commandId, intentId);

    expect(result.executed).toBe(false);
    expect(harness.intentStore.getById(intentId)?.status).toBe('RESOLVED');

    const sent = harness.transport.sentMails.at(-1);
    expect(sent?.bodyRedacted).toContain('❓ clarification');
    expect(sent?.bodyRedacted).toContain('which project did you mean?');
    expect(sent?.bodyRedacted).toContain('- proj-a');
    expect(sent?.bodyRedacted).toContain('- proj-b');
    expect(harness.outboxStore.findByCommandId(commandId)[0]?.kind).toBe('CLARIFICATION');
    expect(
      coord.sessionStore.findByThreadKey('coord-clarify@example.com')?.coordinatorThreadId,
    ).toBe(COORD_UUID);
  });

  it('dispatch new → shared tail runs on the DECISION prompt, COMPLETED + RESULT reply', async () => {
    const harness = setup(); // default script = one completed segment
    const coord = attachCoordinator(harness, [
      {
        kind: 'decided',
        decision: {
          kind: 'dispatch',
          projectAlias: 'proj-a',
          prompt: 'do the coordinated thing',
          mode: 'new',
        },
        sessionId: COORD_UUID,
      },
    ]);
    // The subject term is NOT a project name — only the coordinator's
    // projectAlias can route this, proving the coordinator (not routeCommand)
    // decided the dispatch.
    const mail = commandMail({
      messageId: '<coord-dispatch@example.com>',
      headers: new Map([['subject', ['hey can you look into the flaky test']]]),
      bodyText: 'the CI keeps going red',
    });
    const { commandId, intentId } = seedReady(harness, mail);

    const result = await dispatchReadyCommand(harness.deps, mail, commandId, intentId);

    expect(result.executed).toBe(true);
    expect(harness.intentStore.getById(intentId)?.status).toBe('COMPLETED');
    // the coordinator's decision.prompt drove the driver, NOT the mail body
    expect(harness.driver.startTaskCalls[0]?.prompt).toBe('do the coordinated thing');

    const sent = harness.transport.sentMails.at(-1);
    expect(sent?.bodyRedacted).toContain('✅ completed (DISPATCH_NEW)');
    // both mappings recorded: the execution session AND the coordinator session
    expect(harness.sessionStore.findByThreadKey('coord-dispatch@example.com')).toBeDefined();
    expect(
      coord.sessionStore.findByThreadKey('coord-dispatch@example.com')?.coordinatorThreadId,
    ).toBe(COORD_UUID);
  });

  it('fell-back → deterministic router takes over (subject term routes); no coordinator session written', async () => {
    const harness = setup();
    const coord = attachCoordinator(harness, [
      { kind: 'failed', reason: 'coordinator crashed before completing' },
    ]);
    // default subject 'proj-a run tests' → the deterministic term routes to proj-a
    const mail = commandMail({ messageId: '<coord-fallback@example.com>' });
    const { commandId, intentId } = seedReady(harness, mail);

    const result = await dispatchReadyCommand(harness.deps, mail, commandId, intentId);

    expect(result.executed).toBe(true);
    expect(harness.intentStore.getById(intentId)?.status).toBe('COMPLETED');
    // the deterministic path uses the mail body as the prompt, not any decision
    expect(harness.driver.startTaskCalls[0]?.prompt).toBe('run the quarterly cleanup task');

    const sent = harness.transport.sentMails.at(-1);
    expect(sent?.bodyRedacted).toContain('✅ completed (DISPATCH_NEW)');
    // a failed turn carries no id — nothing persisted, so the next mail also
    // starts a fresh coordinator conversation
    expect(coord.sessionStore.findByThreadKey('coord-fallback@example.com')).toBeUndefined();
  });

  it('an already-persisted coordinator session is passed back as resumeSessionId', async () => {
    const harness = setup();
    const coord = attachCoordinator(harness, [
      { kind: 'decided', decision: { kind: 'answer', text: 'still running.' }, sessionId: COORD_UUID },
    ]);
    coord.sessionStore.upsert('coord-resume@example.com', COORD_UUID, SEED_NOW);
    const mail = commandMail({ messageId: '<coord-resume@example.com>' });
    const { commandId, intentId } = seedReady(harness, mail);

    await dispatchReadyCommand(harness.deps, mail, commandId, intentId);

    expect(coord.inputs).toHaveLength(1);
    expect(coord.inputs[0]?.resumeSessionId).toBe(COORD_UUID);
  });

  it('a succeeded turn with a null sessionId persists NO coordinator session', async () => {
    const harness = setup();
    const coord = attachCoordinator(harness, [
      { kind: 'decided', decision: { kind: 'answer', text: 'ok.' }, sessionId: null },
    ]);
    const mail = commandMail({ messageId: '<coord-nullid@example.com>' });
    const { commandId, intentId } = seedReady(harness, mail);

    await dispatchReadyCommand(harness.deps, mail, commandId, intentId);

    expect(harness.intentStore.getById(intentId)?.status).toBe('RESOLVED');
    expect(coord.sessionStore.findByThreadKey('coord-nullid@example.com')).toBeUndefined();
  });
});

// Type-level pin: the ingest normalizer and the test's expected-intent-id
// derivation stay the same function family (a drift would break the
// branded-type assignment below, not just a runtime assert).
const _brandPin: NormalizedMessageId | null = normalizeMessageId('<cmd-1@example.com>');
void _brandPin;
