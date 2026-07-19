/**
 * Persistence for the `clarification_requests` table (D-P4B4-3 migration
 * 003, D-P4B4-3 API shape) — the persistence half of threat-model control C8
 * (clarification binding: token + thread + candidate-set version + TTL,
 * `docs/threat-model.md`; the deterministic judgement half lives in
 * `src/domain/clarificationState.ts`'s `checkClarificationBinding`).
 *
 * `transition` re-enforces the D-P4B4-1 state machine
 * (`src/domain/clarificationState.ts`) just before persisting a status
 * change, exactly like `commandStore.updateStatus` (D-P2-2),
 * `outboxStore.transition` (D-P2-3) and `intentStore.transition` (D-P3P-4):
 * read current status, assert BEFORE writing, so an illegal transition
 * throws `IllegalTransitionError` and leaves the row untouched.
 *
 * `create` additionally enforces the D-P4B4-1 SUPERSEDED-before-insert
 * invariant, which none of the other three stores need an analogue of: a
 * command may have at most one PENDING clarification at a time. Re-issuing
 * (a fresh candidate set for the same command) transitions every existing
 * PENDING row for that `commandId` to SUPERSEDED (reason `'REISSUED'`)
 * BEFORE the new row is inserted, in ONE transaction — see `create`'s own
 * doc comment for why no explicit rollback code is needed to make that
 * atomic.
 *
 * `candidate_set_json` is opaque TEXT end to end here: this store never
 * parses or validates it — the candidate structure is Phase 4 proper's call
 * (plan's explicit scope cut), and doing anything with the JSON here would
 * assume a shape this batch has no business assuming.
 *
 * Statements are prepared fresh per call rather than cached as fields,
 * matching `commandStore.ts`'s documented rationale: inline preparation
 * keeps each method self-contained and fully inferred, and at
 * one-mail-at-a-time call volume the prepare() cost cannot matter.
 */
import type { Database } from 'better-sqlite3';

import {
  assertClarificationTransition,
  CLARIFICATION_STATUSES,
  type ClarificationStatus,
} from '../domain/clarificationState.js';

export interface ClarificationCreateInput {
  commandId: number;
  /**
   * Bridge-generated opaque token, stored verbatim. This store accepts ANY
   * string here, including `''` — the token GENERATOR (out of this batch;
   * the plan injects the randomness source at the caller) MUST assert
   * non-empty before calling, following `identity.ts`'s blank-guard
   * precedent: the domain's `===` binding check would happily match
   * `'' === ''`, so an empty token must never be persisted in the first
   * place.
   */
  token: string;
  threadKey: string;
  candidateSetJson: string;
  candidateSetVersion: number;
  /**
   * ISO 8601 instant in `.toISOString()` shape. Stored verbatim; later
   * compared LEXICOGRAPHICALLY against `now` by the domain's
   * `checkClarificationBinding` TTL check (readyAt-fence convention:
   * lexical order agrees with chronological order only inside the
   * fixed-width `.toISOString()` shape family). Doc-only producer contract,
   * no runtime shape validation — same stance as `readyAt`; a producer that
   * writes any other shape silently breaks TTL ordering.
   */
  expiresAt: string;
  /**
   * ISO 8601 instant in `.toISOString()` shape (same producer discipline as
   * `expiresAt`); becomes both `created_at` and `updated_at` of the new row.
   */
  now: string;
}

/** Raw `clarification_requests` row shape as returned by better-sqlite3 (snake_case). */
interface ClarificationRow {
  id: number;
  command_id: number;
  token: string;
  thread_key: string;
  candidate_set_json: string;
  candidate_set_version: number;
  expires_at: string;
  status: string;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClarificationSummary {
  id: number;
  commandId: number;
  token: string;
  threadKey: string;
  candidateSetJson: string;
  candidateSetVersion: number;
  expiresAt: string;
  status: ClarificationStatus;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const SELECT_COLUMNS = `id, command_id, token, thread_key, candidate_set_json, candidate_set_version, expires_at, status, status_reason, created_at, updated_at`;

function rowToSummary(row: ClarificationRow): ClarificationSummary {
  return {
    id: row.id,
    commandId: row.command_id,
    token: row.token,
    threadKey: row.thread_key,
    candidateSetJson: row.candidate_set_json,
    candidateSetVersion: row.candidate_set_version,
    expiresAt: row.expires_at,
    status: row.status as ClarificationStatus,
    statusReason: row.status_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ClarificationStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * D-P4B4-1 invariant, enforced HERE (not in the domain layer — see
   * `clarificationState.ts`'s SUPERSEDED doc comment for why the
   * enforcement point is deliberately the store, not the state machine):
   * inside ONE transaction, first transitions every existing PENDING row for
   * `input.commandId` to SUPERSEDED (reason `'REISSUED'`, `updated_at =
   * input.now`), THEN inserts the new row (status `'PENDING'`, `created_at =
   * updated_at = input.now`).
   *
   * Atomicity needs no explicit rollback code: `Database#transaction` wraps
   * both statements, and better-sqlite3 rolls back the ENTIRE callback on
   * any thrown exception — including a `thread_key` UNIQUE collision or a
   * `command_id` foreign-key violation on the INSERT that runs after the
   * supersede UPDATE already executed. So a failed re-issue can never leave
   * the old PENDING row half-superseded with no replacement; either both
   * writes land, or neither does.
   *
   * Re-selects the inserted row by `threadKey` (which is `UNIQUE NOT NULL`)
   * rather than trusting `RunResult.lastInsertRowid`, mirroring
   * `commandStore.insertIfAbsent`'s "insert then re-select by the row's own
   * unique business key" technique.
   */
  create(input: ClarificationCreateInput): ClarificationSummary {
    const run = this.db.transaction((): ClarificationSummary => {
      this.db
        .prepare<{ commandId: number; now: string }>(
          `UPDATE clarification_requests
           SET status = 'SUPERSEDED', status_reason = 'REISSUED', updated_at = @now
           WHERE command_id = @commandId AND status = 'PENDING'`,
        )
        .run({ commandId: input.commandId, now: input.now });

      this.db
        .prepare<{
          commandId: number;
          token: string;
          threadKey: string;
          candidateSetJson: string;
          candidateSetVersion: number;
          expiresAt: string;
          now: string;
        }>(
          `INSERT INTO clarification_requests
             (command_id, token, thread_key, candidate_set_json, candidate_set_version, expires_at, status, created_at, updated_at)
           VALUES
             (@commandId, @token, @threadKey, @candidateSetJson, @candidateSetVersion, @expiresAt, 'PENDING', @now, @now)`,
        )
        .run({
          commandId: input.commandId,
          token: input.token,
          threadKey: input.threadKey,
          candidateSetJson: input.candidateSetJson,
          candidateSetVersion: input.candidateSetVersion,
          expiresAt: input.expiresAt,
          now: input.now,
        });

      const row = this.getRowByThreadKey(input.threadKey);
      if (!row) {
        throw new Error(
          'clarificationStore.create: row vanished immediately after insert (unexpected)',
        );
      }
      return rowToSummary(row);
    });

    return run();
  }

  findByThreadKey(threadKey: string): ClarificationSummary | undefined {
    const row = this.getRowByThreadKey(threadKey);
    return row ? rowToSummary(row) : undefined;
  }

  /**
   * PENDING rows for `commandId`, ordered by id for deterministic results.
   * After `create`'s invariant this is 0 or 1 rows in practice — but the
   * schema itself has no partial-unique index enforcing that, so the return
   * type stays an array rather than `| undefined`: honest about what the
   * schema alone guarantees versus what this store's own write path happens
   * to maintain.
   */
  findPendingByCommandId(commandId: number): ClarificationSummary[] {
    const rows = this.db
      .prepare<[number], ClarificationRow>(
        `SELECT ${SELECT_COLUMNS} FROM clarification_requests
         WHERE command_id = ? AND status = 'PENDING' ORDER BY id`,
      )
      .all(commandId);
    return rows.map(rowToSummary);
  }

  /**
   * PENDING rows whose TTL has passed as of `now` (D-P4B10-3): `status =
   * 'PENDING' AND expires_at <= ?`, ordered by id — the input feed for the
   * daemon's EXPIRED sweep (who walks the PENDING → EXPIRED edge is the
   * daemon batch's call, per `clarificationState.ts`'s "WHO drives
   * PENDING -> EXPIRED" note; this store only answers the query).
   *
   * BOUNDARY (deliberately shared with `checkClarificationBinding`'s
   * `now >= expiresAt` rejection in `src/domain/clarificationState.ts`):
   * `<=`, so `now` exactly EQUAL to `expires_at` is already expired here —
   * the same fail-closed reading the binding check applies. One boundary,
   * two enforcement points: a row this sweep reports at instant T is
   * precisely a row the binding check would reject at T (test-pinned by the
   * shared-boundary case in `tests/unit/store-records.test.ts`), so the
   * sweep can never expire a clarification that a reply arriving the same
   * instant could still legally consume. Comparison is lexicographic over
   * `.toISOString()`-shaped strings — the `ClarificationCreateInput.expiresAt`
   * producer contract (SQLite's TEXT `<=` and JS string `>=` agree on
   * byte order, so the two sides compare identically).
   */
  findPendingExpiredBefore(now: string): ClarificationSummary[] {
    const rows = this.db
      .prepare<[string], ClarificationRow>(
        `SELECT ${SELECT_COLUMNS} FROM clarification_requests
         WHERE status = 'PENDING' AND expires_at <= ? ORDER BY id`,
      )
      .all(now);
    return rows.map(rowToSummary);
  }

  /**
   * Enforces D-P4B4-1 via `assertClarificationTransition` BEFORE writing: an
   * illegal transition throws `IllegalTransitionError` and the row is left
   * untouched (the UPDATE never runs). `now` follows the same
   * `.toISOString()` producer discipline as `ClarificationCreateInput.now`
   * and lands in `updated_at`.
   */
  transition(id: number, next: ClarificationStatus, reason: string | null, now: string): void {
    const current = this.getRowById(id);
    if (!current) {
      throw new Error(`clarificationStore.transition: no clarification request with id ${id}`);
    }

    assertClarificationTransition(current.status as ClarificationStatus, next);

    this.db
      .prepare<{ id: number; status: ClarificationStatus; reason: string | null; now: string }>(
        `UPDATE clarification_requests SET status = @status, status_reason = @reason, updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, status: next, reason, now });
  }

  /**
   * Row count per status, ZERO-FILLED over `CLARIFICATION_STATUSES`
   * (D-P5B12-5) — same stable-line rationale as
   * `commandStore.countByStatus`.
   */
  countByStatus(): Record<ClarificationStatus, number> {
    const counts = Object.fromEntries(
      CLARIFICATION_STATUSES.map((status) => [status, 0]),
    ) as Record<ClarificationStatus, number>;
    const rows = this.db
      .prepare<[], { status: string; count: number }>(
        `SELECT status, COUNT(*) AS count FROM clarification_requests GROUP BY status`,
      )
      .all();
    for (const row of rows) {
      counts[row.status as ClarificationStatus] = row.count;
    }
    return counts;
  }

  private getRowById(id: number): ClarificationRow | undefined {
    return this.db
      .prepare<[number], ClarificationRow>(
        `SELECT ${SELECT_COLUMNS} FROM clarification_requests WHERE id = ?`,
      )
      .get(id);
  }

  private getRowByThreadKey(threadKey: string): ClarificationRow | undefined {
    return this.db
      .prepare<[string], ClarificationRow>(
        `SELECT ${SELECT_COLUMNS} FROM clarification_requests WHERE thread_key = ?`,
      )
      .get(threadKey);
  }
}
