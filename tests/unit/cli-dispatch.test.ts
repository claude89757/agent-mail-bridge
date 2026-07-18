import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { DoctorIo } from '../../src/cli/doctor.js';
import { createSetupPlaceholder, dispatch } from '../../src/cli/dispatch.js';
import type { DispatchIo, Writer } from '../../src/cli/dispatch.js';

// Guards D-P5S-1 (subcommand dispatch is hand-rolled on the first
// user-facing argv token; node:util parseArgs is reserved for a
// subcommand's OWN flags -- Task 4's `setup` is its first consumer here,
// not this module) and D-P5S-5 (command surface: doctor/setup/status/
// pause/resume/logout + --help/--version, placeholders honestly exit 2).
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
 * execution fail loudly instead of silently reading a real file. */
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
    ...overrides,
  };
}

describe('dispatch — doctor/setup routing (D-P5S-1, D-P5S-5)', () => {
  it('routes "doctor" to the real doctor assembly: prints the rendered report and returns its exitCode', () => {
    const writer = makeWriter();
    const io = baseDispatchIo({ writer });

    const exitCode = dispatch(['doctor'], io);

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

  it('routes "setup" to the injected runSetup handler, passing through the remaining args', () => {
    const writer = makeWriter();
    let receivedArgs: readonly string[] | undefined;
    const io = baseDispatchIo({
      writer,
      runSetup: (args) => {
        receivedArgs = args;
        return 42;
      },
    });

    const exitCode = dispatch(['setup', '--self', 'bridge-user@example.com'], io);

    expect(receivedArgs).toEqual(['--self', 'bridge-user@example.com']);
    expect(exitCode).toBe(42);
  });

  it('setup with the real Task 3 placeholder handler: stderr message, exit 2 (Task 4 swaps the handler, not the route)', () => {
    const writer = makeWriter();
    const io = baseDispatchIo({ writer, runSetup: createSetupPlaceholder(writer) });

    const exitCode = dispatch(['setup'], io);

    expect(exitCode).toBe(2);
    expect(writer.errLines.join('\n')).toContain('amb setup');
    expect(writer.outLines).toHaveLength(0);
  });
});

describe('dispatch — --version', () => {
  it('prints the exact version from package.json to stdout and exits 0', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const writer = makeWriter();
    const io = baseDispatchIo({ writer, version: manifest.version });

    const exitCode = dispatch(['--version'], io);

    expect(writer.outLines).toEqual([manifest.version]);
    expect(writer.errLines).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});

describe('dispatch — --help / no-args (D-P5S-5 full command surface)', () => {
  const ALL_COMMANDS = ['doctor', 'setup', 'status', 'pause', 'resume', 'logout'];

  it('--help lists every command and both flags on stdout, exit 0', () => {
    const writer = makeWriter();

    const exitCode = dispatch(['--help'], baseDispatchIo({ writer }));

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
  it('no args behaves the same as --help: stdout, exit 0', () => {
    const helpWriter = makeWriter();
    dispatch(['--help'], baseDispatchIo({ writer: helpWriter }));

    const noArgsWriter = makeWriter();
    const exitCode = dispatch([], baseDispatchIo({ writer: noArgsWriter }));

    expect(noArgsWriter.outLines).toEqual(helpWriter.outLines);
    expect(noArgsWriter.errLines).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});

describe('dispatch — placeholder commands (status/pause/resume/logout)', () => {
  it.each(['status', 'pause', 'resume', 'logout'] as const)(
    '"%s" prints a stderr message and exits 2 (needs the real Phase 5 daemon)',
    (command) => {
      const writer = makeWriter();

      const exitCode = dispatch([command], baseDispatchIo({ writer }));

      expect(exitCode).toBe(2);
      expect(writer.errLines.length).toBeGreaterThan(0);
      expect(writer.errLines.join('\n')).toContain(command);
      expect(writer.outLines).toHaveLength(0);
    },
  );
});

describe('dispatch — unknown command', () => {
  it('prints help to stderr and exits 2', () => {
    const writer = makeWriter();

    const exitCode = dispatch(['frobnicate'], baseDispatchIo({ writer }));

    expect(exitCode).toBe(2);
    expect(writer.outLines).toHaveLength(0);
    const err = writer.errLines.join('\n');
    expect(err).toContain('frobnicate');
    expect(err).toContain('doctor');
    expect(err).toContain('setup');
  });
});
