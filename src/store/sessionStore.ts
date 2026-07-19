/**
 * Persistence for the `agent_sessions` table (D-P4B7-2 migration 004) — the
 * thread↔session mapping behind Phase 4 routing's CONTINUE_SESSION verdict
 * (`src/domain/routing.ts`): the router looks a thread up here by
 * `threadKey` and feeds the result into `routeCommand` as
 * `existingSession`.
 *
 * Lifecycle: `create` inserts the mapping with `driver_session_id` AND
 * `worktree_path` both NULL — the row exists as soon as a thread is first
 * routed to a project, BEFORE the worktree is created and BEFORE the
 * driver's `thread.started` event supplies its session id.
 * `recordDriverSessionId` then performs a FIRST-WRITE-ONLY fill-in: ADR-0004
 * established (measured, not assumed) that `codex exec resume` re-emits the
 * SAME thread_id across resumes, so a thread's driver session id, once
 * recorded, must never change — a different id showing up is an anomaly
 * (upstream bug or identity confusion) and throws rather than silently
 * replacing the mapping. `recordWorktreePath` (D-P4B8-1, migration 005) is
 * the same invariant over the session's worktree location: resume MUST
 * return to the ORIGINAL worktree (a codex session's working state lives in
 * that tree), so the path, once recorded, never silently drifts either — a
 * worktreesRoot config change that moves paths needs explicit handling in
 * the daemon batch, never an overwrite here. Both are called by the
 * dispatch pipeline (`src/application/dispatch.ts`): worktree path right
 * after `createTaskWorktree`, driver session id after `startTask` hands
 * back a non-null session id.
 *
 * Deliberately NO foreign key to `commands`: one session spans MANY
 * commands over its thread's lifetime (every reply on the thread is its own
 * `commands` row), so there is no single owning command to reference —
 * unlike `clarification_requests`, which binds to exactly one command. See
 * the migration 004 comment in `./migrations.ts`.
 *
 * `now` fields follow the `.toISOString()` doc-only producer discipline
 * (readyAt precedent): the caller passes an ISO 8601 instant, this store
 * never validates the shape.
 *
 * Statements are prepared fresh per call rather than cached as fields,
 * matching `commandStore.ts`'s documented rationale: inline preparation
 * keeps each method self-contained and fully inferred, and at
 * one-mail-at-a-time call volume the prepare() cost cannot matter.
 */
import type { Database } from 'better-sqlite3';

export interface SessionCreateInput {
  threadKey: string;
  /**
   * The project this thread is bound to. MUST be a realpath'd path that
   * came out of the project index (`projectIndex.ts`'s core invariant: no
   * other path source exists for anything mail-adjacent) — this store
   * persists it verbatim and `listByProject` compares it by exact string
   * equality, so an unnormalized path would silently split one project
   * into two.
   */
  projectPath: string;
  /**
   * ISO 8601 instant in `.toISOString()` shape (doc-only producer
   * discipline, see the module doc comment); becomes both `created_at` and
   * `updated_at` of the new row.
   */
  now: string;
}

/** Raw `agent_sessions` row shape as returned by better-sqlite3 (snake_case). */
interface SessionRow {
  id: number;
  thread_key: string;
  project_path: string;
  driver_session_id: string | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary {
  id: number;
  threadKey: string;
  projectPath: string;
  /** NULL until the first dispatch's `thread.started` is recorded. */
  driverSessionId: string | null;
  /** NULL until the first dispatch's worktree creation is recorded
   *  (D-P4B8-1) — and NULL forever on rows that predate migration 005 (no
   *  backfill; the dispatch pipeline fails closed on such rows). */
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

const SELECT_COLUMNS = `id, thread_key, project_path, driver_session_id, worktree_path, created_at, updated_at`;

function rowToSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    threadKey: row.thread_key,
    projectPath: row.project_path,
    driverSessionId: row.driver_session_id,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Inserts a fresh mapping with `driver_session_id` NULL (the session
   * exists before `thread.started` — see the module doc comment). A
   * `thread_key` collision throws (SQLite UNIQUE violation propagates
   * untouched): the router only calls `create` after `findByThreadKey`
   * returned nothing, so a duplicate create for the same thread is an
   * upstream bug — fail closed, never merge or overwrite.
   *
   * Re-selects the inserted row by `threadKey` (UNIQUE NOT NULL) rather
   * than trusting `RunResult.lastInsertRowid`, mirroring
   * `commandStore.insertIfAbsent` / `clarificationStore.create`'s "insert
   * then re-select by the row's own unique business key" technique.
   */
  create(input: SessionCreateInput): SessionSummary {
    this.db
      .prepare<{ threadKey: string; projectPath: string; now: string }>(
        `INSERT INTO agent_sessions (thread_key, project_path, driver_session_id, created_at, updated_at)
         VALUES (@threadKey, @projectPath, NULL, @now, @now)`,
      )
      .run({ threadKey: input.threadKey, projectPath: input.projectPath, now: input.now });

    const row = this.getRowByThreadKey(input.threadKey);
    if (!row) {
      throw new Error('sessionStore.create: row vanished immediately after insert (unexpected)');
    }
    return rowToSummary(row);
  }

  findByThreadKey(threadKey: string): SessionSummary | undefined {
    const row = this.getRowByThreadKey(threadKey);
    return row ? rowToSummary(row) : undefined;
  }

  /**
   * First-write invariant (D-P4B7-2), read-assert-write like the
   * transition guards in `commandStore`/`intentStore`/`clarificationStore`
   * (D-P2-2 precedent) — assert BEFORE writing, so a rejected call leaves
   * the row untouched:
   *
   *   - current value NULL          -> write it (updated_at = now);
   *   - current value === incoming  -> idempotent: refresh updated_at only;
   *   - current value !== incoming  -> throw — a thread's driver session id
   *     is stable across resumes (ADR-0004, measured), so a different id
   *     can only mean an upstream bug; never silently replace the mapping;
   *   - id unknown                  -> throw.
   */
  recordDriverSessionId(id: number, driverSessionId: string, now: string): void {
    const current = this.getRowById(id);
    if (!current) {
      throw new Error(`sessionStore.recordDriverSessionId: no agent session with id ${id}`);
    }

    if (current.driver_session_id !== null && current.driver_session_id !== driverSessionId) {
      throw new Error(
        `sessionStore.recordDriverSessionId: agent session ${id} already has driver session id ` +
          `${current.driver_session_id}; refusing to replace it with ${driverSessionId} ` +
          `(driver session identity is stable per thread — ADR-0004)`,
      );
    }

    this.db
      .prepare<{ id: number; driverSessionId: string; now: string }>(
        `UPDATE agent_sessions SET driver_session_id = @driverSessionId, updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, driverSessionId, now });
  }

  /**
   * First-write invariant over `worktree_path` (D-P4B8-1), same four
   * branches as `recordDriverSessionId` above — read-assert-write, so a
   * rejected call leaves the row untouched:
   *
   *   - current value NULL          -> write it (updated_at = now);
   *   - current value === incoming  -> idempotent: refresh updated_at only;
   *   - current value !== incoming  -> throw — resume must return to the
   *     ORIGINAL worktree (the codex session's working state lives in that
   *     tree), so a different path can only mean an upstream bug or an
   *     unhandled worktreesRoot move; never silently redirect the session;
   *   - id unknown                  -> throw.
   */
  recordWorktreePath(id: number, worktreePath: string, now: string): void {
    const current = this.getRowById(id);
    if (!current) {
      throw new Error(`sessionStore.recordWorktreePath: no agent session with id ${id}`);
    }

    if (current.worktree_path !== null && current.worktree_path !== worktreePath) {
      throw new Error(
        `sessionStore.recordWorktreePath: agent session ${id} already has worktree path ` +
          `${current.worktree_path}; refusing to replace it with ${worktreePath} ` +
          `(resume must return to the original worktree — D-P4B8-1)`,
      );
    }
    this.db
      .prepare<{ id: number; worktreePath: string; now: string }>(
        `UPDATE agent_sessions SET worktree_path = @worktreePath, updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, worktreePath, now });
  }

  /** All sessions mapped to `projectPath`, ordered by id (creation order). */
  listByProject(projectPath: string): SessionSummary[] {
    const rows = this.db
      .prepare<[string], SessionRow>(
        `SELECT ${SELECT_COLUMNS} FROM agent_sessions WHERE project_path = ? ORDER BY id`,
      )
      .all(projectPath);
    return rows.map(rowToSummary);
  }

  private getRowById(id: number): SessionRow | undefined {
    return this.db
      .prepare<[number], SessionRow>(`SELECT ${SELECT_COLUMNS} FROM agent_sessions WHERE id = ?`)
      .get(id);
  }

  private getRowByThreadKey(threadKey: string): SessionRow | undefined {
    return this.db
      .prepare<[string], SessionRow>(
        `SELECT ${SELECT_COLUMNS} FROM agent_sessions WHERE thread_key = ?`,
      )
      .get(threadKey);
  }
}
