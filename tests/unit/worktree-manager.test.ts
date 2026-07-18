import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDefaultWorktreeIo,
  createTaskWorktree,
  removeTaskWorktree,
} from '../../src/application/worktreeManager.js';
import type { FsIo, GitIo } from '../../src/application/worktreeManager.js';

// Guards decision D-P3P-2 (bridge-owned worktree manager) / security control
// C7 (spec §3.4, threat-model.md C7): writes must happen ONLY inside
// worktrees the bridge itself creates from an explicit base commit, under a
// controlled root -- the user's own checkout and uncommitted changes must
// never be touched, and no branch the user owns may ever be mutated.
//
// Real-git integration tests below build a throwaway repo AND a throwaway
// worktrees root in mkdtemp for EVERY case, and clean both up in afterEach --
// this file NEVER touches the agent-mail-bridge repo itself. Git identity
// for the disposable fixture repo is an explicit LOCAL config using a
// placeholder address (bridge-user@example.com, RFC 2606's example.com),
// never the real global git identity on the machine running the suite (per
// AGENTS.md: no real emails in git, even in a throwaway temp repo) --
// commit.gpgsign is force-disabled for the same "never depend on this
// machine's ambient config" reason (a global gpgsign=true with no
// non-interactive key available would otherwise hang `git commit`).
//
// Fake-io unit tests below exercise every REJECT path (illegal taskId,
// missing repoRoot/worktreesRoot, non-repo, unresolvable baseRef, a crafted
// non-canonical realpath) without a real git binary, and pin invariant 6
// (no write-type git subcommand other than `worktree add`/`worktree remove`
// ever appears) via a full call-sequence assertion.

const SHA_40_HEX = /^[0-9a-f]{40}$/;

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Builds a real, throwaway git repo (already inside a mkdtemp directory)
 * with exactly one commit, and returns its REALPATH-resolved root plus the
 * facts the baseRef-form tests need: HEAD's sha, and the branch name HEAD is
 * actually on. The branch name is QUERIED, never assumed -- `git init`'s
 * default branch name depends on ambient `init.defaultBranch` config, which
 * this suite must not rely on (observed "master" on the dev machine used to
 * write this suite, with no global override; a CI runner could easily
 * differ).
 */
function initTestRepo(dir: string): { repoRoot: string; branch: string; headSha: string } {
  git(['init', '--quiet'], dir);
  git(['config', 'user.email', 'bridge-user@example.com'], dir);
  git(['config', 'user.name', 'Bridge Test'], dir);
  writeFileSync(join(dir, 'README.md'), 'placeholder\n');
  git(['add', 'README.md'], dir);
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'initial commit'], dir);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
  const headSha = git(['rev-parse', 'HEAD'], dir).trim();
  return { repoRoot: realpathSync(dir), branch, headSha };
}

// ---------------------------------------------------------------------------
// Real-git integration tests
// ---------------------------------------------------------------------------

describe('createTaskWorktree (D-P3P-2, C7) -- real git integration', () => {
  let repoDir: string;
  let worktreesDir: string;
  let repo: { repoRoot: string; branch: string; headSha: string };
  let io: GitIo & FsIo;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'amb-worktree-manager-repo-'));
    // Resolved ONCE here (not re-derived inline per test): on macOS
    // os.tmpdir() paths cross a /var -> /private/var symlink, so the raw
    // mkdtemp string and its realpath legitimately differ. Every test below
    // uses this already-resolved value, matching exactly what
    // `createTaskWorktree` itself resolves worktreesRoot to internally.
    worktreesDir = realpathSync(mkdtempSync(join(tmpdir(), 'amb-worktree-manager-wts-')));
    repo = initTestRepo(repoDir);
    io = buildDefaultWorktreeIo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  });

  it('creates a worktree under worktreesRoot/taskId with the committed file checked out, and returns a 40-hex baseCommit', async () => {
    const result = await createTaskWorktree(
      { repoRoot: repo.repoRoot, baseRef: repo.branch, worktreesRoot: worktreesDir, taskId: 'task-one' },
      io,
    );

    expect(result.worktreePath).toBe(join(worktreesDir, 'task-one'));
    expect(result.baseCommit).toBe(repo.headSha);
    expect(result.baseCommit).toMatch(SHA_40_HEX);
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(readFileSync(join(result.worktreePath, 'README.md'), 'utf8')).toBe('placeholder\n');

    const list = git(['worktree', 'list', '--porcelain'], repo.repoRoot);
    expect(list).toContain(result.worktreePath);
  });

  it('creates the worktree DETACHED: no new branch is created and the base branch is untouched', async () => {
    const branchesBefore = git(['branch', '--list'], repo.repoRoot);

    const result = await createTaskWorktree(
      { repoRoot: repo.repoRoot, baseRef: repo.branch, worktreesRoot: worktreesDir, taskId: 'task-detach' },
      io,
    );

    const branchesAfter = git(['branch', '--list'], repo.repoRoot);
    expect(branchesAfter).toBe(branchesBefore);

    const list = git(['worktree', 'list', '--porcelain'], repo.repoRoot);
    // porcelain output has a `detached` line for a --detach worktree and a
    // `branch refs/heads/...` line for a branch-carrying one.
    const entry = list.slice(list.indexOf(`worktree ${result.worktreePath}`));
    expect(entry).toContain('detached');
  });

  it('resolves baseRef given as a branch name to the explicit commit sha', async () => {
    const result = await createTaskWorktree(
      { repoRoot: repo.repoRoot, baseRef: repo.branch, worktreesRoot: worktreesDir, taskId: 'task-ref-branch' },
      io,
    );

    expect(result.baseCommit).toBe(repo.headSha);
  });

  it('resolves baseRef given as a full sha to the same explicit commit sha', async () => {
    const result = await createTaskWorktree(
      { repoRoot: repo.repoRoot, baseRef: repo.headSha, worktreesRoot: worktreesDir, taskId: 'task-ref-sha' },
      io,
    );

    expect(result.baseCommit).toBe(repo.headSha);
  });

  it('resolves baseRef given as HEAD to the same explicit commit sha', async () => {
    const result = await createTaskWorktree(
      { repoRoot: repo.repoRoot, baseRef: 'HEAD', worktreesRoot: worktreesDir, taskId: 'task-ref-head' },
      io,
    );

    expect(result.baseCommit).toBe(repo.headSha);
  });

  it('rejects when the target worktree path already exists, without invoking git worktree add', async () => {
    const targetPath = join(worktreesDir, 'task-collide');
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, 'marker.txt'), 'pre-existing\n');

    await expect(
      createTaskWorktree(
        { repoRoot: repo.repoRoot, baseRef: repo.branch, worktreesRoot: worktreesDir, taskId: 'task-collide' },
        io,
      ),
    ).rejects.toThrow(/already exists/);

    // untouched: still just our marker, never became a registered worktree
    expect(readFileSync(join(targetPath, 'marker.txt'), 'utf8')).toBe('pre-existing\n');
    const list = git(['worktree', 'list', '--porcelain'], repo.repoRoot);
    expect(list).not.toContain(targetPath);
  });

  it('resolves a symlinked worktreesRoot to its real target and creates the worktree there (legitimate symlink, not an escape)', async () => {
    const realTargetDir = realpathSync(mkdtempSync(join(tmpdir(), 'amb-worktree-manager-symreal-')));
    const linkParentDir = mkdtempSync(join(tmpdir(), 'amb-worktree-manager-symlink-'));
    const symlinkedWorktreesRoot = join(linkParentDir, 'worktrees-link');
    symlinkSync(realTargetDir, symlinkedWorktreesRoot, 'dir');

    try {
      const result = await createTaskWorktree(
        {
          repoRoot: repo.repoRoot,
          baseRef: repo.branch,
          worktreesRoot: symlinkedWorktreesRoot,
          taskId: 'task-symlink',
        },
        io,
      );

      // The RESOLVED (real) location is what gets returned/used, never the
      // symlink path itself.
      expect(result.worktreePath).toBe(join(realTargetDir, 'task-symlink'));
      expect(existsSync(result.worktreePath)).toBe(true);
      expect(readFileSync(join(result.worktreePath, 'README.md'), 'utf8')).toBe('placeholder\n');
    } finally {
      rmSync(realTargetDir, { recursive: true, force: true });
      rmSync(linkParentDir, { recursive: true, force: true });
    }
  });
});

describe('removeTaskWorktree (D-P3P-2, C7) -- real git integration', () => {
  let repoDir: string;
  let worktreesDir: string;
  let repo: { repoRoot: string; branch: string; headSha: string };
  let io: GitIo & FsIo;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'amb-worktree-manager-rm-repo-'));
    worktreesDir = realpathSync(mkdtempSync(join(tmpdir(), 'amb-worktree-manager-rm-wts-')));
    repo = initTestRepo(repoDir);
    io = buildDefaultWorktreeIo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  });

  it('propagates git\'s own failure when the worktree is dirty and force is not set; the worktree remains', async () => {
    const created = await createTaskWorktree(
      { repoRoot: repo.repoRoot, baseRef: repo.branch, worktreesRoot: worktreesDir, taskId: 'task-dirty' },
      io,
    );
    writeFileSync(join(created.worktreePath, 'untracked.txt'), 'dirty\n');

    await expect(
      removeTaskWorktree({ repoRoot: repo.repoRoot, worktreePath: created.worktreePath }, io),
    ).rejects.toThrow();

    expect(existsSync(created.worktreePath)).toBe(true);
    const list = git(['worktree', 'list', '--porcelain'], repo.repoRoot);
    expect(list).toContain(created.worktreePath);
  });

  it('removes a dirty worktree when force: true is passed', async () => {
    const created = await createTaskWorktree(
      { repoRoot: repo.repoRoot, baseRef: repo.branch, worktreesRoot: worktreesDir, taskId: 'task-dirty-force' },
      io,
    );
    writeFileSync(join(created.worktreePath, 'untracked.txt'), 'dirty\n');

    await removeTaskWorktree(
      { repoRoot: repo.repoRoot, worktreePath: created.worktreePath, force: true },
      io,
    );

    expect(existsSync(created.worktreePath)).toBe(false);
    const list = git(['worktree', 'list', '--porcelain'], repo.repoRoot);
    expect(list).not.toContain(created.worktreePath);
  });

  it('removes a CLEAN worktree without needing force', async () => {
    const created = await createTaskWorktree(
      { repoRoot: repo.repoRoot, baseRef: repo.branch, worktreesRoot: worktreesDir, taskId: 'task-clean' },
      io,
    );

    await removeTaskWorktree({ repoRoot: repo.repoRoot, worktreePath: created.worktreePath }, io);

    expect(existsSync(created.worktreePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fake-io unit tests
// ---------------------------------------------------------------------------

interface FakeIoHandlers {
  realpath?: (path: string) => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
  execFile?: (args: readonly string[], cwd: string) => Promise<{ stdout: string }>;
}

interface FakeIoHarness {
  io: GitIo & FsIo;
  realpathCalls: string[];
  existsCalls: string[];
  execFileCalls: { args: readonly string[]; cwd: string }[];
}

/**
 * A fully scripted `GitIo & FsIo` that records every call it receives, in
 * three separate arrays (one per method) so tests can assert "zero IO of ANY
 * kind happened" (the taskId-whitelist gate, invariant 1) as easily as "the
 * git call sequence was EXACTLY [...]" (invariant 6). Unregistered calls
 * throw loudly (never silently return a default), so a test that forgets to
 * script a call it doesn't expect fails with a clear "unexpected call"
 * message instead of silently passing.
 */
function fakeIo(handlers: FakeIoHandlers): FakeIoHarness {
  const realpathCalls: string[] = [];
  const existsCalls: string[] = [];
  const execFileCalls: { args: readonly string[]; cwd: string }[] = [];

  const io: GitIo & FsIo = {
    async realpath(path) {
      realpathCalls.push(path);
      if (handlers.realpath) {
        return handlers.realpath(path);
      }
      throw new Error(`fakeIo: unexpected realpath(${path})`);
    },
    async exists(path) {
      existsCalls.push(path);
      if (handlers.exists) {
        return handlers.exists(path);
      }
      return false;
    },
    async execFile(args, cwd) {
      execFileCalls.push({ args, cwd });
      if (handlers.execFile) {
        return handlers.execFile(args, cwd);
      }
      throw new Error(`fakeIo: unexpected execFile(${args.join(' ')})`);
    },
  };

  return { io, realpathCalls, existsCalls, execFileCalls };
}

const identityRealpath = (path: string): Promise<string> => Promise.resolve(path);

describe('createTaskWorktree -- taskId whitelist (invariant 1, fake io)', () => {
  it('rejects a taskId containing path separators, before any IO call', async () => {
    const { io, realpathCalls, existsCalls, execFileCalls } = fakeIo({});

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: '../x' },
        io,
      ),
    ).rejects.toThrow(/taskId/i);

    expect(realpathCalls).toEqual([]);
    expect(existsCalls).toEqual([]);
    expect(execFileCalls).toEqual([]);
  });

  it('rejects a taskId containing uppercase letters, before any IO call', async () => {
    const { io, realpathCalls, existsCalls, execFileCalls } = fakeIo({});

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: 'TASK' },
        io,
      ),
    ).rejects.toThrow(/taskId/i);

    expect(realpathCalls).toEqual([]);
    expect(existsCalls).toEqual([]);
    expect(execFileCalls).toEqual([]);
  });

  it('rejects a taskId containing an underscore, before any IO call', async () => {
    const { io, realpathCalls, existsCalls, execFileCalls } = fakeIo({});

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: 'a_b' },
        io,
      ),
    ).rejects.toThrow(/taskId/i);

    expect(realpathCalls).toEqual([]);
    expect(existsCalls).toEqual([]);
    expect(execFileCalls).toEqual([]);
  });

  it('rejects a taskId longer than 64 characters, before any IO call', async () => {
    const { io, realpathCalls, existsCalls, execFileCalls } = fakeIo({});
    const tooLong = 'a'.repeat(65);

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: tooLong },
        io,
      ),
    ).rejects.toThrow(/taskId/i);

    expect(realpathCalls).toEqual([]);
    expect(existsCalls).toEqual([]);
    expect(execFileCalls).toEqual([]);
  });

  it('rejects an empty taskId, before any IO call', async () => {
    const { io, realpathCalls, existsCalls, execFileCalls } = fakeIo({});

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: '' },
        io,
      ),
    ).rejects.toThrow(/taskId/i);

    expect(realpathCalls).toEqual([]);
    expect(existsCalls).toEqual([]);
    expect(execFileCalls).toEqual([]);
  });

  it('accepts a taskId at the 64-character boundary (does not reject on length alone)', async () => {
    const boundary = `a${'b'.repeat(63)}`; // 64 chars total
    expect(boundary).toHaveLength(64);
    const { io, execFileCalls } = fakeIo({
      realpath: identityRealpath,
      exists: () => Promise.resolve(false),
      execFile: (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') return Promise.resolve({ stdout: '.git\n' });
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return Promise.resolve({ stdout: `${'a'.repeat(40)}\n` });
        }
        if (args[0] === 'worktree' && args[1] === 'add') return Promise.resolve({ stdout: '' });
        throw new Error(`unexpected call: ${args.join(' ')}`);
      },
    });

    await createTaskWorktree(
      { repoRoot: '/fake/repo', baseRef: 'main', worktreesRoot: '/fake/worktrees', taskId: boundary },
      io,
    );

    expect(execFileCalls).toHaveLength(3);
  });
});

describe('createTaskWorktree -- repoRoot/worktreesRoot must exist (invariant 2, fake io)', () => {
  it('rejects when repoRoot does not exist (realpath rejects), before any git call', async () => {
    const { io, execFileCalls } = fakeIo({
      realpath: (path) => {
        if (path === '/fake/repo') {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return Promise.resolve(path);
      },
    });

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: 'task1' },
        io,
      ),
    ).rejects.toThrow(/repoRoot/);

    expect(execFileCalls).toEqual([]);
  });

  it('rejects when worktreesRoot does not exist (realpath rejects), before any git call', async () => {
    const { io, execFileCalls } = fakeIo({
      realpath: (path) => {
        if (path === '/fake/worktrees') {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return Promise.resolve(path);
      },
    });

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: 'task1' },
        io,
      ),
    ).rejects.toThrow(/worktreesRoot/);

    expect(execFileCalls).toEqual([]);
  });
});

describe('createTaskWorktree -- symlink-escape / prefix guard (invariant 2, fake io)', () => {
  it('rejects when a crafted (non-canonical) realpath would place the worktree path outside the resolved root, before any git call', async () => {
    // A real `fs.promises.realpath` NEVER returns a path containing ".." --
    // this fake simulates an io that lies about having fully resolved
    // worktreesRoot, proving the guard does NOT blindly trust the returned
    // value. Gate 1 (taskId whitelist) already makes a genuine escape via a
    // real, correctly-behaving realpath structurally impossible (taskId can
    // never contain "/" or ".."); this test is deliberately synthetic
    // defense-in-depth for that reason, not a reachable real-world path.
    const { io, execFileCalls } = fakeIo({
      realpath: (path) => {
        if (path === '/fake/worktrees') return Promise.resolve('/fake/worktrees/../escape');
        return Promise.resolve(path);
      },
    });

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: 'task1' },
        io,
      ),
    ).rejects.toThrow(/does not stay within/);

    expect(execFileCalls).toEqual([]);
  });
});

describe('createTaskWorktree -- repoRoot must be a git repository (invariant 3, fake io)', () => {
  it('rejects when repoRoot is not a git repository, and never attempts rev-parse --verify or worktree add', async () => {
    const { io, execFileCalls } = fakeIo({
      realpath: identityRealpath,
      exists: () => Promise.resolve(false),
      execFile: (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          return Promise.reject(new Error('fatal: not a git repository (or any parent up to mount point)'));
        }
        throw new Error(`unexpected further call: ${args.join(' ')}`);
      },
    });

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: 'task1' },
        io,
      ),
    ).rejects.toThrow(/not a git repository/);

    expect(execFileCalls).toHaveLength(1);
  });
});

describe('createTaskWorktree -- baseRef must resolve to an explicit commit (invariant 3, fake io)', () => {
  it('rejects when baseRef does not resolve, and never attempts worktree add', async () => {
    const { io, execFileCalls } = fakeIo({
      realpath: identityRealpath,
      exists: () => Promise.resolve(false),
      execFile: (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') return Promise.resolve({ stdout: '.git\n' });
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return Promise.reject(new Error('fatal: needs a single revision'));
        }
        throw new Error(`unexpected further call: ${args.join(' ')}`);
      },
    });

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'totally-bogus-ref', worktreesRoot: '/fake/worktrees', taskId: 'task1' },
        io,
      ),
    ).rejects.toThrow(/explicit base commit/);

    expect(execFileCalls).toHaveLength(2);
    expect(execFileCalls.every((c) => c.args[0] !== 'worktree')).toBe(true);
  });
});

describe('createTaskWorktree -- target-exists guard costs zero git calls (invariant 4, fake io)', () => {
  it('rejects when the target path already exists, without invoking any git subcommand', async () => {
    const { io, execFileCalls } = fakeIo({
      realpath: identityRealpath,
      exists: (path) => Promise.resolve(path === '/fake/worktrees/task1'),
    });

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'HEAD', worktreesRoot: '/fake/worktrees', taskId: 'task1' },
        io,
      ),
    ).rejects.toThrow(/already exists/);

    expect(execFileCalls).toEqual([]);
  });
});

describe('createTaskWorktree -- worktree add failure is wrapped (fake io)', () => {
  it('wraps a worktree-add failure with a module-attributed message', async () => {
    const { io } = fakeIo({
      realpath: identityRealpath,
      exists: () => Promise.resolve(false),
      execFile: (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') return Promise.resolve({ stdout: '.git\n' });
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return Promise.resolve({ stdout: `${'a'.repeat(40)}\n` });
        }
        if (args[0] === 'worktree' && args[1] === 'add') return Promise.reject(new Error('fatal: disk full'));
        throw new Error(`unexpected call: ${args.join(' ')}`);
      },
    });

    await expect(
      createTaskWorktree(
        { repoRoot: '/fake/repo', baseRef: 'main', worktreesRoot: '/fake/worktrees', taskId: 'task1' },
        io,
      ),
    ).rejects.toThrow(/git worktree add failed/);
  });
});

describe('createTaskWorktree -- call-sequence assertion (invariant 6, fake io)', () => {
  it('issues EXACTLY [rev-parse --git-dir, rev-parse --verify <ref>^{commit}, worktree add --detach <path> <sha>] on the happy path -- nothing else', async () => {
    const sha = 'a'.repeat(40);
    const { io, execFileCalls } = fakeIo({
      realpath: identityRealpath,
      exists: () => Promise.resolve(false),
      execFile: (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') return Promise.resolve({ stdout: '.git\n' });
        if (args[0] === 'rev-parse' && args[1] === '--verify') return Promise.resolve({ stdout: `${sha}\n` });
        if (args[0] === 'worktree' && args[1] === 'add') return Promise.resolve({ stdout: '' });
        throw new Error(`unexpected call: ${args.join(' ')}`);
      },
    });

    const result = await createTaskWorktree(
      { repoRoot: '/fake/repo', baseRef: 'main', worktreesRoot: '/fake/worktrees', taskId: 'task1' },
      io,
    );

    expect(execFileCalls.map((c) => c.args)).toEqual([
      ['rev-parse', '--git-dir'],
      ['rev-parse', '--verify', 'main^{commit}'],
      ['worktree', 'add', '--detach', '/fake/worktrees/task1', sha],
    ]);
    expect(result).toEqual({ worktreePath: '/fake/worktrees/task1', baseCommit: sha });
  });
});

describe('removeTaskWorktree -- fake io unit tests (D-P3P-2)', () => {
  it('calls exactly `worktree remove <path>`, without --force, by default', async () => {
    const { io, execFileCalls } = fakeIo({ execFile: () => Promise.resolve({ stdout: '' }) });

    await removeTaskWorktree({ repoRoot: '/fake/repo', worktreePath: '/fake/worktrees/task1' }, io);

    expect(execFileCalls).toEqual([
      { args: ['worktree', 'remove', '/fake/worktrees/task1'], cwd: '/fake/repo' },
    ]);
  });

  it('calls exactly `worktree remove <path>`, without --force, when force is explicitly false', async () => {
    const { io, execFileCalls } = fakeIo({ execFile: () => Promise.resolve({ stdout: '' }) });

    await removeTaskWorktree(
      { repoRoot: '/fake/repo', worktreePath: '/fake/worktrees/task1', force: false },
      io,
    );

    expect(execFileCalls).toEqual([
      { args: ['worktree', 'remove', '/fake/worktrees/task1'], cwd: '/fake/repo' },
    ]);
  });

  it('appends --force only when force: true is passed, as its own explicit call shape', async () => {
    const { io, execFileCalls } = fakeIo({ execFile: () => Promise.resolve({ stdout: '' }) });

    await removeTaskWorktree(
      { repoRoot: '/fake/repo', worktreePath: '/fake/worktrees/task1', force: true },
      io,
    );

    expect(execFileCalls).toEqual([
      { args: ['worktree', 'remove', '--force', '/fake/worktrees/task1'], cwd: '/fake/repo' },
    ]);
  });

  it('propagates the underlying git failure verbatim on a dirty-worktree rejection', async () => {
    const { io } = fakeIo({
      execFile: () => Promise.reject(new Error('fatal: is dirty, use --force')),
    });

    await expect(
      removeTaskWorktree({ repoRoot: '/fake/repo', worktreePath: '/fake/worktrees/task1' }, io),
    ).rejects.toThrow('fatal: is dirty, use --force');
  });
});

describe('buildDefaultWorktreeIo (D-P3P-2)', () => {
  it('builds a fresh io object on every call', () => {
    expect(buildDefaultWorktreeIo()).not.toBe(buildDefaultWorktreeIo());
  });

  it('wires a realpath that resolves a real, existing directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-worktree-manager-defaultio-'));
    try {
      const io = buildDefaultWorktreeIo();
      await expect(io.realpath(dir)).resolves.toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires an exists() that returns false for a path that does not exist and true for one that does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amb-worktree-manager-defaultio-exists-'));
    try {
      const io = buildDefaultWorktreeIo();
      await expect(io.exists(join(dir, 'nope'))).resolves.toBe(false);
      await expect(io.exists(dir)).resolves.toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
