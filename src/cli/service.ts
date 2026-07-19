/**
 * `amb install` / `amb uninstall` (decision D-P5B13-5): the service-file
 * commands. `install` renders and writes the per-user supervisor unit —
 * launchd LaunchAgent plist on darwin, systemd user unit on linux — and
 * PRINTS the activation command; `uninstall` prints the deactivation
 * command, removes the service file (the ONLY deletion amb ever performs),
 * and lists every remaining artifact for MANUAL cleanup.
 *
 * RED LINE 4 posture: activation and deactivation are ALWAYS the
 * operator's move. This module renders strings and writes/removes exactly
 * one file; it has no process-spawning import of any kind (a source-text
 * test pins that), and `launchctl`/`systemctl` appear exclusively inside
 * printed text. `ServiceIo` is fs-shaped only, so the structure cannot
 * execute anything even by accident.
 *
 * RED LINE 2 display discipline: every path this module PRINTS is
 * `~/`-shaped (`toDisplayPath` — the expanded home dir never reaches
 * stdout/stderr, and fs error messages are tilde-scrubbed too). The
 * expanded paths exist only for the actual fs calls and inside the written
 * unit file itself, which necessarily carries real absolute paths for the
 * service manager to execute.
 *
 * v0.1 escaping assumptions: plist values are XML-escaped (`escapeXml`), so
 * any byte-legal path is safe there. The systemd `ExecStart` quotes both
 * paths (protecting spaces); systemd's own `%` specifier and `$` variable
 * expansion inside quoted arguments are NOT escaped — v0.1 documents the
 * assumption that node/entry paths contain neither (typical installs),
 * rather than hand-rolling the full systemd quoting grammar.
 *
 * Result-value discipline: `{ exitCode, messages }`, never throwing, never
 * printing (`runSetup`/`statusCmd` precedent) — `main.ts` owns the printing
 * and binds the real io (`platform`/`nodePath`/`entryPath` are read from
 * `process.*` there, at the single real-globals boundary). Exit codes per
 * D-P5B13-2: 0 success, 1 runtime failure, 2 usage error.
 */
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import type { EnvLike } from './paths.js';
import {
  resolveConfigPath,
  resolveDefaultDbPath,
  resolveDefaultLogDir,
  resolveDefaultWorktreesRoot,
} from './paths.js';

/** launchd job label; the plist file is `<label>.plist` under
 *  `~/Library/LaunchAgents`. */
export const SERVICE_LABEL = 'com.agent-mail-bridge.daemon';
/** systemd user unit basename; the file is `<name>.service` under
 *  `~/.config/systemd/user`. */
export const SYSTEMD_UNIT_NAME = 'agent-mail-bridge';

export interface ServiceIo {
  /** Injected `process.platform` — only `'darwin'`/`'linux'` are supported;
   *  anything else fails closed. */
  readonly platform: string;
  /** Injected `process.execPath` (the running node binary). */
  readonly nodePath: string;
  /** Injected `process.argv[1]` (the amb entry script); empty ⇒ fail
   *  closed rather than write a unit that supervises nothing. */
  readonly entryPath: string;
  readonly env: EnvLike;
  readonly homedir: string;
  readonly exists: (path: string) => boolean;
  /** `fs.mkdirSync(path, { recursive: true })`-like. */
  readonly mkdir: (path: string) => void;
  /** `fs.writeFileSync(path, content, 'utf8')`-like. */
  readonly writeFile: (path: string, content: string) => void;
  readonly unlink: (path: string) => void;
}

/** Same shape as `SetupResult`/`StatusCommandResult` plus the usage code:
 *  exit 0 ⇒ stdout, non-zero ⇒ stderr (`main.ts` owns the printing). */
export interface ServiceCommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly messages: readonly string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Minimal XML escaping for plist `<string>` payloads. */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** The display form of a path (red line 2): `~/...` whenever it lives under
 *  the home dir; a non-home path (e.g. a custom XDG base) passes through —
 *  it carries no home-dir information to scrub. */
function toDisplayPath(path: string, homedir: string): string {
  return path.startsWith(`${homedir}/`) ? `~${path.slice(homedir.length)}` : path;
}

/**
 * The LaunchAgent plist: `ProgramArguments [node, entry, start]`,
 * `RunAtLoad` + `KeepAlive` (launchd owns the restart policy the shell's
 * fatal exit defers to), stdio captured under the amb log directory.
 */
export function renderLaunchdPlist(args: {
  nodePath: string;
  entryPath: string;
  logDir: string;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(args.nodePath)}</string>`,
    `    <string>${escapeXml(args.entryPath)}</string>`,
    '    <string>start</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(join(args.logDir, 'launchd.out.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(join(args.logDir, 'launchd.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * The systemd user unit: `ExecStart` with quoted paths, `Restart=on-failure`
 * (mirrors the shell's fatal-exit contract: restart policy belongs to the
 * supervisor), `WantedBy=default.target` (the user-session default). stdio
 * goes to the user journal — no Standard*Path twin needed here.
 */
export function renderSystemdUnit(args: { nodePath: string; entryPath: string }): string {
  return [
    '[Unit]',
    'Description=Agent Mail Bridge daemon',
    '',
    '[Service]',
    `ExecStart="${args.nodePath}" "${args.entryPath}" start`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Everything platform-specific the two commands need, resolved in one
 *  place. `realPath` is for fs calls ONLY; every printed path is the
 *  display twin. */
interface ServiceTarget {
  realPath: string;
  displayPath: string;
  content: string;
  activation: string;
  deactivation: string;
}

function resolveTarget(platform: 'darwin' | 'linux', io: ServiceIo): ServiceTarget {
  if (platform === 'darwin') {
    const realPath = join(io.homedir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    return {
      realPath,
      displayPath: toDisplayPath(realPath, io.homedir),
      content: renderLaunchdPlist({
        nodePath: io.nodePath,
        entryPath: io.entryPath,
        logDir: resolveDefaultLogDir(io.env, io.homedir),
      }),
      activation: `launchctl load -w ~/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
      deactivation: `launchctl unload -w ~/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
    };
  }
  const realPath = join(io.homedir, '.config', 'systemd', 'user', `${SYSTEMD_UNIT_NAME}.service`);
  return {
    realPath,
    displayPath: toDisplayPath(realPath, io.homedir),
    content: renderSystemdUnit({ nodePath: io.nodePath, entryPath: io.entryPath }),
    activation: `systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
    deactivation: `systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`,
  };
}

type PlatformOutcome =
  | { readonly ok: true; readonly platform: 'darwin' | 'linux' }
  | { readonly ok: false; readonly result: ServiceCommandResult };

function checkPlatform(command: string, io: ServiceIo): PlatformOutcome {
  if (io.platform !== 'darwin' && io.platform !== 'linux') {
    return {
      ok: false,
      result: {
        exitCode: 1,
        messages: [
          `amb ${command}: unsupported platform '${io.platform}' — v0.1 ships launchd (macOS) ` +
            'and systemd user units (Linux) only',
        ],
      },
    };
  }
  return { ok: true, platform: io.platform };
}

// ---------------------------------------------------------------------------
// amb install
// ---------------------------------------------------------------------------

const INSTALL_USAGE = 'usage: amb install [--force]';

export function runInstall(args: readonly string[], io: ServiceIo): ServiceCommandResult {
  let force: boolean;
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { force: { type: 'boolean', default: false } },
      allowPositionals: false,
      strict: true,
    });
    force = values.force;
  } catch (error) {
    // D-P5B13-2: usage errors exit 2.
    return {
      exitCode: 2,
      messages: [`amb install: invalid arguments: ${describeError(error)} (${INSTALL_USAGE})`],
    };
  }

  const platform = checkPlatform('install', io);
  if (!platform.ok) {
    return platform.result;
  }
  if (io.entryPath === '') {
    return {
      exitCode: 1,
      messages: [
        'amb install: cannot determine the amb entry script path — refusing to write a ' +
          'service file that would supervise nothing (fail closed)',
      ],
    };
  }

  const target = resolveTarget(platform.platform, io);
  if (io.exists(target.realPath) && !force) {
    return {
      exitCode: 1,
      messages: [
        `amb install: service file already exists at ${target.displayPath} ` +
          '(use --force to overwrite it)',
      ],
    };
  }

  const tildeify = (text: string): string => text.split(io.homedir).join('~');
  try {
    io.mkdir(dirname(target.realPath));
    // The daemon's own sink also mkdir -p's this, but launchd opens
    // Standard*Path at job spawn — BEFORE amb runs — so the directory must
    // exist by activation time (harmless on linux; the sink uses it too).
    io.mkdir(resolveDefaultLogDir(io.env, io.homedir));
    io.writeFile(target.realPath, target.content);
  } catch (error) {
    return {
      exitCode: 1,
      messages: [
        `amb install: failed to write the service file at ${target.displayPath}: ` +
          tildeify(describeError(error)),
      ],
    };
  }

  return {
    exitCode: 0,
    messages: [
      `service file written to ${target.displayPath}`,
      'amb never runs the service manager itself — activate the service yourself with:',
      `  ${target.activation}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// amb uninstall
// ---------------------------------------------------------------------------

const UNINSTALL_USAGE = 'usage: amb uninstall';

export function runUninstall(args: readonly string[], io: ServiceIo): ServiceCommandResult {
  try {
    parseArgs({ args: [...args], options: {}, allowPositionals: false, strict: true });
  } catch (error) {
    return {
      exitCode: 2,
      messages: [`amb uninstall: invalid arguments: ${describeError(error)} (${UNINSTALL_USAGE})`],
    };
  }

  const platform = checkPlatform('uninstall', io);
  if (!platform.ok) {
    return platform.result;
  }

  const target = resolveTarget(platform.platform, io);
  const display = (path: string): string => toDisplayPath(path, io.homedir);
  const messages: string[] = [
    // ① Deactivation comes FIRST: removing the file from under a still-
    // loaded job leaves the service manager confused about what it runs.
    'step 1 — deactivate the service yourself (amb never runs the service manager):',
    `  ${target.deactivation}`,
  ];

  // ② The service file — the ONLY thing amb ever deletes.
  if (io.exists(target.realPath)) {
    try {
      io.unlink(target.realPath);
      messages.push(`step 2 — service file removed: ${target.displayPath}`);
    } catch (error) {
      const tildeify = (text: string): string => text.split(io.homedir).join('~');
      return {
        exitCode: 1,
        messages: [
          ...messages,
          `amb uninstall: failed to remove ${target.displayPath}: ` +
            tildeify(describeError(error)),
        ],
      };
    }
  } else {
    messages.push(`step 2 — no service file at ${target.displayPath} (nothing to remove)`);
  }

  // ③ Everything else stays the operator's data; amb only lists it.
  messages.push(
    'step 3 — remaining artifacts are yours to remove manually, in this order:',
    `  1. config:      ${display(resolveConfigPath(io.env, io.homedir))}`,
    `  2. database:    ${display(resolveDefaultDbPath(io.env, io.homedir))} (default location — check config.json first if you customized dbPath)`,
    `  3. worktrees:   ${display(resolveDefaultWorktreesRoot(io.env, io.homedir))} (same note for a customized worktreesRoot)`,
    `  4. logs:        ${display(resolveDefaultLogDir(io.env, io.homedir))}`,
    '  5. credentials: the env file you provided to `amb setup` (its path is recorded in config.json — amb never deletes it)',
  );

  return { exitCode: 0, messages };
}
