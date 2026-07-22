import { describe, expect, it } from 'vitest';

import { loadConfig, validateConfig } from '../../src/cli/config.js';
import type { LoadConfigIo } from '../../src/cli/config.js';
import { resolveDefaultDbPath, resolveDefaultWorktreesRoot } from '../../src/cli/paths.js';

// Guards decision D-P5S-2 (config schema v1 + loader). `homedir`/`env` are
// always fixed fake values, never the real process.env / os.homedir() —
// every function under test is pure or takes injected IO.
const HOME = '/fake-home';

/** A config object with every REQUIRED field present and valid, so each
 * test below can override only the field it is actually exercising. */
function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    selfAddress: 'bridge-user@example.com',
    credentialsEnvFile: '/fake-home/.secrets/amb-test.env',
    dbPath: '/fake-home/.local/share/agent-mail-bridge/bridge.db',
    worktreesRoot: '/fake-home/.local/share/agent-mail-bridge/worktrees',
    mailbox: 'INBOX',
    dryRun: false,
    ...overrides,
  };
}

describe('validateConfig (D-P5S-2)', () => {
  it('accepts a fully-specified valid config, including timeWindow', () => {
    const result = validateConfig(
      validRaw({
        timeWindow: {
          timezone: 'Asia/Shanghai',
          days: [1, 2, 3, 4, 5],
          start: '09:00',
          end: '18:00',
          excludeDates: ['2026-01-01'],
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      config: {
        version: 1,
        selfAddress: 'bridge-user@example.com',
        credentialsEnvFile: '/fake-home/.secrets/amb-test.env',
        dbPath: '/fake-home/.local/share/agent-mail-bridge/bridge.db',
        worktreesRoot: '/fake-home/.local/share/agent-mail-bridge/worktrees',
        projects: { roots: [] },
        baseRef: 'HEAD',
        pollIntervalSeconds: 30,
        mailbox: 'INBOX',
        dryRun: false,
        timeWindow: {
          timezone: 'Asia/Shanghai',
          days: [1, 2, 3, 4, 5],
          start: '09:00',
          end: '18:00',
          excludeDates: ['2026-01-01'],
        },
      },
    });
  });

  it('accepts a minimal config with no timeWindow (it is optional)', () => {
    const result = validateConfig(validRaw());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.timeWindow).toBeUndefined();
    }
  });

  it('defaults mailbox to "INBOX" when omitted', () => {
    const raw = validRaw();
    delete raw.mailbox;

    const result = validateConfig(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.mailbox).toBe('INBOX');
    }
  });

  it('defaults dryRun to false when omitted', () => {
    const raw = validRaw();
    delete raw.dryRun;

    const result = validateConfig(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.dryRun).toBe(false);
    }
  });

  // --- D-P5B12-1: daemon-facing additive fields (version stays 1) ---

  it('defaults projects to { roots: [] }, baseRef to "HEAD" and pollIntervalSeconds to 30 when omitted', () => {
    const result = validateConfig(validRaw());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.projects).toEqual({ roots: [] });
      expect(result.config.baseRef).toBe('HEAD');
      expect(result.config.pollIntervalSeconds).toBe(30);
    }
  });

  it('accepts a fully-specified projects value (roots + aliases) and passes it through', () => {
    const result = validateConfig(
      validRaw({
        projects: {
          roots: ['/fake-home/github'],
          aliases: { alpha: '/fake-home/github/proj-a' },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.projects).toEqual({
        roots: ['/fake-home/github'],
        aliases: { alpha: '/fake-home/github/proj-a' },
      });
    }
  });

  it('accepts projects with roots only (aliases optional, stays absent)', () => {
    const result = validateConfig(validRaw({ projects: { roots: ['/fake-home/github'] } }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.projects).toEqual({ roots: ['/fake-home/github'] });
      expect(result.config.projects.aliases).toBeUndefined();
    }
  });

  it('rejects a projects value that is not an object, naming the field path', () => {
    const result = validateConfig(validRaw({ projects: 'nope' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('projects:'))).toBe(true);
    }
  });

  it('rejects projects.roots missing or not an array, naming the field path', () => {
    for (const projects of [{}, { roots: 'not-an-array' }]) {
      const result = validateConfig(validRaw({ projects }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.startsWith('projects.roots:'))).toBe(true);
      }
    }
  });

  it('rejects a projects.roots element that is empty or not a string (shape only — existence checks are buildProjectIndex runtime concerns)', () => {
    for (const roots of [[''], ['/ok', 42]]) {
      const result = validateConfig(validRaw({ projects: { roots } }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.startsWith('projects.roots:'))).toBe(true);
      }
    }
  });

  it('rejects projects.aliases that is not an object, and an alias whose target is empty or not a string', () => {
    const cases: readonly unknown[] = [
      ['not', 'an', 'object'],
      { alpha: '' },
      { alpha: 42 },
    ];
    for (const aliases of cases) {
      const result = validateConfig(validRaw({ projects: { roots: ['/ok'], aliases } }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.startsWith('projects.aliases'))).toBe(true);
      }
    }
  });

  it('rejects an empty worktreesRoot and a relative worktreesRoot, naming the field path', () => {
    for (const worktreesRoot of ['', 'relative/worktrees']) {
      const result = validateConfig(validRaw({ worktreesRoot }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.startsWith('worktreesRoot:'))).toBe(true);
      }
    }
  });

  it('accepts a ~/-prefixed worktreesRoot at the shape-validation level', () => {
    const result = validateConfig(validRaw({ worktreesRoot: '~/wt' }));

    expect(result.ok).toBe(true);
  });

  it('rejects an empty or non-string baseRef, naming the field path', () => {
    for (const baseRef of ['', 42]) {
      const result = validateConfig(validRaw({ baseRef }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.startsWith('baseRef:'))).toBe(true);
      }
    }
  });

  it('accepts pollIntervalSeconds at the 5 and 3600 boundaries', () => {
    for (const pollIntervalSeconds of [5, 3600]) {
      const result = validateConfig(validRaw({ pollIntervalSeconds }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.pollIntervalSeconds).toBe(pollIntervalSeconds);
      }
    }
  });

  it('rejects pollIntervalSeconds outside 5..3600 or not an integer, naming the field path and value', () => {
    for (const pollIntervalSeconds of [4, 3601, 30.5, '30', true]) {
      const result = validateConfig(validRaw({ pollIntervalSeconds }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const error = result.errors.find((e) => e.startsWith('pollIntervalSeconds:'));
        expect(error).toBeDefined();
        expect(error).toContain(JSON.stringify(pollIntervalSeconds));
      }
    }
  });

  it('rejects a non-object root value', () => {
    const result = validateConfig('not an object');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a missing version field, naming the field path', () => {
    const raw = validRaw();
    delete raw.version;

    const result = validateConfig(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('version:'))).toBe(true);
    }
  });

  it('rejects a wrong version value, naming the field path', () => {
    const result = validateConfig(validRaw({ version: 2 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('version:') && e.includes('2'))).toBe(true);
    }
  });

  it('rejects an empty selfAddress, naming the field path', () => {
    const result = validateConfig(validRaw({ selfAddress: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('selfAddress:'))).toBe(true);
    }
  });

  it('rejects a selfAddress with no "@", naming the field path', () => {
    const result = validateConfig(validRaw({ selfAddress: 'not-an-email' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('selfAddress:'))).toBe(true);
    }
  });

  it('rejects a whitespace-only selfAddress as empty, naming the field path', () => {
    const result = validateConfig(validRaw({ selfAddress: '   ' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Classified as EMPTY (whitespace-only is no address at all), not as
      // a missing "@" — the friendlier of the two messages.
      expect(result.errors.some((e) => e === 'selfAddress: must be a non-empty string')).toBe(
        true,
      );
    }
  });

  it('rejects a selfAddress with surrounding whitespace instead of silently trimming it', () => {
    const result = validateConfig(validRaw({ selfAddress: '  @  ' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('selfAddress:'))).toBe(true);
    }
  });

  it('rejects an unknown top-level field instead of silently ignoring it (fail closed)', () => {
    const result = validateConfig(validRaw({ notAKnownField: 'oops' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('notAKnownField'))).toBe(true);
    }
  });

  describe('coordinator (ADR-0006 batch E-d)', () => {
    it('is optional — absent leaves config.coordinator undefined (deterministic default)', () => {
      const result = validateConfig(validRaw());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.coordinator).toBeUndefined();
      }
    });

    it('accepts { enabled: true } / { enabled: false } verbatim', () => {
      const on = validateConfig(validRaw({ coordinator: { enabled: true } }));
      const off = validateConfig(validRaw({ coordinator: { enabled: false } }));
      expect(on.ok).toBe(true);
      expect(off.ok).toBe(true);
      if (on.ok) expect(on.config.coordinator).toEqual({ enabled: true });
      if (off.ok) expect(off.config.coordinator).toEqual({ enabled: false });
    });

    it('rejects a non-boolean enabled, naming the field path', () => {
      const result = validateConfig(validRaw({ coordinator: { enabled: 'yes' } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.startsWith('coordinator.enabled:'))).toBe(true);
      }
    });

    it('rejects an unknown key like allowResume (strict opt-in — resume is a driver invariant, never a config toggle)', () => {
      const result = validateConfig(validRaw({ coordinator: { enabled: true, allowResume: true } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('coordinator.allowResume'))).toBe(true);
      }
    });

    it('rejects a non-object coordinator', () => {
      const result = validateConfig(validRaw({ coordinator: 'on' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.startsWith('coordinator:'))).toBe(true);
      }
    });
  });

  it('rejects an empty credentialsEnvFile, naming the field path', () => {
    const result = validateConfig(validRaw({ credentialsEnvFile: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('credentialsEnvFile:'))).toBe(true);
    }
  });

  it('rejects a relative credentialsEnvFile path, naming the field path', () => {
    const result = validateConfig(validRaw({ credentialsEnvFile: 'relative/amb.env' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('credentialsEnvFile:'))).toBe(true);
    }
  });

  it('accepts a ~/-prefixed credentialsEnvFile at the shape-validation level', () => {
    const result = validateConfig(validRaw({ credentialsEnvFile: '~/.secrets/amb-test.env' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Not expanded here — expansion is loadConfig's job (see below).
      expect(result.config.credentialsEnvFile).toBe('~/.secrets/amb-test.env');
    }
  });

  it('rejects an empty dbPath, naming the field path', () => {
    const result = validateConfig(validRaw({ dbPath: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('dbPath:'))).toBe(true);
    }
  });

  it('rejects a relative dbPath, naming the field path', () => {
    const result = validateConfig(validRaw({ dbPath: 'relative/bridge.db' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('dbPath:'))).toBe(true);
    }
  });

  it('rejects a malformed timeWindow (start not HH:MM), naming the nested field path', () => {
    const result = validateConfig(
      validRaw({
        timeWindow: {
          timezone: 'Asia/Shanghai',
          days: [1, 2, 3],
          start: '9:00',
          end: '18:00',
          excludeDates: [],
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('timeWindow.start:'))).toBe(true);
    }
  });

  it('rejects an out-of-range timeWindow.start hour ("25:00" passes the shape regex), naming the field path and the value', () => {
    const result = validateConfig(
      validRaw({
        timeWindow: {
          timezone: 'Asia/Shanghai',
          days: [1, 2, 3],
          start: '25:00',
          end: '18:00',
          excludeDates: [],
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith('timeWindow.start:') && e.includes('25:00')),
      ).toBe(true);
    }
  });

  it('rejects an out-of-range timeWindow.end minute ("12:60"), naming the field path and the value', () => {
    const result = validateConfig(
      validRaw({
        timeWindow: {
          timezone: 'Asia/Shanghai',
          days: [1, 2, 3],
          start: '09:00',
          end: '12:60',
          excludeDates: [],
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith('timeWindow.end:') && e.includes('12:60')),
      ).toBe(true);
    }
  });

  it('accepts the boundary clock values start "00:00" and end "23:59"', () => {
    const result = validateConfig(
      validRaw({
        timeWindow: {
          timezone: 'Asia/Shanghai',
          days: [1, 2, 3],
          start: '00:00',
          end: '23:59',
          excludeDates: [],
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a malformed timeWindow (days not an array), naming the nested field path', () => {
    const result = validateConfig(
      validRaw({
        timeWindow: {
          timezone: 'Asia/Shanghai',
          days: 'weekdays',
          start: '09:00',
          end: '18:00',
          excludeDates: [],
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('timeWindow.days:'))).toBe(true);
    }
  });

  it('rejects a malformed timeWindow (missing timezone), naming the nested field path', () => {
    const raw = validRaw();
    raw.timeWindow = { days: [1], start: '09:00', end: '18:00', excludeDates: [] };

    const result = validateConfig(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('timeWindow.timezone:'))).toBe(true);
    }
  });

  it('rejects a timeWindow that is not an object at all, naming the field path', () => {
    const result = validateConfig(validRaw({ timeWindow: 'always' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('timeWindow:'))).toBe(true);
    }
  });

  it('aggregates every error instead of stopping at the first', () => {
    const result = validateConfig(validRaw({ version: 2, selfAddress: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('version:'))).toBe(true);
      expect(result.errors.some((e) => e.startsWith('selfAddress:'))).toBe(true);
    }
  });
});

describe('loadConfig (D-P5S-2)', () => {
  const CONFIG_PATH = '/fake-home/.config/agent-mail-bridge/config.json';

  /** Fake `readFileSync` that throws like `node:fs` for a missing path, and
   * a fixed `homedir`/`env` — no real filesystem or environment touched. */
  function fakeIo(
    files: Record<string, string>,
    overrides: Partial<Pick<LoadConfigIo, 'homedir' | 'env'>> = {},
  ): LoadConfigIo {
    return {
      readFileSync: (path: string): string => {
        const content = files[path];
        if (content === undefined) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        return content;
      },
      homedir: overrides.homedir ?? HOME,
      env: overrides.env ?? {},
    };
  }

  it('returns ok:false (not a throw) when the file does not exist', () => {
    const io = fakeIo({});

    expect(() => loadConfig(CONFIG_PATH, io)).not.toThrow();
    const result = loadConfig(CONFIG_PATH, io);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('returns ok:false (not a throw) on a JSON syntax error', () => {
    const io = fakeIo({ [CONFIG_PATH]: '{ this is not valid json' });

    expect(() => loadConfig(CONFIG_PATH, io)).not.toThrow();
    const result = loadConfig(CONFIG_PATH, io);
    expect(result.ok).toBe(false);
  });

  it('surfaces schema errors from a parsed-but-invalid config without throwing', () => {
    const io = fakeIo({ [CONFIG_PATH]: JSON.stringify(validRaw({ selfAddress: '' })) });

    const result = loadConfig(CONFIG_PATH, io);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('selfAddress:'))).toBe(true);
    }
  });

  it('loads a fully valid config unchanged (paths already absolute)', () => {
    const io = fakeIo({ [CONFIG_PATH]: JSON.stringify(validRaw()) });

    const result = loadConfig(CONFIG_PATH, io);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.selfAddress).toBe('bridge-user@example.com');
      expect(result.config.dbPath).toBe('/fake-home/.local/share/agent-mail-bridge/bridge.db');
    }
  });

  it('resolves the default dbPath via XDG_DATA_HOME/homedir when the config omits dbPath', () => {
    const raw = validRaw();
    delete raw.dbPath;
    const env = { XDG_DATA_HOME: '/fake-xdg-data' };
    const io = fakeIo({ [CONFIG_PATH]: JSON.stringify(raw) }, { env });

    const result = loadConfig(CONFIG_PATH, io);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.dbPath).toBe(resolveDefaultDbPath(env, HOME));
    }
  });

  it('still rejects an explicit-but-invalid dbPath even though omitted values get a default', () => {
    const raw = validRaw({ dbPath: 'relative/not-allowed.db' });
    const io = fakeIo({ [CONFIG_PATH]: JSON.stringify(raw) });

    const result = loadConfig(CONFIG_PATH, io);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('dbPath:'))).toBe(true);
    }
  });

  it('expands ~/ in both credentialsEnvFile and dbPath using the injected homedir', () => {
    const raw = validRaw({
      credentialsEnvFile: '~/.secrets/amb-test.env',
      dbPath: '~/.local/share/agent-mail-bridge/bridge.db',
    });
    const io = fakeIo({ [CONFIG_PATH]: JSON.stringify(raw) }, { homedir: '/another-fake-home' });

    const result = loadConfig(CONFIG_PATH, io);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.credentialsEnvFile).toBe('/another-fake-home/.secrets/amb-test.env');
      expect(result.config.dbPath).toBe(
        '/another-fake-home/.local/share/agent-mail-bridge/bridge.db',
      );
    }
  });

  // --- D-P5B12-1: worktreesRoot default + tilde expansion for the new
  // path-carrying fields ---

  it('resolves the default worktreesRoot via XDG_DATA_HOME/homedir when the config omits it', () => {
    const raw = validRaw();
    delete raw.worktreesRoot;
    const env = { XDG_DATA_HOME: '/fake-xdg-data' };
    const io = fakeIo({ [CONFIG_PATH]: JSON.stringify(raw) }, { env });

    const result = loadConfig(CONFIG_PATH, io);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.worktreesRoot).toBe(resolveDefaultWorktreesRoot(env, HOME));
    }
  });

  it('still rejects an explicit-but-invalid worktreesRoot even though omitted values get a default', () => {
    const raw = validRaw({ worktreesRoot: 'relative/worktrees' });
    const io = fakeIo({ [CONFIG_PATH]: JSON.stringify(raw) });

    const result = loadConfig(CONFIG_PATH, io);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('worktreesRoot:'))).toBe(true);
    }
  });

  it('expands ~/ in worktreesRoot, projects.roots elements and projects.aliases targets', () => {
    const raw = validRaw({
      worktreesRoot: '~/wt',
      projects: {
        roots: ['~/github', '/already/absolute'],
        aliases: { alpha: '~/github/proj-a' },
      },
    });
    const io = fakeIo({ [CONFIG_PATH]: JSON.stringify(raw) }, { homedir: '/another-fake-home' });

    const result = loadConfig(CONFIG_PATH, io);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.worktreesRoot).toBe('/another-fake-home/wt');
      expect(result.config.projects).toEqual({
        roots: ['/another-fake-home/github', '/already/absolute'],
        aliases: { alpha: '/another-fake-home/github/proj-a' },
      });
    }
  });
});
