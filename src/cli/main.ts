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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { buildDefaultDoctorIo } from './doctor.js';
import { createSetupPlaceholder, dispatch } from './dispatch.js';
import type { DispatchIo, Writer } from './dispatch.js';

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

function buildRealDispatchIo(): DispatchIo {
  const writer = buildRealWriter();
  return {
    writer,
    version: readPackageVersion(),
    env: process.env,
    homedir: homedir(),
    readFileSync: (path) => readFileSync(path, 'utf8'),
    doctorIo: buildDefaultDoctorIo(),
    // Task-3 stub; Task 4 replaces this one line with the real `runSetup`
    // from `src/cli/setup.ts` (see dispatch.ts's module doc comment --
    // dispatch.ts's own `case 'setup':` route does not change).
    runSetup: createSetupPlaceholder(writer),
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
