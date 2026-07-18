import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDefaultProjectScanIo, buildProjectIndex } from '../../src/application/projectIndex.js';
import type { ProjectScanIo } from '../../src/application/projectIndex.js';

// Guards decisions D-P3B3-1..4 (spec §3.4 "项目发现") — the CORE invariant
// under test throughout this file is that mail can never name an arbitrary
// path: `ProjectIndex#lookup` only ever does an exact name/alias match, and
// every `.path` it can return was produced by realpath-ing a directory that
// this module itself found sitting directly under an operator-configured
// allowlisted root and confirmed to be a git repository. There is no path
// in `buildProjectIndex`'s logic where a `lookup` TERM (free text, as mail
// body content will eventually be) influences which directory gets
// scanned or what a `.path` resolves to.
//
// Real-git integration tests below build throwaway repos in mkdtemp for
// EVERY case and clean them up in afterEach — this file NEVER touches the
// agent-mail-bridge repo itself. Git identity for disposable fixture repos
// is an explicit LOCAL config using a placeholder address
// (bridge-user@example.com, RFC 2606's example.com), never the real global
// git identity on the machine running the suite (AGENTS.md: no real emails
// in git, even in a throwaway temp repo); commit.gpgsign is force-disabled
// for the same "never depend on this machine's ambient config" reason.
//
// Fake-io unit tests below exercise the alias-validation fail-closed paths,
// the path-flavored/empty lookup-term rejection (invariant 5), the
// roots-empty / all-roots-rejected throw rules (D-P3B3-4), and pin
// deterministic ordering (D-P3B3-3) plus the isGitRepo call-sequence
// (invariant 6) against a scripted `ProjectScanIo` — no real git binary.

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Creates `dir` (must not already exist) and returns it, for chaining into
 * `initGitRepo`. */
function makeSubdir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir);
  return dir;
}

/** Turns an already-existing directory into a real, minimal git repo (one
 * commit, placeholder committer identity — see file header). `isGitRepo`
 * only needs `git rev-parse --git-dir` to succeed, which holds immediately
 * after `git init` with zero commits; a commit is made anyway to mirror
 * `tests/unit/worktree-manager.test.ts`'s `initTestRepo` precedent and
 * AGENTS.md's "no real emails in git" rule as a matter of course. */
function initGitRepo(dir: string): void {
  git(['init', '--quiet'], dir);
  git(['config', 'user.email', 'bridge-user@example.com'], dir);
  git(['config', 'user.name', 'Bridge Test'], dir);
  writeFileSync(join(dir, 'README.md'), 'placeholder\n');
  git(['add', 'README.md'], dir);
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'initial commit'], dir);
}

/** Returns a path guaranteed not to exist: creates a real mkdtemp directory
 * (so it is unique and collision-free) then immediately removes it. Avoids
 * `Date.now()`/timestamp-based uniqueness per house convention. */
function nonexistentPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Real-git integration tests
// ---------------------------------------------------------------------------

describe('buildProjectIndex (D-P3B3-1..4) -- real git integration', () => {
  let root1: string;
  let root2: string;
  let io: ProjectScanIo;

  beforeEach(() => {
    // Resolved ONCE here (not re-derived inline per test): on macOS
    // os.tmpdir() paths cross a /var -> /private/var symlink, so the raw
    // mkdtemp string and its realpath legitimately differ. Matches
    // worktree-manager.test.ts's precedent.
    root1 = realpathSync(mkdtempSync(join(tmpdir(), 'amb-project-index-root1-')));
    root2 = realpathSync(mkdtempSync(join(tmpdir(), 'amb-project-index-root2-')));
    io = buildDefaultProjectScanIo();
  });

  afterEach(() => {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  });

  it('indexes git repos under both roots, skips non-git dirs silently, keeps duplicate names as separate entries, in root-then-lexicographic order', async () => {
    initGitRepo(makeSubdir(root1, 'alpha'));
    mkdirSync(join(root1, 'notes')); // non-git: must be skipped, not rejected
    initGitRepo(makeSubdir(root1, 'beta'));
    initGitRepo(makeSubdir(root2, 'alpha')); // duplicate name, different root

    const { index, rejected } = await buildProjectIndex({ roots: [root1, root2] }, io);

    expect(rejected).toEqual([]);
    expect(index.entries.map((e) => ({ name: e.name, path: e.path, aliases: e.aliases }))).toEqual([
      { name: 'alpha', path: join(root1, 'alpha'), aliases: [] },
      { name: 'beta', path: join(root1, 'beta'), aliases: [] },
      { name: 'alpha', path: join(root2, 'alpha'), aliases: [] },
    ]);

    const hits = index.lookup('alpha');
    expect(hits.map((e) => e.path)).toEqual([join(root1, 'alpha'), join(root2, 'alpha')]);

    // Case + trailing whitespace normalization (D-P3B3-3): same two hits,
    // same order.
    const hitsNormalized = index.lookup('ALPHA ');
    expect(hitsNormalized.map((e) => e.path)).toEqual([join(root1, 'alpha'), join(root2, 'alpha')]);

    // 'notes' is a real directory that exists but is not a git repo: it
    // never entered the index, so lookup finds nothing for it.
    expect(index.lookup('notes')).toEqual([]);
  });

  it('rejects a symlinked child pointing to a git repo OUTSIDE the root as SYMLINK_ESCAPE, never indexes it, and leaves the outside target untouched', async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'amb-project-index-outside-')));
    try {
      initGitRepo(outsideDir);
      const beforeContents = readdirSync(outsideDir).sort();
      const linkPath = join(root1, 'escaped');
      symlinkSync(outsideDir, linkPath, 'dir');

      const { index, rejected } = await buildProjectIndex({ roots: [root1] }, io);

      expect(rejected).toEqual([{ path: linkPath, reason: 'SYMLINK_ESCAPE' }]);
      expect(index.entries).toEqual([]);
      expect(index.lookup('escaped')).toEqual([]);
      // Nothing was written into (or removed from) the outside directory —
      // scanning is read-only and the escape was rejected, not followed.
      expect(readdirSync(outsideDir).sort()).toEqual(beforeContents);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a missing root as ROOT_NOT_FOUND while still indexing the other valid root', async () => {
    const missingRoot = nonexistentPath('amb-project-index-missing-');
    initGitRepo(makeSubdir(root1, 'alpha'));

    const { index, rejected } = await buildProjectIndex({ roots: [missingRoot, root1] }, io);

    expect(rejected).toEqual([{ path: missingRoot, reason: 'ROOT_NOT_FOUND' }]);
    expect(index.entries.map((e) => e.name)).toEqual(['alpha']);
    expect(index.entries.map((e) => e.path)).toEqual([join(root1, 'alpha')]);
  });

  it('validates and attaches an alias pointing to a real scanned project path', async () => {
    const alphaDir = makeSubdir(root1, 'alpha');
    initGitRepo(alphaDir);
    const alphaRealPath = realpathSync(alphaDir);

    const { index } = await buildProjectIndex(
      { roots: [root1], aliases: { a1: alphaRealPath } },
      io,
    );

    const hits = index.lookup('a1');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe(alphaRealPath);
    expect(hits[0]?.name).toBe('alpha');
    expect(hits[0]?.aliases).toEqual(['a1']);
  });
});

// ---------------------------------------------------------------------------
// Fake-io unit tests
// ---------------------------------------------------------------------------

interface FakeScanIoHandlers {
  realpath?: (path: string) => Promise<string>;
  listDirectories?: (dir: string) => Promise<readonly string[]>;
  isGitRepo?: (dir: string) => Promise<boolean>;
}

interface FakeScanIoHarness {
  io: ProjectScanIo;
  realpathCalls: string[];
  listDirectoriesCalls: string[];
  isGitRepoCalls: string[];
}

/**
 * A scripted `ProjectScanIo` that records every call in three separate
 * arrays (one per method), mirroring worktree-manager.test.ts's `fakeIo`
 * harness. Defaults (when a handler is omitted): `realpath` is identity,
 * `listDirectories` returns `[]`, `isGitRepo` returns `false` — chosen so a
 * test that only cares about ONE root/child doesn't need to script
 * behavior for paths it never touches.
 */
function fakeScanIo(handlers: FakeScanIoHandlers): FakeScanIoHarness {
  const realpathCalls: string[] = [];
  const listDirectoriesCalls: string[] = [];
  const isGitRepoCalls: string[] = [];

  const io: ProjectScanIo = {
    async realpath(path) {
      realpathCalls.push(path);
      if (handlers.realpath) return handlers.realpath(path);
      return path;
    },
    async listDirectories(dir) {
      listDirectoriesCalls.push(dir);
      if (handlers.listDirectories) return handlers.listDirectories(dir);
      return [];
    },
    async isGitRepo(dir) {
      isGitRepoCalls.push(dir);
      if (handlers.isGitRepo) return handlers.isGitRepo(dir);
      return false;
    },
  };

  return { io, realpathCalls, listDirectoriesCalls, isGitRepoCalls };
}

/** A single root ('/root1') with two candidate git-repo children ('alpha',
 * 'beta'), for tests that don't care about the scanning details and just
 * need a populated index to validate aliases/lookup against. */
function fakeScanIoWithAlphaBeta(): FakeScanIoHarness {
  return fakeScanIo({
    listDirectories: (dir) =>
      dir === '/root1' ? Promise.resolve(['/root1/alpha', '/root1/beta']) : Promise.resolve([]),
    isGitRepo: (dir) => Promise.resolve(dir === '/root1/alpha' || dir === '/root1/beta'),
  });
}

describe('buildProjectIndex -- alias validation fail-closed (invariant 3, fake io)', () => {
  it('throws when an alias target path is not among the scanned project paths', async () => {
    const { io } = fakeScanIoWithAlphaBeta();

    await expect(
      buildProjectIndex({ roots: ['/root1'], aliases: { a1: '/root1/does-not-exist' } }, io),
    ).rejects.toThrow(/not among the scanned project paths/);
  });

  it('throws when an alias key collides with a scanned project name after trim+lowercase normalization', async () => {
    const { io } = fakeScanIoWithAlphaBeta();

    await expect(
      buildProjectIndex({ roots: ['/root1'], aliases: { ' Alpha ': '/root1/alpha' } }, io),
    ).rejects.toThrow(/collides with a scanned project name/);
  });

  it('throws when two configured alias keys collide with each other after trim+lowercase normalization', async () => {
    const { io } = fakeScanIoWithAlphaBeta();

    await expect(
      buildProjectIndex(
        { roots: ['/root1'], aliases: { A1: '/root1/alpha', a1: '/root1/beta' } },
        io,
      ),
    ).rejects.toThrow(/collides with another configured alias/);
  });

  it('attaches a validated alias to its target entry, normalized to trim+lowercase', async () => {
    const { io } = fakeScanIoWithAlphaBeta();

    const { index } = await buildProjectIndex(
      { roots: ['/root1'], aliases: { ' A1 ': '/root1/alpha' } },
      io,
    );

    const hits = index.lookup('a1');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe('alpha');
    expect(hits[0]?.aliases).toEqual(['a1']);
    // The other entry is unaffected.
    expect(index.lookup('beta')[0]?.aliases).toEqual([]);
  });

  it('does not throw and requires no aliases when `aliases` is omitted entirely', async () => {
    const { io } = fakeScanIoWithAlphaBeta();

    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.entries.every((e) => e.aliases.length === 0)).toBe(true);
  });
});

describe('buildProjectIndex -- lookup never interprets term as a path (invariant 5, fake io)', () => {
  it('rejects a term containing ".." and returns [] without matching anything', async () => {
    const { io } = fakeScanIoWithAlphaBeta();
    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.lookup('../x')).toEqual([]);
  });

  it('rejects a term containing a forward slash and returns [] without matching anything', async () => {
    const { io } = fakeScanIoWithAlphaBeta();
    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.lookup('a/b')).toEqual([]);
  });

  it('rejects a term containing a backslash and returns [] without matching anything', async () => {
    const { io } = fakeScanIoWithAlphaBeta();
    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.lookup('a\\b')).toEqual([]);
  });

  it('rejects a term containing an embedded NUL byte and returns [] without matching anything', async () => {
    const { io } = fakeScanIoWithAlphaBeta();
    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.lookup('a\0b')).toEqual([]);
  });

  it('returns [] for a term with no path-flavored characters that simply matches nothing (e.g. contains a space)', async () => {
    const { io } = fakeScanIoWithAlphaBeta();
    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.lookup('a b')).toEqual([]);
  });

  it('returns [] for an empty term', async () => {
    const { io } = fakeScanIoWithAlphaBeta();
    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.lookup('')).toEqual([]);
  });

  it('returns [] for a whitespace-only term', async () => {
    const { io } = fakeScanIoWithAlphaBeta();
    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.lookup('   ')).toEqual([]);
  });

  it('still rejects a path-flavored term even when it would otherwise resemble a configured name (proves the syntax check runs before any comparison)', async () => {
    const { io } = fakeScanIo({
      listDirectories: (dir) => (dir === '/root1' ? Promise.resolve(['/root1/a']) : Promise.resolve([])),
      isGitRepo: () => Promise.resolve(true),
    });
    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.entries.map((e) => e.name)).toEqual(['a']);
    // 'a/b' contains the real name 'a' as a substring/prefix, but the
    // path-flavor guard must reject it outright rather than ever comparing.
    expect(index.lookup('a/b')).toEqual([]);
  });
});

describe('buildProjectIndex -- symlink escape, fake io (invariant 1, defense in depth)', () => {
  it('rejects a candidate whose realpath a crafted io reports as OUTSIDE the root, and never asks whether it is a git repo', async () => {
    // Mirrors worktree-manager.test.ts's "crafted (non-canonical) realpath"
    // defense-in-depth test: proves the containment check does not blindly
    // trust listDirectories to have only ever returned in-root candidates.
    const { io, isGitRepoCalls } = fakeScanIo({
      listDirectories: (dir) => (dir === '/root1' ? Promise.resolve(['/root1/escape']) : Promise.resolve([])),
      realpath: (path) => {
        if (path === '/root1/escape') return Promise.resolve('/outside/escape');
        return Promise.resolve(path);
      },
    });

    const { index, rejected } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(rejected).toEqual([{ path: '/root1/escape', reason: 'SYMLINK_ESCAPE' }]);
    expect(index.entries).toEqual([]);
    expect(isGitRepoCalls).toEqual([]);
  });
});

describe('buildProjectIndex -- non-git directories are skipped silently (invariant 2, fake io)', () => {
  it('is not present in entries or rejected when a candidate directory is not a git repo', async () => {
    const { io } = fakeScanIo({
      listDirectories: (dir) => (dir === '/root1' ? Promise.resolve(['/root1/notes']) : Promise.resolve([])),
      isGitRepo: () => Promise.resolve(false),
    });

    const { index, rejected } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.entries).toEqual([]);
    expect(rejected).toEqual([]);
  });
});

describe('buildProjectIndex -- duplicate names across roots (invariant 4, fake io)', () => {
  it('keeps both same-named entries from different roots and lookup returns both, in roots-param order', async () => {
    const { io } = fakeScanIo({
      listDirectories: (dir) => {
        if (dir === '/root1') return Promise.resolve(['/root1/dup']);
        if (dir === '/root2') return Promise.resolve(['/root2/dup']);
        return Promise.resolve([]);
      },
      isGitRepo: () => Promise.resolve(true),
    });

    const { index } = await buildProjectIndex({ roots: ['/root1', '/root2'] }, io);

    expect(index.entries.map((e) => e.path)).toEqual(['/root1/dup', '/root2/dup']);
    expect(index.lookup('dup').map((e) => e.path)).toEqual(['/root1/dup', '/root2/dup']);
  });
});

describe('buildProjectIndex -- call-sequence assertion (invariant 6, fake io)', () => {
  it('calls isGitRepo exactly once per candidate directory that passed the containment check, in root-then-lexicographic order, and nothing else beyond realpath/listDirectories', async () => {
    const { io, realpathCalls, listDirectoriesCalls, isGitRepoCalls } = fakeScanIo({
      listDirectories: (dir) => {
        if (dir === '/root1') return Promise.resolve(['/root1/zeta', '/root1/alpha']); // deliberately unsorted
        return Promise.resolve([]);
      },
      isGitRepo: () => Promise.resolve(true),
    });

    await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(listDirectoriesCalls).toEqual(['/root1']);
    // isGitRepo is called in SORTED (alpha, then zeta) order, not the raw
    // listDirectories order.
    expect(isGitRepoCalls).toEqual(['/root1/alpha', '/root1/zeta']);
    expect(realpathCalls).toEqual(['/root1', '/root1/alpha', '/root1/zeta']);
  });

  it('never calls isGitRepo for a directory rejected as SYMLINK_ESCAPE', async () => {
    const { io, isGitRepoCalls } = fakeScanIo({
      listDirectories: (dir) => (dir === '/root1' ? Promise.resolve(['/root1/escape']) : Promise.resolve([])),
      realpath: (path) => (path === '/root1/escape' ? Promise.resolve('/outside/escape') : Promise.resolve(path)),
    });

    await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(isGitRepoCalls).toEqual([]);
  });
});

describe('buildProjectIndex -- deterministic ordering (D-P3B3-3, fake io)', () => {
  it('sorts candidate directories lexicographically by name within a root, regardless of the order listDirectories returns them', async () => {
    const { io } = fakeScanIo({
      listDirectories: (dir) =>
        dir === '/root1' ? Promise.resolve(['/root1/zeta', '/root1/alpha', '/root1/mid']) : Promise.resolve([]),
      isGitRepo: () => Promise.resolve(true),
    });

    const { index } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.entries.map((e) => e.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('orders entries by roots param order first, then lexicographic name within each root', async () => {
    const { io } = fakeScanIo({
      listDirectories: (dir) => {
        if (dir === '/root2') return Promise.resolve(['/root2/bbb']);
        if (dir === '/root1') return Promise.resolve(['/root1/yyy', '/root1/aaa']);
        return Promise.resolve([]);
      },
      isGitRepo: () => Promise.resolve(true),
    });

    const { index } = await buildProjectIndex({ roots: ['/root2', '/root1'] }, io);

    expect(index.entries.map((e) => e.name)).toEqual(['bbb', 'aaa', 'yyy']);
    // lookup's hit order follows entries order too.
    expect(index.lookup('aaa').map((e) => e.name)).toEqual(['aaa']);
  });
});

describe('buildProjectIndex -- build-report throw rules (D-P3B3-4, fake io)', () => {
  it('throws when roots is an empty array', async () => {
    const { io } = fakeScanIo({});

    await expect(buildProjectIndex({ roots: [] }, io)).rejects.toThrow(/roots/i);
  });

  it('throws when every configured root fails to resolve (all ROOT_NOT_FOUND)', async () => {
    const { io } = fakeScanIo({
      realpath: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    });

    await expect(buildProjectIndex({ roots: ['/missing1', '/missing2'] }, io)).rejects.toThrow(/root/i);
  });

  it('does NOT throw when only some roots are rejected; valid roots are still scanned', async () => {
    const { io } = fakeScanIo({
      realpath: (path) =>
        path === '/missing'
          ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          : Promise.resolve(path),
      listDirectories: (dir) => (dir === '/root1' ? Promise.resolve(['/root1/alpha']) : Promise.resolve([])),
      isGitRepo: () => Promise.resolve(true),
    });

    const { index, rejected } = await buildProjectIndex({ roots: ['/missing', '/root1'] }, io);

    expect(rejected).toEqual([{ path: '/missing', reason: 'ROOT_NOT_FOUND' }]);
    expect(index.entries.map((e) => e.name)).toEqual(['alpha']);
  });

  it('does NOT throw when a valid root simply contains zero git repositories (legitimately empty index)', async () => {
    const { io } = fakeScanIo({
      listDirectories: (dir) => (dir === '/root1' ? Promise.resolve(['/root1/notes']) : Promise.resolve([])),
      isGitRepo: () => Promise.resolve(false),
    });

    const { index, rejected } = await buildProjectIndex({ roots: ['/root1'] }, io);

    expect(index.entries).toEqual([]);
    expect(rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDefaultProjectScanIo
// ---------------------------------------------------------------------------

describe('buildDefaultProjectScanIo (D-P3B3-1)', () => {
  it('builds a fresh io object on every call', () => {
    expect(buildDefaultProjectScanIo()).not.toBe(buildDefaultProjectScanIo());
  });

  it('realpath resolves a real, existing directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-project-index-defaultio-'));
    try {
      const io = buildDefaultProjectScanIo();
      await expect(io.realpath(dir)).resolves.toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listDirectories returns direct child directories only, excluding files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-project-index-defaultio-listdir-'));
    try {
      mkdirSync(join(dir, 'child-dir'));
      writeFileSync(join(dir, 'child-file.txt'), 'x');
      const io = buildDefaultProjectScanIo();
      const result = await io.listDirectories(dir);
      expect(result).toEqual([join(dir, 'child-dir')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listDirectories includes a symlink pointing to a directory, and excludes a dangling symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-project-index-defaultio-symlink-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'amb-project-index-defaultio-target-'));
    try {
      symlinkSync(targetDir, join(dir, 'link-to-dir'), 'dir');
      symlinkSync(join(dir, 'does-not-exist'), join(dir, 'dangling'), 'dir');
      const io = buildDefaultProjectScanIo();
      const result = await io.listDirectories(dir);
      expect(result).toEqual([join(dir, 'link-to-dir')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('listDirectories excludes a symlink pointing to a plain file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-project-index-defaultio-symlinkfile-'));
    try {
      writeFileSync(join(dir, 'a-file.txt'), 'x');
      symlinkSync(join(dir, 'a-file.txt'), join(dir, 'link-to-file'), 'file');
      const io = buildDefaultProjectScanIo();
      const result = await io.listDirectories(dir);
      expect(result).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isGitRepo resolves true for a real git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-project-index-defaultio-gitrepo-'));
    try {
      git(['init', '--quiet'], dir);
      const io = buildDefaultProjectScanIo();
      await expect(io.isGitRepo(dir)).resolves.toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isGitRepo resolves false for a plain (non-git) directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-project-index-defaultio-plaindir-'));
    try {
      const io = buildDefaultProjectScanIo();
      await expect(io.isGitRepo(dir)).resolves.toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isGitRepo resolves false (never rejects) for a directory that does not exist', async () => {
    const missing = nonexistentPath('amb-project-index-defaultio-missing-');
    const io = buildDefaultProjectScanIo();
    await expect(io.isGitRepo(missing)).resolves.toBe(false);
  });
});
