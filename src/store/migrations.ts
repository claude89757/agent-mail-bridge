/**
 * Schema migrations for the SQLite store (decision D-P2-9).
 *
 * Each entry is applied at most once, in ascending `version` order, inside a
 * single transaction that also bumps `PRAGMA user_version` — see
 * `openDatabase` in `./database.ts` for the runner.
 */

const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE uid_watermark (
  mailbox TEXT NOT NULL, uidvalidity TEXT NOT NULL, last_uid INTEGER NOT NULL,
  PRIMARY KEY (mailbox, uidvalidity)
) STRICT;
CREATE TABLE commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  status_reason TEXT,
  internal_date TEXT NOT NULL,
  uid INTEGER, uidvalidity TEXT,
  received_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE dispatch_intents (
  id TEXT PRIMARY KEY,
  command_id INTEGER NOT NULL UNIQUE REFERENCES commands(id),
  status TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  message_id TEXT UNIQUE,
  command_id INTEGER REFERENCES commands(id),
  kind TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
`;

// D-P3P-4 (Phase 3 prework plan batch 1): adds the two columns
// src/store/intentStore.ts's `transition` needs to persist a status change
// (status_reason mirrors commands.status_reason; updated_at mirrors
// commands.updated_at / outbox.updated_at). Both are nullable TEXT — STRICT
// tables accept nullable-column ADDs without a DEFAULT — and the single
// UPDATE backfills updated_at for every row that existed before this
// migration ran, so it is never NULL for a pre-existing row either.
const SCHEMA_V2 = `
ALTER TABLE dispatch_intents ADD COLUMN status_reason TEXT;
ALTER TABLE dispatch_intents ADD COLUMN updated_at TEXT;
UPDATE dispatch_intents SET updated_at = created_at;
`;

// D-P4B4-3 (Phase 4 batch 4 plan, docs/superpowers/plans/
// 2026-07-19-phase-4-batch4-clarification-binding.md): adds
// clarification_requests, the persistence half of threat-model control C8
// (clarification binding — token + thread + candidate-set version + TTL).
// The table is entirely new, so — like migration 001 and unlike migration
// 002 — this is CREATE-only, no ALTER/backfill. `src/store/
// clarificationStore.ts` is the only reader/writer; `candidate_set_json` is
// opaque TEXT there (never parsed by this bridge in this batch).
const SCHEMA_V3 = `
CREATE TABLE clarification_requests (
  id INTEGER PRIMARY KEY,
  command_id INTEGER NOT NULL REFERENCES commands(id),
  token TEXT NOT NULL,
  thread_key TEXT NOT NULL UNIQUE,
  candidate_set_json TEXT NOT NULL,
  candidate_set_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_clarification_command ON clarification_requests(command_id);
`;

// D-P4B7-2 (Phase 4 batch 7 plan, docs/superpowers/plans/
// 2026-07-19-phase-4-batch7-router-core.md): adds agent_sessions, the
// thread↔session mapping behind Phase 4 routing's CONTINUE_SESSION verdict
// (src/domain/routing.ts) — threat-model C8's "mail thread ↔ agent session"
// persistence. The table is entirely new, so like 003 this is CREATE-only,
// no ALTER/backfill. `src/store/sessionStore.ts` is the only reader/writer.
// driver_session_id is nullable BY DESIGN: the mapping row is created when
// a thread is first routed, BEFORE the driver's `thread.started` event
// supplies the id (ADR-0004's thread_id, stable across resumes).
// Deliberately NO foreign key to commands: one session spans MANY commands
// over its thread's lifetime (every reply on the thread is its own commands
// row), so there is no single owning command to reference — unlike
// clarification_requests above, which binds to exactly one command.
const SCHEMA_V4 = `
CREATE TABLE agent_sessions (
  id INTEGER PRIMARY KEY,
  thread_key TEXT NOT NULL UNIQUE,
  project_path TEXT NOT NULL,
  driver_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_path);
`;

// D-P4B8-1 (Phase 4 batch 8 plan, docs/superpowers/plans/
// 2026-07-19-phase-4-batch8-dispatch-pipeline.md): adds
// agent_sessions.worktree_path — resume MUST return to the ORIGINAL
// worktree (a codex session's working state lives in that tree), so the
// dispatch pipeline persists the path next to driver_session_id under the
// same first-write invariant (`sessionStore.recordWorktreePath`). The table
// already exists, so — like 002 and unlike 003/004 — this is an ALTER
// (STRICT tables accept a nullable-column ADD without a DEFAULT), and
// deliberately WITHOUT a backfill: a pre-005 row's worktree path was never
// recorded anywhere, so NULL is the truthful value — the dispatch pipeline
// fails closed on it (SESSION_STATE_INCOMPLETE) rather than guessing a
// path, and recovery policy for such partial rows belongs to the daemon
// batch.
const SCHEMA_V5 = `
ALTER TABLE agent_sessions ADD COLUMN worktree_path TEXT;
`;

/**
 * 006 (ADR-0006 coordination): drop `thread_key`'s UNIQUE constraint so ONE
 * mail thread can carry MORE THAN ONE agent session — the coordinator's
 * 旧线程换新任务 (a reply on an old thread that kicks off a fresh task,
 * `resolveCoordinatorDispatch`'s `new` mode). SQLite cannot drop an inline
 * column constraint, so the table is rebuilt WITHOUT `UNIQUE`. `agent_sessions`
 * has no foreign keys (pinned by store-records.test.ts) and the runner wraps
 * every migration in one transaction, so this create-copy-drop-rename is
 * atomic and safe. Column set / physical order / STRICT-ness / the project
 * index are preserved verbatim — only the constraint is gone. `sessionStore`'s
 * lookup gains `ORDER BY id DESC` so "the thread's session" now means its
 * LATEST row.
 */
const SCHEMA_V6 = `
CREATE TABLE agent_sessions_new (
  id INTEGER PRIMARY KEY,
  thread_key TEXT NOT NULL,
  project_path TEXT NOT NULL,
  driver_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  worktree_path TEXT
) STRICT;
INSERT INTO agent_sessions_new (id, thread_key, project_path, driver_session_id, created_at, updated_at, worktree_path)
  SELECT id, thread_key, project_path, driver_session_id, created_at, updated_at, worktree_path FROM agent_sessions;
DROP TABLE agent_sessions;
ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_path);
`;

/**
 * 007 (ADR-0006 coordination): the missing layer of the three-layer mapping
 * (mail thread ↔ coordinator codex session ↔ execution session). Persists,
 * per mail thread, the coordinator's OWN codex thread id so the next turn on
 * that thread RESUMES the same conversation (ADR-0006: multi-turn coordination
 * = `codex exec resume <thread_id>`; ADR-0004: that id is stable across
 * resumes). Exactly one coordinator conversation per thread, so `thread_key`
 * is the PRIMARY KEY — unlike `agent_sessions`, whose per-execution rows went
 * multi-per-thread in 006. No foreign key (same rationale as agent_sessions:
 * a thread outlives any single command/session).
 */
const SCHEMA_V7 = `
CREATE TABLE coordinator_sessions (
  thread_key TEXT PRIMARY KEY,
  coordinator_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
  { version: 3, sql: SCHEMA_V3 },
  { version: 4, sql: SCHEMA_V4 },
  { version: 5, sql: SCHEMA_V5 },
  { version: 6, sql: SCHEMA_V6 },
  { version: 7, sql: SCHEMA_V7 },
];
