/**
 * Persistence for the `dispatch_intents` table (D-P2-9 schema v1, D-P2-10 API
 * shape). A dispatch intent is created at most once per command: `command_id`
 * is `UNIQUE NOT NULL REFERENCES commands(id)`, and `id` is itself the
 * primary key, so `createForCommand` reports `created: false` whether the
 * conflict is on the intent id or on the command id — both mean "an intent
 * for this command already exists in some form," which is exactly the
 * idempotency `ingestMail` (Task 8) relies on.
 *
 * Intent status on create is the fixed string `'PENDING'`; Phase 3 will
 * define the rest of the intent lifecycle (YAGNI — not modeled yet).
 */
import type { Database } from 'better-sqlite3';

/** Raw `dispatch_intents` row shape as returned by better-sqlite3 (snake_case). */
interface IntentRow {
  id: string;
  status: string;
  dry_run: number;
}

export interface IntentSummary {
  id: string;
  status: string;
  dryRun: boolean;
}

function rowToSummary(row: IntentRow): IntentSummary {
  return { id: row.id, status: row.status, dryRun: row.dry_run === 1 };
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
        `INSERT INTO dispatch_intents (id, command_id, status, dry_run, created_at)
         VALUES (@id, @commandId, 'PENDING', @dryRun, @now)
         ON CONFLICT DO NOTHING`,
      )
      .run({ id: intentId, commandId, dryRun: dryRun ? 1 : 0, now });

    return { created: result.changes === 1 };
  }

  getByCommandId(commandId: number): IntentSummary | null {
    const row = this.db
      .prepare<[number], IntentRow>(
        `SELECT id, status, dry_run FROM dispatch_intents WHERE command_id = ?`,
      )
      .get(commandId);
    return row ? rowToSummary(row) : null;
  }

  countAll(): number {
    const row = this.db
      .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM dispatch_intents`)
      .get();
    return row?.count ?? 0;
  }
}
