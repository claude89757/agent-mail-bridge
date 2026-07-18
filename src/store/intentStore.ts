/**
 * Persistence for the `dispatch_intents` table (D-P2-9 schema v1 + D-P3P-4
 * migration 002, D-P2-10 / D-P3P-4 API shape). A dispatch intent is created
 * at most once per command: `command_id` is `UNIQUE NOT NULL REFERENCES
 * commands(id)`, and `id` is itself the primary key, so `createForCommand`
 * reports `created: false` whether the conflict is on the intent id or on
 * the command id — both mean "an intent for this command already exists in
 * some form," which is exactly the idempotency `ingestMail` (Task 8) relies
 * on.
 *
 * Intent status on create is the fixed string `'PENDING'`. `transition`
 * (D-P3P-4) re-enforces the `src/domain/intentState.ts` state machine just
 * before persisting a status change, exactly like `commandStore.updateStatus`
 * (D-P2-2) and `outboxStore.transition` (D-P2-3): read current status,
 * assert BEFORE writing, so an illegal transition throws
 * `IllegalTransitionError` and leaves the row untouched.
 *
 * `updated_at` is set at INSERT time (mirroring `created_at`, exactly like
 * `commands.received_at`/`updated_at` in `commandStore.insertIfAbsent`) and
 * on every `transition` call, so it is never NULL for a row written by this
 * store — migration 002's backfill (`updated_at = created_at`) gives the
 * same guarantee for rows that existed before the column did.
 */
import type { Database } from 'better-sqlite3';

import { assertIntentTransition, type IntentStatus } from '../domain/intentState.js';

/** Raw `dispatch_intents` row shape as returned by better-sqlite3 (snake_case). */
interface IntentRow {
  id: string;
  status: string;
  dry_run: number;
  status_reason: string | null;
  updated_at: string;
}

export interface IntentSummary {
  id: string;
  status: string;
  dryRun: boolean;
  statusReason: string | null;
  updatedAt: string;
}

const SELECT_COLUMNS = `id, status, dry_run, status_reason, updated_at`;

function rowToSummary(row: IntentRow): IntentSummary {
  return {
    id: row.id,
    status: row.status,
    dryRun: row.dry_run === 1,
    statusReason: row.status_reason,
    updatedAt: row.updated_at,
  };
}

export class IntentStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * `ON CONFLICT DO NOTHING` with no explicit target matches ANY constraint
   * violation on this INSERT — both the `id` primary key and the
   * `command_id` UNIQUE index — so a duplicate intent id and a second,
   * different intent id for an already-intent-bearing command both land
   * here as `changes === 0` rather than throwing.
   */
  createForCommand(
    intentId: string,
    commandId: number,
    dryRun: boolean,
    now: string,
  ): { created: boolean } {
    const result = this.db
      .prepare<{ id: string; commandId: number; dryRun: number; now: string }>(
        `INSERT INTO dispatch_intents (id, command_id, status, dry_run, created_at, updated_at)
         VALUES (@id, @commandId, 'PENDING', @dryRun, @now, @now)
         ON CONFLICT DO NOTHING`,
      )
      .run({ id: intentId, commandId, dryRun: dryRun ? 1 : 0, now });

    return { created: result.changes === 1 };
  }

  /**
   * Enforces D-P3P-4 via `assertIntentTransition` BEFORE writing: an illegal
   * transition throws `IllegalTransitionError` and the row is left untouched
   * (the UPDATE never runs).
   *
   * `reason` is deliberately `string | null` rather than required: a
   * COMPLETED transition may carry no reason (`null`), while a FAILED
   * transition is expected to carry one (e.g. an agent-task error, or the
   * fixed `'INTERRUPTED_BY_RESTART'` from the crash-recovery contract
   * documented in `intentState.ts`) — this store does not enforce that
   * pairing, it only persists whatever the caller supplies.
   */
  transition(id: string, next: IntentStatus, reason: string | null, now: string): void {
    const current = this.getRowById(id);
    if (!current) {
      throw new Error(`intentStore.transition: no intent with id ${id}`);
    }

    assertIntentTransition(current.status as IntentStatus, next);

    this.db
      .prepare<{ id: string; status: IntentStatus; reason: string | null; now: string }>(
        `UPDATE dispatch_intents SET status = @status, status_reason = @reason, updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, status: next, reason, now });
  }

  getByCommandId(commandId: number): IntentSummary | null {
    const row = this.db
      .prepare<[number], IntentRow>(
        `SELECT ${SELECT_COLUMNS} FROM dispatch_intents WHERE command_id = ?`,
      )
      .get(commandId);
    return row ? rowToSummary(row) : null;
  }

  /** Round-trips a single intent by id; `undefined` (not `null`) when missing. */
  getById(id: string): IntentSummary | undefined {
    const row = this.getRowById(id);
    return row ? rowToSummary(row) : undefined;
  }

  /** All intents currently in `status`, ordered by id for deterministic results. */
  findByStatus(status: IntentStatus): IntentSummary[] {
    const rows = this.db
      .prepare<[string], IntentRow>(
        `SELECT ${SELECT_COLUMNS} FROM dispatch_intents WHERE status = ? ORDER BY id`,
      )
      .all(status);
    return rows.map(rowToSummary);
  }

  countAll(): number {
    const row = this.db
      .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM dispatch_intents`)
      .get();
    return row?.count ?? 0;
  }

  private getRowById(id: string): IntentRow | undefined {
    return this.db
      .prepare<[string], IntentRow>(`SELECT ${SELECT_COLUMNS} FROM dispatch_intents WHERE id = ?`)
      .get(id);
  }
}
