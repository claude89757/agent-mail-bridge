import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCoordinatorReadTools } from '../../src/application/coordinatorTools.js';
import type { ProjectIndex } from '../../src/application/projectIndex.js';
import { openDatabase } from '../../src/store/database.js';
import { SessionStore } from '../../src/store/sessionStore.js';

// Guards the coordination layer's batch-B read-only tools (ADR-0006). These
// are the values codex's coordinator agent sees via MCP, so every one is a
// red-line-2 boundary: the `list_sessions` view must carry a project's NAME
// (looked up from its path via the index), never the real projectPath,
// worktreePath, threadKey (a Message-ID — can carry a mail domain), or the
// codex driver session id. The serialized-output assertions are the
// load-bearing guard against any of those leaking.
//
// Fixture discipline: synthetic placeholder paths/ids only.

type Db = ReturnType<typeof openDatabase>;

const INDEX: ProjectIndex = {
  entries: [
    { name: 'blog', path: '/tmp/fixtures/private/blog', aliases: ['b', 'weblog'] },
    { name: 'api', path: '/tmp/fixtures/private/api', aliases: [] },
  ],
  lookup: () => [],
};

describe('buildCoordinatorReadTools (ADR-0006, coordination batch B)', () => {
  let db: Db;
  let sessions: SessionStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    sessions = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('listProjects', () => {
    it('returns path-free project views in index order', () => {
      const tools = buildCoordinatorReadTools({ index: INDEX, sessionStore: sessions });
      expect(tools.listProjects()).toEqual([
        { name: 'blog', aliases: ['b', 'weblog'] },
        { name: 'api', aliases: [] },
      ]);
    });
  });

  describe('listSessions', () => {
    it('redacts project path to its name and drops path/threadKey/worktree/driverId', () => {
      sessions.create({
        threadKey: '<t-1@mail.example>',
        projectPath: '/tmp/fixtures/private/blog',
        now: '2026-07-20T00:00:00.000Z',
      });
      const tools = buildCoordinatorReadTools({ index: INDEX, sessionStore: sessions });
      expect(tools.listSessions()).toEqual([
        {
          ref: '1',
          project: 'blog',
          hasStarted: false,
          startedAt: '2026-07-20T00:00:00.000Z',
          lastActivityAt: '2026-07-20T00:00:00.000Z',
        },
      ]);
    });

    it('marks hasStarted once a driver session id is recorded', () => {
      const created = sessions.create({
        threadKey: '<t-2@mail.example>',
        projectPath: '/tmp/fixtures/private/api',
        now: '2026-07-20T00:00:00.000Z',
      });
      sessions.recordDriverSessionId(created.id, '00000000-0000-4000-8000-000000000001', '2026-07-20T01:00:00.000Z');
      const view = buildCoordinatorReadTools({ index: INDEX, sessionStore: sessions }).listSessions()[0];
      expect(view?.hasStarted).toBe(true);
      expect(view?.project).toBe('api');
    });

    it('projects an out-of-index project path to null (never leaks the orphan path)', () => {
      sessions.create({
        threadKey: '<t-3@mail.example>',
        projectPath: '/tmp/fixtures/private/removed',
        now: '2026-07-20T00:00:00.000Z',
      });
      const view = buildCoordinatorReadTools({ index: INDEX, sessionStore: sessions }).listSessions()[0];
      expect(view?.project).toBeNull();
    });

    it('leaks no real path, worktree, threadKey, or driver id in serialized output', () => {
      const created = sessions.create({
        threadKey: '<secret-thread@mail.example>',
        projectPath: '/tmp/fixtures/private/blog',
        now: '2026-07-20T00:00:00.000Z',
      });
      sessions.recordDriverSessionId(created.id, 'drv-session-uuid-xyz', '2026-07-20T01:00:00.000Z');
      sessions.recordWorktreePath(created.id, '/tmp/fixtures/worktrees/wt-1', '2026-07-20T01:00:00.000Z');
      const serialized = JSON.stringify(
        buildCoordinatorReadTools({ index: INDEX, sessionStore: sessions }).listSessions(),
      );
      expect(serialized).not.toContain('/tmp/fixtures/private');
      expect(serialized).not.toContain('/tmp/fixtures/worktrees');
      expect(serialized).not.toContain('secret-thread');
      expect(serialized).not.toContain('drv-session-uuid-xyz');
    });
  });
});
