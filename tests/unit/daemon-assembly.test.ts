import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BuildProjectIndexInput, RejectedDir } from '../../src/application/projectIndex.js';
import type { CreateWorktreeInput } from '../../src/application/worktreeManager.js';
import type { BridgeConfig } from '../../src/cli/config.js';
import { assembleDaemon, readCredentialsFile } from '../../src/daemon/assembly.js';
import type { AssemblyBuilders, BuildTransportInput } from '../../src/daemon/assembly.js';
import { openDatabase } from '../../src/store/database.js';
import { OutboxStore } from '../../src/store/outboxStore.js';
import type { IncomingMail } from '../../src/transports/types.js';
import { FakeAgentDriver } from '../helpers/fakeAgentDriver.js';
import { FakeMailTransport, FAKE_MAILBOX, FAKE_UID_VALIDITY } from '../helpers/fakeTransport.js';
import { withStdioSpy } from '../helpers/stdioSpy.js';

// Guards D-P5B12-4 (the composition root): builder-call topology, config
// field flow, credentials flowing into the transport builder AND NOWHERE
// ELSE, the production buildRegisterOutbox product being what the transport
// receives, empty-roots ⇒ empty index without ever calling buildIndex, and
// close releasing in reverse order (driver → transport → db). NO real
// connection is ever opened: every builder is a fake; the one "real" piece
// is an in-memory SQLite handle so store wiring is production-true.
//
// Fixture discipline (public repo): placeholder addresses, synthetic
// /tmp/fixtures/* paths, low-entropy token placeholders (AGENTS.md).

const HOME = '/tmp/fixtures/home-x';
const READY_AT = '2026-07-17T00:00:00.000Z';
const SENTINEL_USER = 'sentinel-user@example.com';
const SENTINEL_PASS = 'Aa-Aa-Tok-9999';

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    version: 1,
    selfAddress: 'bridge-user@example.com',
    credentialsEnvFile: '/tmp/fixtures/secrets/amb-test.env',
    dbPath: '/tmp/fixtures/data/bridge.db',
    projects: { roots: ['/tmp/fixtures/roots'] },
    worktreesRoot: '/tmp/fixtures/worktrees',
    baseRef: 'main',
    pollIntervalSeconds: 30,
    mailbox: 'INBOX',
    dryRun: false,
    ...overrides,
  };
}

interface Harness {
  builders: AssemblyBuilders;
  calls: {
    openDb: string[];
    readCredentials: string[];
    buildTransport: BuildTransportInput[];
    buildDriver: number;
    buildIndex: BuildProjectIndexInput[];
    createWorktree: CreateWorktreeInput[];
    directoryExists: string[];
  };
  closeOrder: string[];
  db: ReturnType<typeof openDatabase>;
  transport: FakeMailTransport;
  driver: FakeAgentDriver;
}

interface HarnessOptions {
  indexRejected?: readonly RejectedDir[];
  buildIndexImpl?: AssemblyBuilders['buildIndex'];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: Harness['calls'] = {
    openDb: [],
    readCredentials: [],
    buildTransport: [],
    buildDriver: 0,
    buildIndex: [],
    createWorktree: [],
    directoryExists: [],
  };
  const closeOrder: string[] = [];

  const db = openDatabase(':memory:');
  const realDbClose = db.close.bind(db);
  db.close = (() => {
    closeOrder.push('db');
    return realDbClose();
  }) as typeof db.close;

  const driver = new FakeAgentDriver([]);
  driver.close = () => {
    closeOrder.push('driver');
    return Promise.resolve();
  };

  let transport!: FakeMailTransport;
  let tick = 0;

  const builders: AssemblyBuilders = {
    openDb: (path) => {
      calls.openDb.push(path);
      return db;
    },
    buildTransport: (input) => {
      calls.buildTransport.push(input);
      transport = new FakeMailTransport({ registerOutbox: input.registerOutbox });
      transport.close = () => {
        closeOrder.push('transport');
        return Promise.resolve();
      };
      return transport;
    },
    buildDriver: () => {
      calls.buildDriver += 1;
      return driver;
    },
    buildIndex:
      options.buildIndexImpl ??
      (async (input) => {
        calls.buildIndex.push(input);
        return {
          index: { entries: [], lookup: () => [] },
          rejected: options.indexRejected ?? [],
        };
      }),
    createWorktree: async (input) => {
      calls.createWorktree.push(input);
      return { worktreePath: '/tmp/fixtures/worktrees/never-used', baseCommit: 'a'.repeat(40) };
    },
    directoryExists: async (path) => {
      calls.directoryExists.push(path);
      return true;
    },
    homedir: () => HOME,
    readCredentials: (envFilePath) => {
      calls.readCredentials.push(envFilePath);
      return { user: SENTINEL_USER, pass: SENTINEL_PASS };
    },
    clock: () => new Date(Date.UTC(2026, 6, 19, 0, 0, tick++)).toISOString(),
  };

  return {
    builders,
    calls,
    closeOrder,
    db,
    get transport() {
      return transport;
    },
    driver,
  };
}

function commandMail(overrides: Partial<IncomingMail> = {}): IncomingMail {
  return {
    messageId: '<asm-1@example.com>',
    headers: new Map([['subject', ['unknown-proj do something']]]),
    from: ['bridge-user@example.com'],
    to: ['bridge-user@example.com'],
    cc: [],
    bodyText: 'run the assembly smoke task',
    internalDate: '2026-07-18T12:00:00.000Z',
    uid: 1,
    uidValidity: FAKE_UID_VALIDITY,
    mailbox: FAKE_MAILBOX,
    ...overrides,
  };
}

describe('assembleDaemon (D-P5B12-4)', () => {
  it('wires config through the builders: creds read from credentialsEnvFile flow into the transport builder, NOWHERE else, and NEVER onto any stdio sink', async () => {
    const h = makeHarness();
    const config = baseConfig();

    // D-P5B13-3: the whole assembly runs under the five-sink stdio spy —
    // the batch-12 review named `assembleDaemon`'s own body (after the
    // credentials leave `readCredentials`) as a raw-write channel no lint
    // rule polices; this capture is its test floor.
    const { result: assembled, captured } = await withStdioSpy(() =>
      assembleDaemon(config, h.builders),
    );
    expect(captured).not.toContain(SENTINEL_USER);
    expect(captured).not.toContain(SENTINEL_PASS);

    expect(h.calls.readCredentials).toEqual([config.credentialsEnvFile]);
    expect(h.calls.openDb).toEqual([config.dbPath]);
    expect(h.calls.buildDriver).toBe(1);
    expect(h.calls.buildIndex).toEqual([config.projects]);
    expect(h.calls.buildTransport).toHaveLength(1);
    const transportInput = h.calls.buildTransport[0];
    expect(transportInput?.selfAddress).toBe(config.selfAddress);
    expect(transportInput?.credentials).toEqual({ user: SENTINEL_USER, pass: SENTINEL_PASS });
    expect(typeof transportInput?.registerOutbox).toBe('function');
    expect(assembled.homeDir).toBe(HOME);

    // RED LINE 2 assertion: outside the transport builder's credentials
    // field, the credential values appear in NO other builder input.
    const everythingElse = JSON.stringify({
      openDb: h.calls.openDb,
      readCredentialsArgs: h.calls.readCredentials,
      buildIndex: h.calls.buildIndex,
      createWorktree: h.calls.createWorktree,
      directoryExists: h.calls.directoryExists,
      transportInputMinusCreds: { selfAddress: transportInput?.selfAddress },
    });
    expect(everythingElse).not.toContain(SENTINEL_USER);
    expect(everythingElse).not.toContain(SENTINEL_PASS);

    await assembled.close();
  });

  it('hands the transport the PRODUCTION buildRegisterOutbox product over the assembled stores: invoking it lands a SENDING outbox row keyed by the normalized Message-ID', async () => {
    const h = makeHarness();
    const assembled = await assembleDaemon(baseConfig(), h.builders);

    const registerOutbox = h.calls.buildTransport[0]?.registerOutbox;
    if (registerOutbox === undefined) {
      throw new Error('test bug: transport builder was never called');
    }
    await registerOutbox(
      { outboxId: 'ob-wired', messageId: '<wired-1@example.com>' },
      { kind: 'RESULT', commandId: null, subjectRedacted: '[r]', bodyRedacted: '[r]' },
    );

    const row = new OutboxStore(h.db).findByMessageId('wired-1@example.com');
    expect(row?.id).toBe('ob-wired');
    expect(row?.status).toBe('SENDING');

    await assembled.close();
  });

  it('empty projects.roots ⇒ empty index WITHOUT calling buildIndex; an assembled mail tick routes a command to the no-match stopgap (full fake round-trip, zero real connections)', async () => {
    const h = makeHarness();
    const config = baseConfig({ projects: { roots: [] } });

    const assembled = await assembleDaemon(config, h.builders);
    expect(h.calls.buildIndex).toEqual([]);
    expect(assembled.indexRejected).toEqual([]);

    // Startup parity with the shell's normative order, against the real
    // in-memory stores the assembly opened.
    expect(assembled.ticks.recover()).toEqual({ recovered: [] });
    expect(assembled.ticks.sweepStranded()).toEqual({ swept: [] });

    assembled.metaStore.setReadyAtIfUnset(READY_AT);
    h.transport.deliver(commandMail());

    const report = await assembled.ticks.mailTick();

    expect(report.outcomes.ready).toBe(1);
    expect(report.dispatched).toBe(0);
    expect(h.transport.sentMails).toHaveLength(1);
    expect(h.transport.sentMails[0]?.kind).toBe('ERROR');
    expect(h.transport.sentMails[0]?.bodyRedacted).toContain('cannot route: no match');

    await assembled.close();
  });

  it('surfaces the index build report (rejected roots) for the shell to log', async () => {
    const rejected: readonly RejectedDir[] = [
      { path: '/tmp/fixtures/gone', reason: 'ROOT_NOT_FOUND' },
    ];
    const h = makeHarness({ indexRejected: rejected });

    const assembled = await assembleDaemon(baseConfig(), h.builders);

    expect(assembled.indexRejected).toEqual(rejected);
    await assembled.close();
  });

  it('close releases in REVERSE build order: driver → transport → db', async () => {
    const h = makeHarness();
    const assembled = await assembleDaemon(baseConfig(), h.builders);

    await assembled.close();

    expect(h.closeOrder).toEqual(['driver', 'transport', 'db']);
  });

  it('a builder failure after openDb closes the db instead of leaking the handle (fail closed)', async () => {
    const h = makeHarness({
      buildIndexImpl: () => Promise.reject(new Error('alias target is not a scanned project')),
    });

    await expect(assembleDaemon(baseConfig(), h.builders)).rejects.toThrow(
      'alias target is not a scanned project',
    );

    expect(h.closeOrder).toEqual(['db']);
  });
});

describe('readCredentialsFile (D-P5B12-4 production credentials reader)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amb-assembly-creds-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeEnv(content: string): string {
    const path = join(dir, 'amb-test.env');
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('reads the AMB_TEST_IMAP_* key family (the tests/live loadLiveCreds family), tolerating comments and blank lines, values verbatim after the first "="', () => {
    const path = writeEnv(
      [
        '# dedicated test mailbox (placeholder values)',
        '',
        'AMB_TEST_IMAP_USER=bridge-user@example.com',
        'AMB_TEST_IMAP_PASS=Aa=Aa=Tok-0001',
        '',
      ].join('\n'),
    );

    expect(readCredentialsFile(path)).toEqual({
      user: 'bridge-user@example.com',
      pass: 'Aa=Aa=Tok-0001',
    });
  });

  it('accepts the generic AMB_IMAP_* family and prefers it over the test family when both exist', () => {
    const path = writeEnv(
      [
        'AMB_IMAP_USER=generic-user@example.com',
        'AMB_IMAP_PASS=Aa-Aa-Tok-0002',
        'AMB_TEST_IMAP_USER=bridge-user@example.com',
        'AMB_TEST_IMAP_PASS=Aa-Aa-Tok-0001',
      ].join('\n'),
    );

    expect(readCredentialsFile(path)).toEqual({
      user: 'generic-user@example.com',
      pass: 'Aa-Aa-Tok-0002',
    });
  });

  it('throws (fail closed) on a missing or empty key, naming BOTH accepted key names and the path — never any credential value', () => {
    const path = writeEnv('AMB_TEST_IMAP_USER=bridge-user@example.com\n');

    let thrown: Error | null = null;
    try {
      readCredentialsFile(path);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain('AMB_IMAP_PASS');
    expect(thrown?.message).toContain('AMB_TEST_IMAP_PASS');
    expect(thrown?.message).toContain(path);
    expect(thrown?.message).not.toContain('bridge-user@example.com');
  });

  it('throws (fail closed) when the file itself is missing, naming the path', () => {
    const path = join(dir, 'no-such.env');

    expect(() => readCredentialsFile(path)).toThrow(path);
  });
});
