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
 *
 * The pause flag (D-P5B12-2) is two more plain KV rows in the SAME `meta`
 * table — no migration: `paused` holds `'1'`/`'0'` (absent = not paused,
 * the fail-open-to-normal-operation default a fresh install needs), and
 * `pausedChangedAt` records when the flag last changed (the caller-supplied
 * `now`, this store's house convention for time). The daemon shell reads
 * `getPaused` once per poll round and the CLI writes `setPaused` — there is
 * no IPC, so a write takes effect within one poll interval, never
 * immediately.
 */
import type { Database } from 'better-sqlite3';

const READY_AT_KEY = 'readyAt';
const PAUSED_KEY = 'paused';
const PAUSED_CHANGED_AT_KEY = 'pausedChangedAt';

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

  /** `true` iff the `paused` meta row exists and holds `'1'` — an absent
   *  row (fresh install, pre-batch-12 database) reads as not paused. */
  getPaused(): boolean {
    const row = this.db
      .prepare<[string], { value: string }>(`SELECT value FROM meta WHERE key = ?`)
      .get(PAUSED_KEY);
    return row?.value === '1';
  }

  /**
   * Plain last-write-wins UPSERTs (unlike `setReadyAtIfUnset`'s
   * first-write-wins): pausing and resuming are ordinary reversible
   * operator actions. `now` lands in `pausedChangedAt` so `status` can
   * honestly report when the flag last changed.
   */
  setPaused(paused: boolean, now: string): void {
    const upsert = this.db.prepare<{ key: string; value: string }>(
      `INSERT INTO meta (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    upsert.run({ key: PAUSED_KEY, value: paused ? '1' : '0' });
    upsert.run({ key: PAUSED_CHANGED_AT_KEY, value: now });
  }

  /** When the pause flag last changed (`setPaused`'s `now`), or `null` if
   *  it was never touched — `amb status`'s read half of the doc promise
   *  above ("so `status` can honestly report when the flag last changed"). */
  getPausedChangedAt(): string | null {
    const row = this.db
      .prepare<[string], { value: string }>(`SELECT value FROM meta WHERE key = ?`)
      .get(PAUSED_CHANGED_AT_KEY);
    return row?.value ?? null;
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
   * Every `(mailbox, uidValidity)` watermark row, deterministically ordered
   * (D-P5B12-5) — `amb status`'s read surface; the daemon itself only ever
   * reads point-wise via `getWatermark`.
   */
  listWatermarks(): { mailbox: string; uidValidity: string; lastUid: number }[] {
    const rows = this.db
      .prepare<[], { mailbox: string; uidvalidity: string; last_uid: number }>(
        `SELECT mailbox, uidvalidity, last_uid FROM uid_watermark ORDER BY mailbox, uidvalidity`,
      )
      .all();
    return rows.map((row) => ({
      mailbox: row.mailbox,
      uidValidity: row.uidvalidity,
      lastUid: row.last_uid,
    }));
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
