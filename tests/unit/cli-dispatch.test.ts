import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { DoctorIo } from '../../src/cli/doctor.js';
import { createSetupPlaceholder, dispatch } from '../../src/cli/dispatch.js';
import type { DispatchIo, Writer } from '../../src/cli/dispatch.js';

// Guards D-P5S-1 (subcommand dispatch is hand-rolled on the first
// user-facing argv token; node:util parseArgs is reserved for a
// subcommand's OWN flags) and D-P5S-5 as amended by D-P5B12-5 (command
// surface: doctor/setup/start/status/pause/resume + --help/--version;
// `logout` is the ONE remaining placeholder, held for the keychain open
// question). `dispatch` is async since batch 12 — `amb start` runs a
// long-lived daemon — so every scenario below awaits it.
//
// Per D-P5S-7 these tests call `dispatch` directly with injected io --
// never spawn a subprocess and never touch main.ts's real argv/process
// wiring (that stays an untested thin wrapper, smoke-verified separately).

function makeWriter(): Writer & { readonly outLines: string[]; readonly errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

function baseDoctorIo(overrides: Partial<DoctorIo> = {}): DoctorIo {
  return {
    nodeVersion: 'v22.0.0',
    stat: () => null,
    openDatabase: () => {
      throw new Error('unexpected openDatabase call in this test');
    },
    ...overrides,
  };
}

/** `readFileSync` always throws (no config on disk) by default -- every
 * scenario below except the dedicated doctor test is indifferent to config
 * content, and a throwing default makes any accidental real doctor
 * execution fail loudly instead of silently reading a real file. Every
 * daemon-command handler throws by default for the same reason: a test
 * that did not explicitly wire one must fail loudly if dispatch routes
 * there unexpectedly. */
function baseDispatchIo(overrides: Partial<DispatchIo> = {}): DispatchIo {
  return {
    writer: makeWriter(),
    version: '0.0.0-test',
    env: {},
    homedir: '/fake-home',
    readFileSync: () => {
      throw new Error('ENOENT: no such file (fake io, no config in this test)');
    },
    doctorIo: baseDoctorIo(),
    runSetup: () => {
      throw new Error('unexpected runSetup call in this test');
    },
    runStart: () => {
      throw new Error('unexpected runStart call in this test');
    },
    runStatus: () => {
      throw new Error('unexpected runStatus call in this test');
    },
    runPause: () => {
      throw new Error('unexpected runPause call in this test');
    },
    runResume: () => {
      throw new Error('unexpected runResume call in this test');
    },
    runInstall: () => {
      throw new Error('unexpected runInstall call in this test');
    },
    runUninstall: () => {
      throw new Error('unexpected runUninstall call in this test');
    },
    ...overrides,
  };
}

describe('dispatch — doctor/setup routing (D-P5S-1, D-P5S-5)', () => {
  it('routes "doctor" to the real doctor assembly: prints the rendered report and returns its exitCode', async () => {
    const writer = makeWriter();
    const io = baseDispatchIo({ writer });

    const exitCode = await dispatch(['doctor'], io);

    // config is unreachable (fake readFileSync always throws), so config/
    // credentials-file/database/ready-at all fail closed -> exitCode 1;
    // node-version still passes on the fake v22.0.0. This proves dispatch
    // wired resolveConfigPath -> loadConfig -> buildDefaultChecks ->
    // runDoctor -> renderDoctorReport end to end, without re-testing each
    // check's own logic (already covered by tests/unit/cli-doctor.test.ts).
    expect(exitCode).toBe(1);
    expect(writer.outLines).toHaveLength(1);
    expect(writer.outLines[0]).toContain('Node.js version');
    expect(writer.outLines[0]).toContain('Config file');
    expect(writer.outLines[0]).toContain('Credentials file permissions');
    expect(writer.outLines[0]).toContain('Database');
    expect(writer.outLines[0]).toContain('Ready-at fence');
    expect(writer.errLines).toHaveLength(0);
  });

  it('routes "setup" to the injected runSetup handler, passing through the remaining args', async () => {
    const writer = makeWriter();
    let receivedArgs: readonly string[] | undefined;
    const io = baseDispatchIo({
      writer,
      runSetup: (args) => {
        receivedArgs = args;
        return 42;
      },
    });

    const exitCode = await dispatch(['setup', '--self', 'bridge-user@example.com'], io);

    expect(receivedArgs).toEqual(['--self', 'bridge-user@example.com']);
    expect(exitCode).toBe(42);
  });

  it('setup with the historical placeholder handler: stderr message, exit 2 (the route is handler-agnostic)', async () => {
    const writer = makeWriter();
    const io = baseDispatchIo({ writer, runSetup: createSetupPlaceholder(writer) });

    const exitCode = await dispatch(['setup'], io);

    expect(exitCode).toBe(2);
    expect(writer.errLines.join('\n')).toContain('amb setup');
    expect(writer.outLines).toHaveLength(0);
  });
});

describe('dispatch — daemon command routing (D-P5B12-5)', () => {
  it('routes "start" to the injected runStart handler with the remaining args and awaits its (possibly async) exit code', async () => {
    const writer = makeWriter();
    let receivedArgs: readonly string[] | undefined;
    const io = baseDispatchIo({
      writer,
      runStart: (args) => {
        receivedArgs = args;
        return Promise.resolve(7);
      },
    });

    const exitCode = await dispatch(['start', '--dry-run'], io);

    expect(receivedArgs).toEqual(['--dry-run']);
    expect(exitCode).toBe(7);
  });

  it.each([
    ['status', 'runStatus'],
    ['pause', 'runPause'],
    ['resume', 'runResume'],
  ] as const)(
    'routes "%s" to the injected %s handler and returns its exit code',
    async (command, handler) => {
      const writer = makeWriter();
      let called = 0;
      const io = baseDispatchIo({
        writer,
        [handler]: () => {
          called += 1;
          return 0;
        },
      });

      const exitCode = await dispatch([command], io);

      expect(called).toBe(1);
      expect(exitCode).toBe(0);
    },
  );

  // D-P5B13-5: the two service-file commands route like setup — the rest of
  // the argv is passed through so the handler owns its own flag parsing
  // (--force lives in service.ts, not here).
  it.each([
    ['install', 'runInstall'],
    ['uninstall', 'runUninstall'],
  ] as const)(
    'routes "%s" to the injected %s handler, passing through the remaining args',
    async (command, handler) => {
      const writer = makeWriter();
      let receivedArgs: readonly string[] | undefined;
      const io = baseDispatchIo({
        writer,
        [handler]: (args: readonly string[]) => {
          receivedArgs = args;
          return 11;
        },
      });

      const exitCode = await dispatch([command, '--force'], io);

      expect(receivedArgs).toEqual(['--force']);
      expect(exitCode).toBe(11);
    },
  );
});

describe('dispatch — --version', () => {
  it('prints the exact version from package.json to stdout and exits 0', async () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const writer = makeWriter();
    const io = baseDispatchIo({ writer, version: manifest.version });

    const exitCode = await dispatch(['--version'], io);

    expect(writer.outLines).toEqual([manifest.version]);
    expect(writer.errLines).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});

describe('dispatch — --help / no-args (D-P5S-5 full command surface)', () => {
  const ALL_COMMANDS = [
    'doctor',
    'setup',
    'start',
    'status',
    'pause',
    'resume',
    'install',
    'uninstall',
    'logout',
  ];

  it('--help lists every command and both flags on stdout, exit 0', async () => {
    const writer = makeWriter();

    const exitCode = await dispatch(['--help'], baseDispatchIo({ writer }));

    const help = writer.outLines.join('\n');
    for (const command of ALL_COMMANDS) {
      expect(help).toContain(command);
    }
    expect(help).toContain('--help');
    expect(help).toContain('--version');
    expect(exitCode).toBe(0);
    expect(writer.errLines).toHaveLength(0);
  });

  // The plan (D-P5S-5/D-P5S-7) is explicit that an UNKNOWN command prints
  // help to stderr + exit 2, but is silent on bare no-args. We pick the
  // friendlier, common CLI convention here: no-args behaves exactly like
  // `--help` (stdout, exit 0) rather than being treated as an error -- see
  // the matching comment in dispatch.ts.
  it('no args behaves the same as --help: stdout, exit 0', async () => {
    const helpWriter = makeWriter();
    await dispatch(['--help'], baseDispatchIo({ writer: helpWriter }));

    const noArgsWriter = makeWriter();
    const exitCode = await dispatch([], baseDispatchIo({ writer: noArgsWriter }));

    expect(noArgsWriter.outLines).toEqual(helpWriter.outLines);
    expect(noArgsWriter.errLines).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});

describe('dispatch — the one remaining placeholder command (D-P5B12-5)', () => {
  it('"logout" prints a stderr message and exits 2 (held for the keychain open question)', async () => {
    const writer = makeWriter();

    const exitCode = await dispatch(['logout'], baseDispatchIo({ writer }));

    expect(exitCode).toBe(2);
    expect(writer.errLines.length).toBeGreaterThan(0);
    expect(writer.errLines.join('\n')).toContain('logout');
    expect(writer.outLines).toHaveLength(0);
  });

  it.each(['start', 'status', 'pause', 'resume'] as const)(
    '"%s" is NOT a placeholder anymore: it routes to its real handler without touching stderr',
    async (command) => {
      const writer = makeWriter();
      const io = baseDispatchIo({
        writer,
        runStart: () => 0,
        runStatus: () => 0,
        runPause: () => 0,
        runResume: () => 0,
      });

      const exitCode = await dispatch([command], io);

      expect(exitCode).toBe(0);
      expect(writer.errLines).toHaveLength(0);
    },
  );
});

describe('dispatch — unknown command', () => {
  it('prints help to stderr and exits 2', async () => {
    const writer = makeWriter();

    const exitCode = await dispatch(['frobnicate'], baseDispatchIo({ writer }));

    expect(exitCode).toBe(2);
    expect(writer.outLines).toHaveLength(0);
    const err = writer.errLines.join('\n');
    expect(err).toContain('frobnicate');
    expect(err).toContain('doctor');
    expect(err).toContain('setup');
  });
});
