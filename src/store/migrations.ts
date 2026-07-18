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

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: SCHEMA_V1 },
  { version: 2, sql: SCHEMA_V2 },
];
