/**
 * Persistence for the `meta` and `uid_watermark` tables (D-P2-9 schema v1,
 * D-P2-10 API shape).
 *
 * `readyAt` is the first-install fence (D-P2-8): mail with `internalDate <
 * readyAt` is rejected so the bridge never acts on history from before it
 * was installed. `setReadyAtIfUnset` is deliberately write-once — the first
 * value recorded wins forever, matching the meaning of "when this bridge
 * first became ready."
 *
 * The UID high-water mark (D-P2-7) is scoped per `(mailbox, uidValidity)` and
 * only ever advances — `advanceWatermark` with a `uid` at or below the
 * current value is a no-op. A new `uidValidity` (the IMAP server invalidated
 * and reissued UIDs for the mailbox) starts back at 0, which is what lets a
 * bounded rescan happen safely instead of skipping mail.
 */
import type { Database } from 'better-sqlite3';

const READY_AT_KEY = 'readyAt';

export class MetaStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getReadyAt(): string | null {
    const row = this.db
      .prepare<[string], { value: string }>(`SELECT value FROM meta WHERE key = ?`)
      .get(READY_AT_KEY);
    return row?.value ?? null;
  }

  /**
   * `INSERT ... ON CONFLICT(key) DO NOTHING` then re-read: the first caller
   * to reach this wins and every later call (any `iso`) returns that same
   * first value, never overwriting it.
   */
  setReadyAtIfUnset(iso: string): string {
    this.db
      .prepare<{ key: string; iso: string }>(
        `INSERT INTO meta (key, value) VALUES (@key, @iso) ON CONFLICT(key) DO NOTHING`,
      )
      .run({ key: READY_AT_KEY, iso });

    const effective = this.getReadyAt();
    if (effective === null) {
      throw new Error('metaStore.setReadyAtIfUnset: readyAt missing immediately after upsert');
    }
    return effective;
  }

  getWatermark(mailbox: string, uidValidity: string): number {
    const row = this.db
      .prepare<[string, string], { last_uid: number }>(
        `SELECT last_uid FROM uid_watermark WHERE mailbox = ? AND uidvalidity = ?`,
      )
      .get(mailbox, uidValidity);
    return row?.last_uid ?? 0;
  }

  /**
   * UPSERT with `MAX(last_uid, excluded.last_uid)` semantics: advancing with
   * a `uid` at or below the stored value leaves the row unchanged.
   */
  advanceWatermark(mailbox: string, uidValidity: string, uid: number): void {
    this.db
      .prepare<{ mailbox: string; uidValidity: string; uid: number }>(
        `INSERT INTO uid_watermark (mailbox, uidvalidity, last_uid)
         VALUES (@mailbox, @uidValidity, @uid)
         ON CONFLICT(mailbox, uidvalidity) DO UPDATE SET last_uid = MAX(last_uid, excluded.last_uid)`,
      )
      .run({ mailbox, uidValidity, uid });
  }
}
