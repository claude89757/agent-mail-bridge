#!/usr/bin/env node
/**
 * CLI entry point (`agent-mail-bridge` / `amb`, decision D10). Thin
 * assembly ONLY (D-P5S-5): read the real `process.argv`/`process.env`/
 * `os.homedir()`/`fs`/`package.json`, wire them into a `DispatchIo`, call
 * `dispatch` once, and translate its returned exit code into
 * `process.exitCode`. All actual command behavior lives in
 * `src/cli/dispatch.ts`, which is what `tests/unit/cli-dispatch.test.ts`
 * exercises directly (D-P5S-7) -- this file's own argv/process wiring is
 * deliberately NOT unit tested; it is smoke-verified by actually running
 * `node dist/cli/main.js --help` / `doctor` after a build.
 *
 * `process.exitCode` (not `process.exit()`) so any buffered stdout/stderr
 * writes flush before the process exits.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { buildDefaultDoctorIo } from './doctor.js';
import { dispatch } from './dispatch.js';
import type { DispatchIo, Writer } from './dispatch.js';
import { runInstall, runUninstall } from './service.js';
import type { ServiceIo } from './service.js';
import { runSetup } from './setup.js';
import type { SetupIo } from './setup.js';
import { buildRealStartIo, runStart } from './start.js';
import { runPause, runResume, runStatus } from './statusCmd.js';
import type { StatusIo } from './statusCmd.js';

/**
 * Reads the running package's own version straight from `package.json` at
 * runtime -- never a hardcoded literal that could drift from the
 * manifest. `dist/cli/main.js` and `src/cli/main.ts` are both exactly two
 * directories below the repository root (`tsconfig.build.json`'s
 * `rootDir`/`outDir` mirror `src/`'s layout 1:1 under `dist/`), so
 * `'../../package.json'` resolves correctly relative to `import.meta.url`
 * whether this file is executed as compiled JS or as TS under a test
 * runner -- the same technique `tests/unit/package-contract.test.ts`
 * already uses for the same reason.
 */
function readPackageVersion(): string {
  const manifestUrl = new URL('../../package.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version: string };
  return manifest.version;
}

function buildRealWriter(): Writer {
  return {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  };
}

/**
 * Wires `src/cli/setup.ts`'s `SetupIo`. `stat`/`openDatabase` are reused
 * DIRECTLY from the already-built `doctorIo` (same real functions `doctor`
 * itself uses) rather than re-derived, so there is exactly one production
 * implementation of each; `mkdir`/`writeFile`/`chmod` are thin real-`fs`
 * wrappers matching `SetupIo`'s documented contract.
 */
function buildRealSetupIo(doctorIo: ReturnType<typeof buildDefaultDoctorIo>): SetupIo {
  return {
    env: process.env,
    homedir: homedir(),
    stat: doctorIo.stat,
    openDatabase: doctorIo.openDatabase,
    mkdir: (path) => {
      mkdirSync(path, { recursive: true });
    },
    writeFile: (path, content) => {
      writeFileSync(path, content, 'utf8');
    },
    chmod: (path, mode) => {
      chmodSync(path, mode);
    },
  };
}

function buildRealDispatchIo(): DispatchIo {
  const writer = buildRealWriter();
  const doctorIo = buildDefaultDoctorIo();
  const setupIo = buildRealSetupIo(doctorIo);
  // `status`/`pause`/`resume` (D-P5B12-5) reuse the SAME production
  // `openDatabase` doctor already wires -- one real implementation only.
  const statusIo: StatusIo = {
    env: process.env,
    homedir: homedir(),
    readFileSync: (path) => readFileSync(path, 'utf8'),
    openDatabase: doctorIo.openDatabase,
  };
  // `install`/`uninstall` (D-P5B13-5): platform/nodePath/entryPath are the
  // real process values, read ONCE here at the assembly edge. entryPath ''
  // (argv[1] somehow absent) makes runInstall fail closed instead of
  // writing a unit that supervises nothing.
  const serviceIo: ServiceIo = {
    platform: process.platform,
    nodePath: process.execPath,
    entryPath: process.argv[1] ?? '',
    env: process.env,
    homedir: homedir(),
    exists: (path) => existsSync(path),
    mkdir: (path) => {
      mkdirSync(path, { recursive: true });
    },
    writeFile: (path, content) => {
      writeFileSync(path, content, 'utf8');
    },
    unlink: (path) => {
      unlinkSync(path);
    },
  };
  // Structural: covers StatusCommandResult, SetupResult and
  // ServiceCommandResult alike (exit 0 ⇒ stdout, non-zero ⇒ stderr).
  const printResult = (result: { exitCode: number; messages: readonly string[] }): number => {
    const print = result.exitCode === 0 ? writer.out : writer.err;
    for (const message of result.messages) {
      print(message);
    }
    return result.exitCode;
  };
  return {
    writer,
    version: readPackageVersion(),
    env: process.env,
    homedir: homedir(),
    readFileSync: (path) => readFileSync(path, 'utf8'),
    doctorIo,
    // The real `runSetup` (`src/cli/setup.ts`, D-P5S-6). `dispatch.ts`'s
    // own `case 'setup':` route is handler-agnostic (see its module doc
    // comment) -- only this assembly knows the implementation. `new Date()`
    // appears ONLY in this assembly, evaluated at the moment a command is
    // actually invoked, never inside the command modules themselves.
    runSetup: (args) => {
      const result = runSetup(args, setupIo, new Date());
      const print = result.exitCode === 0 ? writer.out : writer.err;
      for (const message of result.messages) {
        print(message);
      }
      return result.exitCode;
    },
    // D-P5B12-5: the real daemon commands.
    runStart: (args) => runStart(args, buildRealStartIo(writer)),
    runStatus: () => printResult(runStatus(statusIo)),
    runPause: () => printResult(runPause(statusIo, new Date())),
    runResume: () => printResult(runResume(statusIo, new Date())),
    // D-P5B13-5: the service-file commands (write/remove + print-only
    // activation; amb never runs the service manager).
    runInstall: (args) => printResult(runInstall(args, serviceIo)),
    runUninstall: (args) => printResult(runUninstall(args, serviceIo)),
  };
}

// Only run when this file is the actual entry point, not when imported
// (e.g. accidentally, from another module or a future test) -- mirrors the
// guard the Phase 0 skeleton used for the same reason.
const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  // Top-level await: `dispatch` is async since batch 12 (`amb start` runs
  // the daemon to completion). `process.exitCode` (never `process.exit()`)
  // still lets stdout/stderr flush before the process actually exits.
  process.exitCode = await dispatch(process.argv.slice(2), buildRealDispatchIo());
}
