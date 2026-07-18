/**
 * Bridge-owned worktree manager (decision D-P3P-2, security control C7,
 * spec §3.4): creates and removes git worktrees the bridge itself owns, so
 * that an agent task's writes NEVER land in the user's own checkout or
 * touch uncommitted changes there. Every write this module performs is
 * exactly one of `git worktree add --detach` or `git worktree remove` — no
 * other write-type git subcommand (`checkout`, `reset`, `clean`, `branch`,
 * ...) appears anywhere in this file; `tests/unit/worktree-manager.test.ts`'s
 * call-sequence assertion pins this against regressions by recording the
 * FULL sequence of git subcommands a fake `GitIo` observes on the happy
 * path.
 *
 * Six security invariants (spec §3.4 / threat-model.md C7), each with at
 * least one dedicated test:
 *  1. `taskId` must match `TASK_ID_PATTERN` — checked FIRST, before any IO
 *     at all (the first gate against path injection/escape via taskId).
 *  2. `repoRoot`/`worktreesRoot` must already exist (`io.realpath` rejects
 *     otherwise, same contract as `fs.promises.realpath`); both are
 *     resolved through `io.realpath` and every path used from then on is
 *     the RESOLVED (symlink-free) form. `worktreePath` is built by joining
 *     the resolved `worktreesRoot` with `taskId` and independently
 *     re-verified (`assertWithinWorktreesRoot`) to still sit under that
 *     same resolved root — defense in depth: gate 1 already makes a real
 *     escape structurally impossible (a whitelisted `taskId` can never
 *     contain `/` or `..`), but this guard also protects against a
 *     misbehaving/non-canonical `io.realpath` implementation (see that
 *     function's doc comment, and the "crafted realpath" fake-io test).
 *  3. `repoRoot` must be a git repository (`git rev-parse --git-dir`
 *     succeeds) and `baseRef` must resolve, via
 *     `git rev-parse --verify --end-of-options <ref>^{commit}`, to an
 *     explicit commit SHA — resolution failure rejects with a message
 *     naming the requirement ("must create from an explicit base commit"),
 *     never a silent fallback to some other ref. Two argv-injection guards
 *     bracket this step: `--end-of-options` stops a hostile baseRef
 *     spelled like an option from being option-scanned (it is looked up as
 *     a ref and fails as one), and the returned sha must match
 *     `COMMIT_SHA_PATTERN` before it may enter the `worktree add` argv.
 *  4. Creation is always `git worktree add --detach <path> <sha>`:
 *     `--detach` means the new worktree claims no branch name and
 *     therefore cannot mutate or conflict with any existing branch. The
 *     target path must NOT already exist — `createTaskWorktree` never
 *     reuses or overwrites a path; the `io.exists` check runs BEFORE any
 *     git subcommand at all, so a colliding taskId costs zero subprocess
 *     calls (a performance choice, not a security one — invariant 6's
 *     call-sequence assertion only requires that `worktree add` itself
 *     never runs on this path).
 *  5. `removeTaskWorktree` defaults to NOT passing `--force`: a dirty
 *     worktree (uncommitted or untracked changes) makes `git worktree
 *     remove` fail on its own, and that failure is propagated verbatim —
 *     fail closed. `force: true` is an explicit, separate decision left to
 *     the caller (Phase 3 proper decides the cleanup policy that sets it).
 *     One mechanical precondition: `worktreePath` must be absolute (see
 *     the function's doc comment — it kills the leading-`-`
 *     option-collision class outright).
 *  6. See the paragraph above: no write-type git subcommand other than
 *     `worktree add`/`worktree remove` ever appears.
 *
 * `GitIo`/`FsIo` are injected so unit tests can exercise every error path
 * (non-repo, unresolvable baseRef, a crafted realpath, ...) without a real
 * filesystem or git binary; `buildDefaultWorktreeIo` at the bottom of this
 * file wires the real `git` subprocess + `node:fs/promises` versions for
 * production callers, following the `buildDefaultDoctorIo` precedent in
 * `src/cli/doctor.ts`.
 *
 * `removeTaskWorktree` only needs `GitIo` — it does no path validation of
 * its own beyond what git itself enforces (there is no `taskId` in its
 * input at all, only a caller-supplied `worktreePath`), by design: `git
 * worktree remove` already fails closed on any path it does not recognize
 * as one of ITS OWN registered worktrees.
 *
 * No console, no `Date.now()`/`new Date()`: nothing here needs the current
 * time, and printing is never this layer's job.
 */
import { execFile as execFileCb } from 'node:child_process';
import { access, realpath as fsRealpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Locked API types (D-P3P-2)
// ---------------------------------------------------------------------------

/**
 * Everything this module needs from `git`, injected so unit tests can
 * script every error path (non-repo, unresolvable baseRef, a failing
 * `worktree add`, ...) without a real git binary. Production wiring:
 * `buildDefaultWorktreeIo` below is the ONLY place a real `git` subprocess
 * is spawned. This module's OWN behavior — never this type — is what keeps
 * calls limited to `rev-parse`/`worktree add`/`worktree remove` (module doc
 * comment, invariant 6); `tests/unit/worktree-manager.test.ts` pins that
 * behavior via a full call-sequence assertion against a fake `GitIo`.
 */
export interface GitIo {
  execFile(args: readonly string[], cwd: string): Promise<{ stdout: string }>;
}

/**
 * Minimal filesystem seam `createTaskWorktree` needs (D-P3P-2's "FsIo shape
 * is yours to define minimally"):
 *  - `realpath` resolves a path to its canonical, symlink-free absolute
 *    form — same contract as `fs.promises.realpath`, which REJECTS if
 *    `path` does not exist. That rejection IS how invariant 2's
 *    "repoRoot/worktreesRoot must exist" is enforced; there is no separate
 *    existence check for those two paths.
 *  - `exists` checks whether a path exists at all, true/false, never
 *    throwing for "not there". Deliberately NOT `realpath`-based: the
 *    whole point of calling it is to check the TARGET worktree path, which
 *    must NOT exist yet (invariant 4) — calling `realpath` on it would
 *    just reject with ENOENT and convey no more information than `exists`
 *    returning `false` does more directly. Symlink subtlety: the default
 *    implementation is `access()`-based, which FOLLOWS symlinks — see the
 *    wiring comment in `buildDefaultWorktreeIo` for why that makes this
 *    check LOAD-BEARING against a symlink planted at the target path.
 */
export interface FsIo {
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface CreateWorktreeInput {
  repoRoot: string;
  baseRef: string;
  worktreesRoot: string;
  taskId: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Duplicated per-file by convention (see `src/cli/doctor.ts`, `setup.ts`,
 * `config.ts`) rather than shared — small enough that a shared module would
 * cost more (an import + a layering decision) than it saves. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoentError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Invariant 1 (module doc comment): checked first, before any IO. Matches
 * D-P3P-2 exactly: starts with a lowercase letter or digit, then 0-63 more
 * lowercase letters/digits/hyphens (1-64 chars total). No `/`, no `.`, no
 * uppercase — a taskId can never spell a path-traversal segment. */
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * What `git rev-parse --verify <ref>^{commit}` may legitimately print: one
 * full object name — 40 lowercase hex chars in a SHA-1 repo, 64 in a
 * SHA-256 (`objectFormat = sha256`) repo. Nothing else: git prints object
 * ids lowercase, so uppercase hex — like interleaved warning lines, empty
 * output, or localized error text — is an anomaly and fails closed BEFORE
 * the value is ever placed into the `worktree add` argv (argv-injection
 * guard: `baseCommit` is the only string in that argv that originates from
 * a subprocess rather than from this module's own validated inputs).
 */
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Invariant 2's defense-in-depth half: independently confirms `worktreePath`
 * (built by joining `realWorktreesRoot` with an already-whitelisted
 * `taskId`) still sits textually under `realWorktreesRoot`. Given a
 * `taskId` that already passed `TASK_ID_PATTERN` (no `/`, no `..`),
 * `join(realWorktreesRoot, taskId)` can never actually escape
 * `realWorktreesRoot` through NORMAL path arithmetic — this guard exists
 * for the case where `io.realpath` itself is a misbehaving/non-canonical
 * implementation (an injected fake in a unit test today; a hypothetical
 * future regression tomorrow): it fails closed rather than trusting
 * `join`'s normalization to have preserved a prefix relationship that was
 * only ever guaranteed for a canonical, already-normalized input. A
 * trailing separator on `realWorktreesRoot` is tolerated (normalized before
 * comparing) so a technically-non-canonical-but-otherwise-faithful
 * `realpath` result is not rejected on that basis alone.
 */
function assertWithinWorktreesRoot(worktreePath: string, realWorktreesRoot: string): void {
  const prefix = realWorktreesRoot.endsWith(sep) ? realWorktreesRoot : `${realWorktreesRoot}${sep}`;
  if (!worktreePath.startsWith(prefix)) {
    throw new Error(
      `createTaskWorktree: computed worktree path "${worktreePath}" does not stay within ` +
        `the resolved worktreesRoot "${realWorktreesRoot}" — rejected (C7 symlink-escape guard)`,
    );
  }
}

// ---------------------------------------------------------------------------
// createTaskWorktree
// ---------------------------------------------------------------------------

/**
 * Creates a bridge-owned worktree for one task (D-P3P-2). See the module
 * doc comment for the full six-invariant rationale; this is the check
 * ORDER, normative:
 *
 *   taskId whitelist -> realpath(repoRoot) -> realpath(worktreesRoot)
 *     -> compute + verify worktreePath -> target-not-exists
 *     -> repoRoot is a git repo -> baseRef resolves to a commit sha
 *     -> git worktree add --detach
 *
 * Every rejection is a plain `Error` (matching this file's neighbors in
 * `src/application/` — see `ingest.ts`'s intent-id-collision guard) with a
 * message naming which invariant/step failed, never a generic passthrough:
 * even the two steps that wrap an underlying `io` rejection
 * (`describeError`) prefix it with which requirement was not met.
 */
export async function createTaskWorktree(
  input: CreateWorktreeInput,
  io: GitIo & FsIo,
): Promise<{ worktreePath: string; baseCommit: string }> {
  const { repoRoot, baseRef, worktreesRoot, taskId } = input;

  // Invariant 1: first gate, before any IO.
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(
      `createTaskWorktree: invalid taskId ${JSON.stringify(taskId)} — must match ${TASK_ID_PATTERN}`,
    );
  }

  // Invariant 2: repoRoot/worktreesRoot must exist; realpath both.
  let realRepoRoot: string;
  try {
    realRepoRoot = await io.realpath(repoRoot);
  } catch (error) {
    throw new Error(
      `createTaskWorktree: repoRoot does not exist or is not accessible: ${repoRoot} ` +
        `(${describeError(error)})`,
      { cause: error },
    );
  }

  let realWorktreesRoot: string;
  try {
    realWorktreesRoot = await io.realpath(worktreesRoot);
  } catch (error) {
    throw new Error(
      `createTaskWorktree: worktreesRoot does not exist or is not accessible: ${worktreesRoot} ` +
        `(${describeError(error)})`,
      { cause: error },
    );
  }

  const worktreePath = join(realWorktreesRoot, taskId);
  assertWithinWorktreesRoot(worktreePath, realWorktreesRoot);

  // Invariant 4 (existence half): no reuse, no overwrite — checked before
  // any git subcommand (see this function's doc comment).
  if (await io.exists(worktreePath)) {
    throw new Error(`createTaskWorktree: target worktree path already exists: ${worktreePath}`);
  }

  // Invariant 3, first half: repoRoot must be a git repository. No
  // `--end-of-options` here, judged deliberately: this argv is entirely
  // constant — no caller-influenced string appears in it (cwd is not argv),
  // so there is nothing for git's option scanning to misread. The sentinel
  // guards the NEXT call, whose argv embeds `baseRef`.
  try {
    await io.execFile(['rev-parse', '--git-dir'], realRepoRoot);
  } catch (error) {
    throw new Error(
      `createTaskWorktree: repoRoot is not a git repository: ${realRepoRoot} (${describeError(error)})`,
      { cause: error },
    );
  }

  // Invariant 3, second half: baseRef must resolve to an explicit commit
  // sha — never a silent fallback. `--end-of-options` (git >= 2.24) makes
  // the position explicit: everything after it is a revision, never an
  // option — so a hostile baseRef spelled like an option (e.g.
  // `--path-format=absolute`) is looked up as a ref (and fails as one)
  // instead of being option-scanned. Measured on git 2.54: without the
  // sentinel such values happen to fail too, but only through
  // version-specific option-parsing accidents — this makes the guarantee
  // explicit and auditable rather than accidental.
  let baseCommit: string;
  try {
    const { stdout } = await io.execFile(
      ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
      realRepoRoot,
    );
    baseCommit = stdout.trim();
  } catch (error) {
    throw new Error(
      `createTaskWorktree: baseRef ${JSON.stringify(baseRef)} did not resolve to an explicit ` +
        `base commit (${describeError(error)}) — worktrees must be created from an explicit base commit`,
      { cause: error },
    );
  }

  // Second half of the argv-injection guard: `baseCommit` is the only
  // subprocess-originated string that ever enters a later argv, so it must
  // look exactly like the one thing rev-parse may print (see
  // COMMIT_SHA_PATTERN) before `worktree add` gets to see it.
  if (!COMMIT_SHA_PATTERN.test(baseCommit)) {
    throw new Error(
      `createTaskWorktree: rev-parse did not return a well-formed commit sha for baseRef ` +
        `${JSON.stringify(baseRef)} (got ${JSON.stringify(baseCommit)}) — rejected before it ` +
        `could enter the worktree-add argv`,
    );
  }

  // Invariant 4: create, detached (claims no branch name, never mutates any
  // existing branch/worktree).
  try {
    await io.execFile(['worktree', 'add', '--detach', worktreePath, baseCommit], realRepoRoot);
  } catch (error) {
    throw new Error(`createTaskWorktree: git worktree add failed: ${describeError(error)}`, {
      cause: error,
    });
  }

  return { worktreePath, baseCommit };
}

// ---------------------------------------------------------------------------
// removeTaskWorktree
// ---------------------------------------------------------------------------

/**
 * Removes a bridge-owned worktree (D-P3P-2, invariant 5). Deliberately
 * thin — ONE mechanical precondition, then git: `worktreePath` must be
 * absolute. That single check is cheap to audit and kills the whole class
 * of argv accidents at once — an absolute path always starts with the
 * platform separator, so it can never be option-scanned by git (a
 * caller-supplied `--force`/`-f` as `worktreePath` would otherwise reach
 * git's argv; measured on git 2.54 it happens to die as a usage error, but
 * that is version-specific parsing luck, not a guarantee), and a relative
 * path could silently mean something different depending on what
 * `repoRoot` happens to be.
 *
 * Beyond that, no path validation of its own (there is no `taskId` here,
 * only a caller-supplied `worktreePath`) — `git worktree remove` already
 * fails closed on any path it does not recognize as one of ITS OWN
 * registered worktrees, and on a DIRTY worktree (uncommitted or untracked
 * changes) unless `--force` is passed. That failure is left to propagate
 * to the caller VERBATIM — never swallowed, wrapped, or retried with
 * `--force` automatically. Deciding WHEN to force-remove is Phase 3
 * proper's cleanup-policy call, not this function's; `force` here is only
 * ever the caller's own explicit input.
 */
export async function removeTaskWorktree(
  input: { repoRoot: string; worktreePath: string; force?: boolean },
  io: GitIo,
): Promise<void> {
  const { repoRoot, worktreePath, force = false } = input;
  if (!isAbsolute(worktreePath)) {
    throw new Error(
      `removeTaskWorktree: worktreePath must be an absolute path, got ${JSON.stringify(worktreePath)}`,
    );
  }
  const args = force
    ? ['worktree', 'remove', '--force', worktreePath]
    : ['worktree', 'remove', worktreePath];
  await io.execFile(args, repoRoot);
}

// ---------------------------------------------------------------------------
// Production io wiring
// ---------------------------------------------------------------------------

/**
 * Wires the real `git` subprocess (`node:child_process.execFile`,
 * promisified) and `node:fs/promises` behind `GitIo & FsIo`, for
 * `application`/`daemon`/`cli` callers to plug into `createTaskWorktree` /
 * `removeTaskWorktree`. Follows the `buildDefaultDoctorIo` precedent
 * (`src/cli/doctor.ts`): the only place in this module that spawns a real
 * process or touches the real filesystem — every function above only ever
 * calls `io`.
 */
export function buildDefaultWorktreeIo(): GitIo & FsIo {
  return {
    async execFile(args, cwd) {
      const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
      return { stdout };
    },
    realpath: (target) => fsRealpath(target),
    // access()-based, so this FOLLOWS symlinks — and that is load-bearing,
    // not incidental (C7): a symlink planted at the target path pointing to
    // an EXISTING directory outside worktreesRoot makes this return true,
    // so `createTaskWorktree` rejects with "already exists" before git ever
    // runs. Measured on git 2.54, that early rejection is the ONLY thing
    // preventing an escape in that shape: a bare `git worktree add` pointed
    // at such a symlink does NOT refuse — it registers the worktree and
    // checks the tree out THROUGH the symlink into the outside directory.
    // The complementary shape — a DANGLING symlink at the target — slips
    // past this check (access() follows the link, finds nothing, reports
    // ENOENT => false), and there git's own lstat-based "already exists"
    // refusal is what backstops, at the cost of two wasted git calls. Both
    // shapes fail closed, through different layers; both are pinned by
    // real-git tests in tests/unit/worktree-manager.test.ts.
    async exists(target) {
      try {
        await access(target);
        return true;
      } catch (error) {
        if (isEnoentError(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}
