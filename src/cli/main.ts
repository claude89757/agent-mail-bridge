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
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { buildDefaultDoctorIo } from './doctor.js';
import { dispatch } from './dispatch.js';
import type { DispatchIo, Writer } from './dispatch.js';
import { runSetup } from './setup.js';
import type { SetupIo } from './setup.js';

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
  return {
    writer,
    version: readPackageVersion(),
    env: process.env,
    homedir: homedir(),
    readFileSync: (path) => readFileSync(path, 'utf8'),
    doctorIo,
    // Task 4: the real `runSetup` (`src/cli/setup.ts`, D-P5S-6) replaces the
    // Task-3 placeholder here. `dispatch.ts`'s own `case 'setup':` route is
    // untouched (see its module doc comment) -- only this assembly changed.
    // `new Date()` appears ONLY here, evaluated at the moment `setup` is
    // actually invoked, never inside `runSetup` itself (D-P5S-6).
    runSetup: (args) => {
      const result = runSetup(args, setupIo, new Date());
      const print = result.exitCode === 0 ? writer.out : writer.err;
      for (const message of result.messages) {
        print(message);
      }
      return result.exitCode;
    },
  };
}

// Only run when this file is the actual entry point, not when imported
// (e.g. accidentally, from another module or a future test) -- mirrors the
// guard the Phase 0 skeleton used for the same reason.
const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  process.exitCode = dispatch(process.argv.slice(2), buildRealDispatchIo());
}
