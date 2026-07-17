/**
 * Persistence for the `commands` table (D-P2-9 schema v1, D-P2-10 API shape).
 *
 * Re-enforces the D-P2-2 command state machine (`src/domain/commandState.ts`)
 * just before persisting a status change: `updateStatus` calls
 * `assertCommandTransition` BEFORE issuing the UPDATE, so an illegal
 * transition throws `IllegalTransitionError` and leaves the row untouched.
 *
 * Statements are prepared fresh per call rather than cached as fields: each
 * call site gets its own precise generic instantiation (no erasure through a
 * stored field type), and query volume here is far below where prepare()
 * overhead would matter.
 */
import type { Database } from 'better-sqlite3';

import { assertCommandTransition, type CommandStatus } from '../domain/commandState.js';

export interface CommandRecordInput {
  messageId: string;
  status: CommandStatus;
  statusReason: string | null;
  internalDate: string;
  uid: number | null;
  uidValidity: string | null;
  now: string;
}

export interface CommandRecord extends CommandRecordInput {
  id: number;
  receivedAt: string;
  updatedAt: string;
}

/** Raw `commands` row shape as returned by better-sqlite3 (snake_case). */
interface CommandRow {
  id: number;
  message_id: string;
  status: string;
  status_reason: string | null;
  internal_date: string;
  uid: number | null;
  uidvalidity: string | null;
  received_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `id, message_id, status, status_reason, internal_date, uid, uidvalidity, received_at, updated_at`;

/**
 * snake_case row -> camelCase record. `now` has no dedicated column: it
 * mirrors `updated_at`, the most recent caller-supplied "current time" this
 * row has seen (equal to `received_at` right after insert).
 */
function rowToRecord(row: CommandRow): CommandRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    status: row.status as CommandStatus,
    statusReason: row.status_reason,
    internalDate: row.internal_date,
    uid: row.uid,
    uidValidity: row.uidvalidity,
    now: row.updated_at,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

export class CommandStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Race-free within one connection: `ON CONFLICT(message_id) DO NOTHING`
   * either inserts (changes === 1) or leaves the existing row alone
   * (changes === 0), then a single SELECT reads back the row either way —
   * so the caller always gets the row that is actually persisted, whether
   * this call created it or a previous call did.
   */
  insertIfAbsent(input: CommandRecordInput): { inserted: boolean; record: CommandRecord } {
    const result = this.db
      .prepare<CommandRecordInput>(
        `INSERT INTO commands
           (message_id, status, status_reason, internal_date, uid, uidvalidity, received_at, updated_at)
         VALUES
           (@messageId, @status, @statusReason, @internalDate, @uid, @uidValidity, @now, @now)
         ON CONFLICT(message_id) DO NOTHING`,
      )
      .run(input);

    const record = this.getByMessageId(input.messageId);
    if (!record) {
      throw new Error(
        'commandStore.insertIfAbsent: no row for messageId after insert attempt (unexpected)',
      );
    }

    return { inserted: result.changes === 1, record };
  }

  /**
   * Enforces D-P2-2 via `assertCommandTransition` BEFORE writing: an illegal
   * transition throws `IllegalTransitionError` and the row is left
   * untouched (the UPDATE never runs).
   */
  updateStatus(id: number, next: CommandStatus, reason: string | null, now: string): CommandRecord {
    const current = this.getRowById(id);
    if (!current) {
      throw new Error(`commandStore.updateStatus: no command with id ${id}`);
    }

    assertCommandTransition(current.status as CommandStatus, next);

    this.db
      .prepare<{ id: number; status: CommandStatus; statusReason: string | null; now: string }>(
        `UPDATE commands SET status = @status, status_reason = @statusReason, updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, status: next, statusReason: reason, now });

    const updated = this.getRowById(id);
    if (!updated) {
      throw new Error(`commandStore.updateStatus: command ${id} vanished after update (unexpected)`);
    }
    return rowToRecord(updated);
  }

  getByMessageId(messageId: string): CommandRecord | null {
    const row = this.db
      .prepare<[string], CommandRow>(`SELECT ${SELECT_COLUMNS} FROM commands WHERE message_id = ?`)
      .get(messageId);
    return row ? rowToRecord(row) : null;
  }

  private getRowById(id: number): CommandRow | undefined {
    return this.db
      .prepare<[number], CommandRow>(`SELECT ${SELECT_COLUMNS} FROM commands WHERE id = ?`)
      .get(id);
  }
}
