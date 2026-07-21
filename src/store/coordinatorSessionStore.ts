/**
 * Persistence for the `coordinator_sessions` table (migration 007) — the
 * missing layer of ADR-0006's three-layer mapping (mail thread ↔ coordinator
 * codex session ↔ execution session). One row PER MAIL THREAD holds the
 * coordinator's OWN codex thread id, so the next mail on that thread resumes
 * the SAME coordinator conversation (ADR-0006: multi-turn coordination =
 * `codex exec resume <thread_id>`). This is distinct from `agent_sessions`,
 * which is per EXECUTION session and — since migration 006 — may carry several
 * rows per thread; a mail thread has exactly ONE coordinator conversation, so
 * `thread_key` is the PRIMARY KEY.
 *
 * `upsert` is last-write-wins, NOT the first-write-stable invariant
 * `sessionStore.recordDriverSessionId` enforces. Rationale: the coordinator id
 * is not a safety boundary (dispatch still maps decisions back to the
 * allowlist, execution still runs on bridge-owned params). If a resume ever
 * failed and a fresh coordinator turn produced a new id, that new id MUST
 * replace the dead one — throwing would wedge the thread. Worst case of a
 * stale id is a resume miss, which degrades to the deterministic fallback
 * (`coordinateCommand`'s `fell-back`), never an unsafe action. The daemon only
 * calls `upsert` on a SUCCEEDED turn (a failed turn carries no id).
 *
 * `now` follows the `.toISOString()` doc-only producer discipline (the caller
 * passes an ISO 8601 instant; this store never validates the shape).
 * Statements are prepared per call, matching the rest of the store layer.
 */
import type { Database } from 'better-sqlite3';

/** Raw `coordinator_sessions` row shape (snake_case, from better-sqlite3). */
interface CoordinatorSessionRow {
  thread_key: string;
  coordinator_thread_id: string;
  created_at: string;
  updated_at: string;
}

export interface CoordinatorSessionSummary {
  threadKey: string;
  coordinatorThreadId: string;
  createdAt: string;
  updatedAt: string;
}

function rowToSummary(row: CoordinatorSessionRow): CoordinatorSessionSummary {
  return {
    threadKey: row.thread_key,
    coordinatorThreadId: row.coordinator_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CoordinatorSessionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  findByThreadKey(threadKey: string): CoordinatorSessionSummary | undefined {
    const row = this.db
      .prepare<[string], CoordinatorSessionRow>(
        `SELECT thread_key, coordinator_thread_id, created_at, updated_at
         FROM coordinator_sessions WHERE thread_key = ?`,
      )
      .get(threadKey);
    return row ? rowToSummary(row) : undefined;
  }

  /**
   * Insert the thread's coordinator id, or replace it on a thread already
   * seen — last-write-wins (see the module doc comment). `created_at` is
   * preserved across updates (first-seen time); only `coordinator_thread_id`
   * and `updated_at` move.
   */
  upsert(threadKey: string, coordinatorThreadId: string, now: string): void {
    this.db
      .prepare<{ threadKey: string; coordinatorThreadId: string; now: string }>(
        `INSERT INTO coordinator_sessions (thread_key, coordinator_thread_id, created_at, updated_at)
         VALUES (@threadKey, @coordinatorThreadId, @now, @now)
         ON CONFLICT(thread_key) DO UPDATE SET
           coordinator_thread_id = excluded.coordinator_thread_id,
           updated_at = excluded.updated_at`,
      )
      .run({ threadKey, coordinatorThreadId, now });
  }
}
