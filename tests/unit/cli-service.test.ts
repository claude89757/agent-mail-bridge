import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  renderLaunchdPlist,
  renderSystemdUnit,
  runInstall,
  runUninstall,
  SERVICE_LABEL,
  SYSTEMD_UNIT_NAME,
} from '../../src/cli/service.js';
import type { ServiceIo } from '../../src/cli/service.js';

// Guards D-P5B13-5 (`amb install` / `amb uninstall`): the pure renderers'
// pinned content, platform dispatch, refuse-overwrite/--force, the
// print-only activation discipline (amb NEVER runs launchctl/systemctl —
// enforced structurally: ServiceIo has fs members only, and a source-text
// assertion pins the import surface), uninstall's ①deactivate ②delete
// ③manual-cleanup order, and the red-line-2 display discipline: every
// PRINTED path is `~/`-shaped, the fake homedir never appears in output.
// The homedir is always a fake — no test touches ~/Library/LaunchAgents or
// ~/.config/systemd for real (zero real service-manager contact).

const HOME = '/fake-home';
const NODE = '/fake-node/bin/node';
const ENTRY = '/fake-home/lib/amb/dist/cli/main.js';
const PLIST_REAL_PATH = '/fake-home/Library/LaunchAgents/com.agent-mail-bridge.daemon.plist';
const UNIT_REAL_PATH = '/fake-home/.config/systemd/user/agent-mail-bridge.service';

interface HarnessOverrides extends Partial<ServiceIo> {
  existingPaths?: readonly string[];
}

function makeIo(overrides: HarnessOverrides = {}): {
  io: ServiceIo;
  written: { path: string; content: string }[];
  mkdirs: string[];
  unlinked: string[];
} {
  const written: { path: string; content: string }[] = [];
  const mkdirs: string[] = [];
  const unlinked: string[] = [];
  const { existingPaths = [], ...ioOverrides } = overrides;
  const io: ServiceIo = {
    platform: 'darwin',
    nodePath: NODE,
    entryPath: ENTRY,
    env: {},
    homedir: HOME,
    exists: (path) => existingPaths.includes(path),
    mkdir: (path) => {
      mkdirs.push(path);
    },
    writeFile: (path, content) => {
      written.push({ path, content });
    },
    unlink: (path) => {
      unlinked.push(path);
    },
    ...ioOverrides,
  };
  return { io, written, mkdirs, unlinked };
}

describe('renderLaunchdPlist (D-P5B13-5)', () => {
  const plist = renderLaunchdPlist({
    nodePath: NODE,
    entryPath: ENTRY,
    logDir: '/fake-home/.local/state/agent-mail-bridge/logs',
  });

  it('pins Label, ProgramArguments order [node, entry, start], RunAtLoad and KeepAlive', () => {
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    const nodeAt = plist.indexOf(`<string>${NODE}</string>`);
    const entryAt = plist.indexOf(`<string>${ENTRY}</string>`);
    const startAt = plist.indexOf('<string>start</string>');
    expect(nodeAt).toBeGreaterThan(-1);
    expect(entryAt).toBeGreaterThan(nodeAt);
    expect(startAt).toBeGreaterThan(entryAt);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it('points StandardOut/ErrorPath at launchd.{out,err}.log under the log directory', () => {
    expect(plist).toMatch(
      /<key>StandardOutPath<\/key>\s*<string>\/fake-home\/\.local\/state\/agent-mail-bridge\/logs\/launchd\.out\.log<\/string>/,
    );
    expect(plist).toMatch(
      /<key>StandardErrorPath<\/key>\s*<string>\/fake-home\/\.local\/state\/agent-mail-bridge\/logs\/launchd\.err\.log<\/string>/,
    );
  });

  it('XML-escapes inserted values (an ampersand in a path cannot corrupt the plist)', () => {
    const escaped = renderLaunchdPlist({
      nodePath: NODE,
      entryPath: '/fake-home/A&B/main.js',
      logDir: '/fake-home/logs',
    });
    expect(escaped).toContain('<string>/fake-home/A&amp;B/main.js</string>');
    expect(escaped).not.toContain('<string>/fake-home/A&B/main.js</string>');
  });
});

describe('renderSystemdUnit (D-P5B13-5)', () => {
  const unit = renderSystemdUnit({ nodePath: NODE, entryPath: ENTRY });

  it('pins ExecStart (quoted paths + the start subcommand), Restart=on-failure and WantedBy=default.target', () => {
    expect(unit).toContain(`ExecStart="${NODE}" "${ENTRY}" start`);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    for (const section of ['[Unit]', '[Service]', '[Install]']) {
      expect(unit).toContain(section);
    }
  });
});

describe('runInstall (D-P5B13-5)', () => {
  it('darwin: writes the rendered plist under the fake LaunchAgents dir, prepares parent + log dirs, prints the launchctl activation command in ~/ form ONLY (never the expanded home)', () => {
    const h = makeIo();

    const result = runInstall([], h.io);

    expect(result.exitCode).toBe(0);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.path).toBe(PLIST_REAL_PATH);
    expect(h.written[0]?.content).toBe(
      renderLaunchdPlist({
        nodePath: NODE,
        entryPath: ENTRY,
        logDir: '/fake-home/.local/state/agent-mail-bridge/logs',
      }),
    );
    expect(h.mkdirs).toContain('/fake-home/Library/LaunchAgents');
    // launchd opens Standard*Path at job spawn — the directory must exist
    // BEFORE the first activation, so install prepares it.
    expect(h.mkdirs).toContain('/fake-home/.local/state/agent-mail-bridge/logs');

    const joined = result.messages.join('\n');
    expect(joined).toContain(
      `launchctl load -w ~/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
    );
    expect(joined).toContain(`~/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
    expect(joined).not.toContain(HOME);
  });

  it('linux: writes the rendered unit under the fake systemd user dir and prints the daemon-reload + enable --now activation command', () => {
    const h = makeIo({ platform: 'linux' });

    const result = runInstall([], h.io);

    expect(result.exitCode).toBe(0);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.path).toBe(UNIT_REAL_PATH);
    expect(h.written[0]?.content).toBe(renderSystemdUnit({ nodePath: NODE, entryPath: ENTRY }));

    const joined = result.messages.join('\n');
    expect(joined).toContain(
      `systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
    );
    expect(joined).not.toContain(HOME);
  });

  it('refuses to overwrite an existing service file without --force: exit 1, nothing written, hint printed', () => {
    const h = makeIo({ existingPaths: [PLIST_REAL_PATH] });

    const result = runInstall([], h.io);

    expect(result.exitCode).toBe(1);
    expect(h.written).toHaveLength(0);
    const joined = result.messages.join('\n');
    expect(joined).toContain('--force');
    expect(joined).not.toContain(HOME);
  });

  it('--force overwrites the existing service file: exit 0, file written', () => {
    const h = makeIo({ existingPaths: [PLIST_REAL_PATH] });

    const result = runInstall(['--force'], h.io);

    expect(result.exitCode).toBe(0);
    expect(h.written).toHaveLength(1);
  });

  it('an unsupported platform fails closed with exit 1 and writes nothing', () => {
    const h = makeIo({ platform: 'win32' });

    const result = runInstall([], h.io);

    expect(result.exitCode).toBe(1);
    expect(h.written).toHaveLength(0);
    expect(result.messages.join('\n')).toContain('unsupported');
  });

  it('an empty entryPath fails closed with exit 1 (a unit pointing at nothing would loop-crash under KeepAlive)', () => {
    const h = makeIo({ entryPath: '' });

    const result = runInstall([], h.io);

    expect(result.exitCode).toBe(1);
    expect(h.written).toHaveLength(0);
  });

  it('an unknown flag is a usage error: exit 2 (D-P5B13-2), nothing written', () => {
    const h = makeIo();

    const result = runInstall(['--frobnicate'], h.io);

    expect(result.exitCode).toBe(2);
    expect(h.written).toHaveLength(0);
    expect(result.messages.join('\n')).toContain('usage');
  });

  it('a write failure surfaces as exit 1 with the error message TILDE-scrubbed (the raw fs error carries the expanded home path)', () => {
    const h = makeIo({
      writeFile: () => {
        throw new Error(`EACCES: permission denied, open '${PLIST_REAL_PATH}'`);
      },
    });

    const result = runInstall([], h.io);

    expect(result.exitCode).toBe(1);
    const joined = result.messages.join('\n');
    expect(joined).toContain('EACCES');
    expect(joined).not.toContain(HOME);
  });
});

describe('runUninstall (D-P5B13-5)', () => {
  it('darwin, service file present: prints the deactivation command FIRST, removes the file (the ONLY deletion), then lists remaining artifacts in cleanup order — all paths ~/-shaped', () => {
    const h = makeIo({ existingPaths: [PLIST_REAL_PATH] });

    const result = runUninstall([], h.io);

    expect(result.exitCode).toBe(0);
    expect(h.unlinked).toEqual([PLIST_REAL_PATH]);

    const joined = result.messages.join('\n');
    const deactivateAt = joined.indexOf(
      `launchctl unload -w ~/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
    );
    const removedAt = joined.indexOf('removed');
    expect(deactivateAt).toBeGreaterThan(-1);
    expect(removedAt).toBeGreaterThan(deactivateAt);

    // The manual-cleanup list, in order: config → db → worktrees → logs →
    // credentials (never deleted by amb).
    const configAt = joined.indexOf('~/.config/agent-mail-bridge/config.json');
    const dbAt = joined.indexOf('~/.local/share/agent-mail-bridge/bridge.db');
    const worktreesAt = joined.indexOf('~/.local/share/agent-mail-bridge/worktrees');
    const logsAt = joined.indexOf('~/.local/state/agent-mail-bridge/logs');
    const credentialsAt = joined.toLowerCase().indexOf('credentials');
    expect(configAt).toBeGreaterThan(removedAt);
    expect(dbAt).toBeGreaterThan(configAt);
    expect(worktreesAt).toBeGreaterThan(dbAt);
    expect(logsAt).toBeGreaterThan(worktreesAt);
    expect(credentialsAt).toBeGreaterThan(logsAt);

    expect(joined).not.toContain(HOME);
  });

  it('service file absent: says so honestly, still prints the deactivation command and the cleanup list, exit 0, nothing unlinked', () => {
    const h = makeIo();

    const result = runUninstall([], h.io);

    expect(result.exitCode).toBe(0);
    expect(h.unlinked).toEqual([]);
    const joined = result.messages.join('\n');
    expect(joined).toContain('no service file');
    expect(joined).toContain('launchctl unload');
    expect(joined).toContain('~/.local/share/agent-mail-bridge/bridge.db');
    expect(joined).not.toContain(HOME);
  });

  it('linux: prints the systemctl disable --now deactivation command and unlinks the unit path', () => {
    const h = makeIo({ platform: 'linux', existingPaths: [UNIT_REAL_PATH] });

    const result = runUninstall([], h.io);

    expect(result.exitCode).toBe(0);
    expect(h.unlinked).toEqual([UNIT_REAL_PATH]);
    const joined = result.messages.join('\n');
    expect(joined).toContain(`systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`);
    expect(joined).not.toContain(HOME);
  });

  it('a custom XDG_DATA_HOME outside the home dir prints as-is in the cleanup list (still never the fake homedir)', () => {
    const h = makeIo({ env: { XDG_DATA_HOME: '/mnt/xdg-data' } });

    const result = runUninstall([], h.io);

    const joined = result.messages.join('\n');
    expect(joined).toContain('/mnt/xdg-data/agent-mail-bridge/bridge.db');
    expect(joined).not.toContain(HOME);
  });

  it('an unsupported platform fails closed with exit 1', () => {
    const h = makeIo({ platform: 'win32' });

    const result = runUninstall([], h.io);

    expect(result.exitCode).toBe(1);
    expect(h.unlinked).toEqual([]);
  });

  it('any argument is a usage error: exit 2, nothing unlinked', () => {
    const h = makeIo({ existingPaths: [PLIST_REAL_PATH] });

    const result = runUninstall(['--force'], h.io);

    expect(result.exitCode).toBe(2);
    expect(h.unlinked).toEqual([]);
  });
});

describe('service.ts activation-is-print-only discipline (red line 4 posture)', () => {
  it('the module source never touches a process-spawning import: launchctl/systemctl exist ONLY as printed text', () => {
    const source = readFileSync(new URL('../../src/cli/service.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('execSync');
    expect(source).not.toContain('spawnSync');
    expect(source).not.toContain('spawn(');
  });
});
