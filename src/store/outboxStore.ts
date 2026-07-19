/**
 * Persistence for the `outbox` table (D-P2-9 schema v1, D-P2-10 API shape).
 *
 * Re-enforces the D-P2-3 outbox state machine (`src/domain/outboxState.ts`)
 * just before persisting a status change: `transition` calls
 * `assertOutboxTransition` BEFORE issuing the UPDATE, so an illegal
 * transition throws `IllegalTransitionError` and leaves the row untouched.
 *
 * `isKnownOutboxId`/`isKnownOutboxMessageId` back the D-P2-4 echo gate: an
 * inbound mail is our own echo iff its `x-amb-outbox-id` header matches a
 * known outbox id, or its Message-ID matches a known outbox `message_id` —
 * both recorded here BEFORE any send is attempted (`create` inserts with
 * status `PENDING`).
 */
import type { Database } from 'better-sqlite3';

import { assertOutboxTransition, type OutboxStatus } from '../domain/outboxState.js';

export type OutboxKind = 'ACK' | 'RESULT' | 'CLARIFICATION' | 'ERROR';

export interface OutboxEntryInput {
  id: string;
  messageId: string;
  commandId: number | null;
  kind: OutboxKind;
  now: string;
}

/** Raw `outbox` row shape as returned by better-sqlite3 (snake_case). */
interface OutboxRow {
  id: string;
  message_id: string | null;
  command_id: number | null;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * camelCase view of one `outbox` row (D-P4B10-3), mapping the EXISTING row
 * shape 1:1 — no new columns, this batch only adds the read surface.
 * `messageId` stays `string | null` because the COLUMN is nullable, even
 * though `create` (above) always writes one — honest about what the schema
 * alone guarantees, same stance as
 * `clarificationStore.findPendingByCommandId`'s array return.
 */
export interface OutboxSummary {
  id: string;
  messageId: string | null;
  commandId: number | null;
  kind: OutboxKind;
  status: OutboxStatus;
  createdAt: string;
  updatedAt: string;
}

function rowToSummary(row: OutboxRow): OutboxSummary {
  return {
    id: row.id,
    messageId: row.message_id,
    commandId: row.command_id,
    kind: row.kind as OutboxKind,
    status: row.status as OutboxStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OutboxStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Inserts a new outbox row with status `PENDING`. */
  create(entry: OutboxEntryInput): void {
    this.db
      .prepare<{
        id: string;
        messageId: string;
        commandId: number | null;
        kind: OutboxKind;
        now: string;
      }>(
        `INSERT INTO outbox (id, message_id, command_id, kind, status, created_at, updated_at)
         VALUES (@id, @messageId, @commandId, @kind, 'PENDING', @now, @now)`,
      )
      .run(entry);
  }

  /**
   * Enforces D-P2-3 via `assertOutboxTransition` BEFORE writing: an illegal
   * transition throws `IllegalTransitionError` and the row is left
   * untouched (the UPDATE never runs).
   */
  transition(id: string, next: OutboxStatus, now: string): void {
    const current = this.getRowById(id);
    if (!current) {
      throw new Error(`outboxStore.transition: no outbox entry with id ${id}`);
    }

    assertOutboxTransition(current.status as OutboxStatus, next);

    this.db
      .prepare<{ id: string; status: OutboxStatus; now: string }>(
        `UPDATE outbox SET status = @status, updated_at = @now WHERE id = @id`,
      )
      .run({ id, status: next, now });
  }

  /**
   * All outbox rows currently in `status`, ordered by id for deterministic
   * results (D-P4B10-3) — the input feed for the daemon's UNCERTAIN
   * reconciliation sweep (`findByStatus('UNCERTAIN')`; whether/how the
   * sweep confirms a send is the daemon batch's call, this store only
   * answers the query).
   */
  findByStatus(status: OutboxStatus): OutboxSummary[] {
    const rows = this.db
      .prepare<[string], OutboxRow>(
        `SELECT id, message_id, command_id, kind, status, created_at, updated_at
         FROM outbox WHERE status = ? ORDER BY id`,
      )
      .all(status);
    return rows.map(rowToSummary);
  }

  isKnownOutboxId(id: string): boolean {
    return this.getRowById(id) !== undefined;
  }

  isKnownOutboxMessageId(messageId: string): boolean {
    const row = this.db
      .prepare<[string], { id: string }>(`SELECT id FROM outbox WHERE message_id = ?`)
      .get(messageId);
    return row !== undefined;
  }

  private getRowById(id: string): OutboxRow | undefined {
    return this.db
      .prepare<[string], OutboxRow>(
        `SELECT id, message_id, command_id, kind, status, created_at, updated_at
         FROM outbox WHERE id = ?`,
      )
      .get(id);
  }
}
