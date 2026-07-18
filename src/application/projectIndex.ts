/**
 * Project allowlist/index (decisions D-P3B3-1..4, spec §3.4 "项目发现"):
 * turns a configured list of repo-root directories into a small, precise
 * index of {name, realpath, aliases} triples that Phase 4's mail router
 * will later look up by exact name/alias.
 *
 * THE CORE INVARIANT THIS MODULE EXISTS TO ENFORCE: mail can never name an
 * arbitrary path. A control mail's body is free text — at most a project
 * NAME or ALIAS, nothing path-shaped is ever honored (see invariant 5
 * below). The router (Phase 4, not yet built) will call
 * `ProjectIndex#lookup(term)` with that free text and get back zero or
 * more `ProjectEntry`s; a returned entry's `.path` is the ONLY path that
 * may ever reach `worktreeManager.createTaskWorktree`'s `repoRoot`
 * argument downstream. There is no other function in this module — or
 * anywhere else in the bridge — through which a string taken from mail
 * body/subject text can turn into a filesystem path. This module is that
 * boundary: it is built ONCE from operator-controlled configuration
 * (`roots`/`aliases`, both supplied by whoever runs the bridge, never by
 * mail), and from then on offers only exact, allowlisted lookups — no
 * fuzzy/prefix/substring matching (that would let a crafted mail body
 * probe for near-matches), no way to add an entry after construction, no
 * way for a `ProjectEntry` to exist except by this module successfully
 * scanning a real git repository sitting directly under an allowlisted
 * root.
 *
 * Trust boundary corollary (review note): the CONTENTS of a configured
 * root are trusted exactly as far as the root itself — whoever can write
 * into it (e.g. a shared or world-writable directory) can plant
 * plausibly-named symlinks/repos and thereby shape this index. Point
 * `roots` only at directories the operator alone controls; threat-model
 * assumption #3 (trusted local machine) does not stretch to multi-writer
 * roots.
 *
 * Shape follows `worktreeManager.ts`'s io-injection precedent: `ProjectScanIo`
 * is the minimal seam (`realpath` / `listDirectories` / `isGitRepo`) unit
 * tests script; `buildDefaultProjectScanIo` at the bottom is the ONLY place
 * a real filesystem read or `git` subprocess is spawned, for
 * `daemon`/`cli` callers to plug into `buildProjectIndex`.
 *
 * Six security invariants (D-P3B3-2), each with at least one dedicated
 * test in `tests/unit/project-index.test.ts`:
 *  1. Every root is realpath'd; every candidate child directory is
 *     realpath'd; a child's resolved path must start with
 *     `realpath(root) + sep` — the same prefix check
 *     `worktreeManager.ts`'s `assertWithinWorktreesRoot` uses. A symlinked
 *     child that resolves OUTSIDE its root is rejected into the
 *     `rejected` list with `SYMLINK_ESCAPE` — NOT silently dropped:
 *     silently dropping it would make a misconfigured or hostile symlink
 *     indistinguishable from "nothing there", exactly the kind of config
 *     error that must surface (D-P3B3-4). It never enters `index.entries`
 *     either way.
 *  2. Only actual git repositories enter the index (`io.isGitRepo` true —
 *     production wiring runs `git rev-parse --git-dir`). A non-git
 *     directory is skipped SILENTLY: this is the normal, expected case
 *     (an allowlisted root will usually contain non-repo clutter), not a
 *     `rejected` entry.
 *  3. Alias validation fails closed by THROWING out of `buildProjectIndex`
 *     entirely (never by degrading to a partial index): an alias whose
 *     target path does not realpath to any scanned project's `.path`, or
 *     an alias key that collides (after trim+lowercase) with any scanned
 *     project name or with another alias key, is a configuration error
 *     and must be surfaced immediately at startup — not silently ignored
 *     or guessed around.
 *  4. Two roots may legitimately contain same-named subdirectories (e.g. a
 *     work root and a personal root both have an "api" repo). BOTH enter
 *     the index as separate entries; `lookup` returns every match.
 *     Picking "the" match is explicitly Phase 4's job (candidate
 *     scoring/disambiguation) — this module never guesses.
 *  5. `lookup(term)` NEVER interprets `term` as a path. It does exactly
 *     one thing: trim, lowercase, compare for EQUALITY against each
 *     entry's `name` and `aliases`. No prefix/substring/fuzzy matching
 *     exists anywhere in this file. As an extra, test-pinned guard against
 *     ever being tempted to feed `term` into a path operation, any `term`
 *     containing `/`, `\`, `..`, or a NUL byte is rejected outright
 *     (returns `[]` before any comparison happens at all); an empty or
 *     whitespace-only term also returns `[]`.
 *  6. The only git subcommand this module (via `buildDefaultProjectScanIo`)
 *     ever invokes is `rev-parse --git-dir`, with `cwd` set to the
 *     candidate directory and an otherwise entirely constant argv —
 *     nothing is ever interpolated into it. No other git subcommand
 *     appears anywhere in this file.
 *
 * Build-report semantics (D-P3B3-4): `buildProjectIndex` resolves to
 * `{ index, rejected }` rather than throwing for a single bad root — one
 * missing root must not take down an otherwise-valid multi-root config.
 * `RejectedDir.reason` is `'ROOT_NOT_FOUND'` for a root that itself could
 * not be resolved or listed (this folds "root does not exist" and "root
 * exists but is not a listable directory, e.g. it is a file" into the same
 * closed two-reason enum — this module has no third bucket for the rarer,
 * latter case, and treating it identically to a missing root keeps the
 * enum simple while still failing that ONE root closed), or
 * `'SYMLINK_ESCAPE'` for a candidate child that resolved outside its root.
 * Two situations THROW instead of returning a `rejected` entry, because
 * they can only mean a config mistake severe enough that returning an
 * (empty) index would be misleading: `roots` is an empty array, or
 * literally every root in it was rejected as `ROOT_NOT_FOUND`. An index
 * that is empty merely because valid roots happened to contain zero git
 * repositories is NOT such a mistake and does NOT throw — that is a
 * legitimate (if unusual) scan result.
 *
 * Ordering (D-P3B3-3, deterministic, test-pinned): `index.entries` is
 * ordered by `roots` param order first, then lexicographically (plain
 * ordinal comparison, not locale-aware collation) by directory name within
 * each root — this module SORTS every root's candidate list itself rather
 * than trusting whatever order `io.listDirectories` happens to return (a
 * fake io in tests deliberately returns children out of order to prove
 * this). `lookup` returns matches in that same `entries` order.
 *
 * Normalization: `name` is a candidate directory's own basename — as
 * listed directly under its resolved root, NOT the basename of whatever a
 * symlinked child ultimately resolves to, so a same-root symlink still
 * indexes under the name a human sees sitting in the root — after
 * `trim().toLowerCase()`. Alias keys are normalized the same way. `path`
 * is always the realpath'd, symlink-free absolute location: the only
 * filesystem path this module ever hands back.
 *
 * No console (house eslint rule); no `Date.now()`/`new Date()` — nothing
 * here needs the current time, and this module does no logging of its own
 * (callers decide how to present `rejected`).
 */
import { execFile as execFileCb } from 'node:child_process';
import { readdir, realpath as fsRealpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Locked API types (D-P3B3-1, D-P3B3-4)
// ---------------------------------------------------------------------------

export interface ProjectEntry {
  /** Index name (directory basename, trim+lowercase normalized). */
  readonly name: string;
  /** realpath'd absolute path — the ONLY trusted path source. */
  readonly path: string;
  /** Every alias hitting this project (trim+lowercase normalized, not
   * including `name` itself). */
  readonly aliases: readonly string[];
}

export interface ProjectIndex {
  readonly entries: readonly ProjectEntry[];
  /** Exact match on `name` or any alias, after trim+lowercase on `term`;
   * NO fuzzy/prefix/substring matching. See invariant 5 in the module doc
   * comment for the full path-flavored-input rejection contract. */
  lookup(term: string): readonly ProjectEntry[];
}

export interface BuildProjectIndexInput {
  /** Allowlisted repo-root directories; DIRECT children only are scanned. */
  roots: readonly string[];
  /** alias -> project path. Must resolve to a scanned project's path, else
   * `buildProjectIndex` fails closed (throws) — see invariant 3. */
  aliases?: Readonly<Record<string, string>>;
}

/** A root or candidate directory that did not make it into the index,
 * together with why. See the module doc comment's "Build-report semantics"
 * section for the full throw-vs-reject rules (D-P3B3-4). */
export type RejectedDir = { path: string; reason: 'SYMLINK_ESCAPE' | 'ROOT_NOT_FOUND' };

/**
 * Everything `buildProjectIndex` needs from the filesystem and git,
 * injected so unit tests can script every path (a symlink escaping its
 * root, a missing root, a non-git directory, ...) without touching a real
 * filesystem or spawning a real git process. Production wiring:
 * `buildDefaultProjectScanIo` below is the ONLY place that happens.
 * (D-P3B3-1 leaves this surface for the implementer to shape minimally;
 * this is this module's answer, deliberately mirroring `worktreeManager.ts`'s
 * `GitIo`/`FsIo` split at the granularity the security invariants need and
 * no finer.)
 */
export interface ProjectScanIo {
  /** Resolves `path` to its canonical, symlink-free absolute form — same
   * contract as `fs.promises.realpath` (REJECTS if `path` does not exist).
   * Called on every root and every candidate child directory (invariant
   * 1), and, during alias validation, on every alias target path. */
  realpath(path: string): Promise<string>;
  /** Returns the DIRECT child directories of `dir` (non-recursive), as
   * absolute paths still rooted at `dir` (i.e. NOT realpath'd yet — this
   * module realpaths each one itself, per invariant 1). Order carries no
   * meaning: `buildProjectIndex` sorts the result itself (D-P3B3-3), it
   * never trusts io order. A directory reachable only via a symlink is a
   * legitimate member of this list — that is exactly the case invariant
   * 1's escape check exists to police; `buildDefaultProjectScanIo`
   * includes a symlink here iff it resolves (via `stat`, which follows
   * the link) to a directory, and excludes plain files and dangling
   * symlinks. */
  listDirectories(dir: string): Promise<readonly string[]>;
  /** True iff `dir` is the root of a git repository. Production
   * implementation: `git rev-parse --git-dir` with `cwd: dir` and an
   * otherwise entirely constant argv (invariant 6) — no caller-influenced
   * string ever enters this argv, only `cwd` varies. MUST NOT reject: any
   * failure of the underlying check (not a repo, permission denied, `dir`
   * vanished between listing and checking, git itself missing) is
   * conservatively folded into `false` by `buildDefaultProjectScanIo` — a
   * single unscannable candidate must not abort the whole index build
   * (mirrors the `rejected`-not-throw philosophy for a single bad root,
   * D-P3B3-4). A `false` result is what invariant 2's silent skip acts
   * on. */
  isGitRepo(dir: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Duplicated per-file by convention (see `worktreeManager.ts`,
 * `src/cli/doctor.ts`, `setup.ts`, `config.ts`) rather than shared — small
 * enough that a shared module would cost more than it saves. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A candidate project directory before alias attachment (D-P3B3-3
 * ordering already applied by the time this is built). */
interface ScannedProject {
  name: string;
  path: string;
}

/** Sorts a root's candidate child paths by directory NAME (basename),
 * plain ordinal comparison — deliberately NOT `localeCompare` (D-P3B3-3
 * calls for a deterministic lexicographic order; locale-aware collation
 * can reorder differently across environments/ICU data, which a pinned
 * test must not be at the mercy of). */
function sortByBasename(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const nameA = basename(a);
    const nameB = basename(b);
    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    return 0;
  });
}

/** Invariant 1's containment check: does `candidate` sit strictly inside
 * `root` (both already realpath'd)? Trailing-separator-tolerant on `root`,
 * matching `worktreeManager.ts`'s `assertWithinWorktreesRoot`. Unlike that
 * function this one does not throw — an escaping child becomes a
 * per-child `rejected` entry, not a fatal error for the whole build
 * (D-P3B3-4). */
function isWithinRoot(candidate: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/** Invariant 5's path-flavor guard: `lookup` never interprets `term` as a
 * path, so anything that LOOKS path-shaped is rejected outright rather
 * than ever risk being compared/used as one. Checked against the raw
 * term — trimming first would not change the answer for any of these four
 * checks, since none of them are whitespace. */
function isPathFlavoredTerm(term: string): boolean {
  return term.includes('/') || term.includes('\\') || term.includes('..') || term.includes('\0');
}

// ---------------------------------------------------------------------------
// buildProjectIndex
// ---------------------------------------------------------------------------

/**
 * Scans every allowlisted root's direct children for git repositories and
 * builds the exact-match `ProjectIndex` the (future, Phase 4) mail router
 * will query by name/alias. See the module doc comment for the full
 * six-invariant rationale and the build-report throw/reject rules
 * (D-P3B3-4). Check order, normative:
 *
 *   roots non-empty -> per-root [realpath -> listDirectories -> sort ->
 *     per-child [realpath -> containment -> isGitRepo]] -> all-roots-
 *     rejected check -> per-alias [duplicate-key -> name-collision ->
 *     realpath + membership]
 *
 * Every rejection that reaches a THROW (as opposed to a `rejected` list
 * entry) is a plain `Error` naming which requirement failed, matching
 * `worktreeManager.ts` / `ingest.ts`'s convention.
 */
export async function buildProjectIndex(
  input: BuildProjectIndexInput,
  io: ProjectScanIo,
): Promise<{ index: ProjectIndex; rejected: readonly RejectedDir[] }> {
  const { roots, aliases = {} } = input;

  if (roots.length === 0) {
    throw new Error(
      'buildProjectIndex: roots must not be empty — an empty allowlist is a configuration error',
    );
  }

  const rejected: RejectedDir[] = [];
  const scanned: ScannedProject[] = [];

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await io.realpath(root);
    } catch {
      rejected.push({ path: root, reason: 'ROOT_NOT_FOUND' });
      continue;
    }

    let children: readonly string[];
    try {
      children = await io.listDirectories(realRoot);
    } catch {
      // Root resolved but is not a usable/listable directory (e.g. it is a
      // file, or is unreadable) — see the module doc comment's
      // "Build-report semantics" section for why this folds into
      // ROOT_NOT_FOUND rather than a third rejection reason.
      rejected.push({ path: root, reason: 'ROOT_NOT_FOUND' });
      continue;
    }

    for (const child of sortByBasename(children)) {
      let realChild: string;
      try {
        realChild = await io.realpath(child);
      } catch {
        // Vanished between listing and resolving, or a dangling symlink
        // with nothing at the far end to compare against the root prefix
        // at all — this is neither an escape (there is no resolved
        // target) nor a git repo. Skip silently, same spirit as
        // invariant 2.
        continue;
      }

      if (!isWithinRoot(realChild, realRoot)) {
        rejected.push({ path: child, reason: 'SYMLINK_ESCAPE' });
        continue;
      }

      const isRepo = await io.isGitRepo(realChild);
      if (!isRepo) {
        continue; // Invariant 2: silent skip, not a `rejected` entry.
      }

      scanned.push({ name: basename(child).trim().toLowerCase(), path: realChild });
    }
  }

  const rootNotFoundCount = rejected.filter((entry) => entry.reason === 'ROOT_NOT_FOUND').length;
  if (rootNotFoundCount === roots.length) {
    throw new Error(
      `buildProjectIndex: every configured root was rejected (${String(rootNotFoundCount)}/${String(roots.length)}) — an empty index is a configuration error`,
    );
  }

  // Alias validation (invariant 3, fail closed). Cheap pure-string checks
  // (duplicate key, name collision) run before any IO; the realpath-based
  // membership check runs last per alias.
  const seenAliasKeys = new Set<string>();
  const aliasesByPath = new Map<string, string[]>();

  for (const [rawKey, targetPath] of Object.entries(aliases)) {
    const normalizedKey = rawKey.trim().toLowerCase();

    if (seenAliasKeys.has(normalizedKey)) {
      throw new Error(
        `buildProjectIndex: alias ${JSON.stringify(rawKey)} collides with another configured alias ` +
          `after trim+lowercase normalization (both normalize to ${JSON.stringify(normalizedKey)})`,
      );
    }
    seenAliasKeys.add(normalizedKey);

    if (scanned.some((entry) => entry.name === normalizedKey)) {
      throw new Error(
        `buildProjectIndex: alias ${JSON.stringify(rawKey)} collides with a scanned project name ` +
          `after normalization (${JSON.stringify(normalizedKey)})`,
      );
    }

    let realTarget: string;
    try {
      realTarget = await io.realpath(targetPath);
    } catch (error) {
      throw new Error(
        `buildProjectIndex: alias ${JSON.stringify(rawKey)} target path ${JSON.stringify(targetPath)} ` +
          `could not be resolved (${describeError(error)}) — it must resolve to one of the scanned ` +
          'project paths',
        { cause: error },
      );
    }

    const matchedEntry = scanned.find((entry) => entry.path === realTarget);
    if (!matchedEntry) {
      throw new Error(
        `buildProjectIndex: alias ${JSON.stringify(rawKey)} target path ${JSON.stringify(targetPath)} ` +
          'is not among the scanned project paths',
      );
    }

    const aliasList = aliasesByPath.get(matchedEntry.path) ?? [];
    aliasList.push(normalizedKey);
    aliasesByPath.set(matchedEntry.path, aliasList);
  }

  const entries: ProjectEntry[] = scanned.map((entry) => ({
    name: entry.name,
    path: entry.path,
    aliases: aliasesByPath.get(entry.path) ?? [],
  }));

  const index: ProjectIndex = {
    entries,
    lookup(term: string): readonly ProjectEntry[] {
      // Invariant 5: never interpret `term` as a path.
      if (isPathFlavoredTerm(term)) {
        return [];
      }
      const normalized = term.trim().toLowerCase();
      if (normalized === '') {
        return [];
      }
      return entries.filter(
        (entry) => entry.name === normalized || entry.aliases.includes(normalized),
      );
    },
  };

  return { index, rejected };
}

// ---------------------------------------------------------------------------
// Production io wiring
// ---------------------------------------------------------------------------

/**
 * Wires real `node:fs/promises` reads and a real `git rev-parse --git-dir`
 * subprocess behind `ProjectScanIo`, for `daemon`/`cli` callers to plug
 * into `buildProjectIndex`. Follows the `buildDefaultWorktreeIo` /
 * `buildDefaultDoctorIo` precedent: the only place in this module that
 * touches the real filesystem or spawns a real process.
 */
export function buildDefaultProjectScanIo(): ProjectScanIo {
  return {
    realpath: (target) => fsRealpath(target),
    async listDirectories(dir) {
      const dirents = await readdir(dir, { withFileTypes: true });
      const result: string[] = [];
      for (const dirent of dirents) {
        const fullPath = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          result.push(fullPath);
          continue;
        }
        if (dirent.isSymbolicLink()) {
          try {
            const stats = await stat(fullPath); // follows the symlink
            if (stats.isDirectory()) {
              result.push(fullPath);
            }
          } catch {
            // Dangling symlink: not a directory candidate.
          }
        }
      }
      return result;
    },
    async isGitRepo(dir) {
      try {
        await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
