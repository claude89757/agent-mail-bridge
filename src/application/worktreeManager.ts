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
 *     `git rev-parse --verify <ref>^{commit}`, to an explicit commit SHA —
 *     resolution failure rejects with a message naming the requirement
 *     ("must create from an explicit base commit"), never a silent
 *     fallback to some other ref.
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
import { join, sep } from 'node:path';
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
 *    returning `false` does more directly.
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

  // Invariant 3, first half: repoRoot must be a git repository.
  try {
    await io.execFile(['rev-parse', '--git-dir'], realRepoRoot);
  } catch (error) {
    throw new Error(
      `createTaskWorktree: repoRoot is not a git repository: ${realRepoRoot} (${describeError(error)})`,
      { cause: error },
    );
  }

  // Invariant 3, second half: baseRef must resolve to an explicit commit
  // sha — never a silent fallback.
  let baseCommit: string;
  try {
    const { stdout } = await io.execFile(
      ['rev-parse', '--verify', `${baseRef}^{commit}`],
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
 * thin: no path validation of its own (there is no `taskId` here, only a
 * caller-supplied `worktreePath`) — `git worktree remove` already fails
 * closed on any path it does not recognize as one of ITS OWN registered
 * worktrees, and on a DIRTY worktree (uncommitted or untracked changes)
 * unless `--force` is passed. That failure is left to propagate to the
 * caller VERBATIM — never swallowed, wrapped, or retried with `--force`
 * automatically. Deciding WHEN to force-remove is Phase 3 proper's
 * cleanup-policy call, not this function's; `force` here is only ever the
 * caller's own explicit input.
 */
export async function removeTaskWorktree(
  input: { repoRoot: string; worktreePath: string; force?: boolean },
  io: GitIo,
): Promise<void> {
  const { repoRoot, worktreePath, force = false } = input;
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
