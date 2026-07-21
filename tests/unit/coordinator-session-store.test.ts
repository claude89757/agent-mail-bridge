import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/store/database.js';
import { CoordinatorSessionStore } from '../../src/store/coordinatorSessionStore.js';

// CoordinatorSessionStore is the missing layer of ADR-0006's three-layer
// mapping (mail thread ↔ coordinator codex session ↔ execution session): it
// persists, per mail thread, the coordinator's OWN codex thread id so the next
// turn on that thread resumes the SAME conversation (ADR-0006: multi-turn
// coordination = `codex exec resume <thread_id>`; ADR-0004: that id is stable
// across resumes). Distinct from `agent_sessions`, which is per EXECUTION
// session and (since migration 006) may carry several rows per thread — the
// coordinator conversation is exactly one per thread, so thread_key is the
// PRIMARY KEY here.
//
// Test style follows the store suite: a real in-memory database (never a
// mock), fixed ISO instants so created/updated behavior is assertable.
// Fixture discipline (public repo): synthetic thread keys, low-entropy ids.

type Db = ReturnType<typeof openDatabase>;

const THREAD_A = 'thread-key-000a';
const THREAD_B = 'thread-key-000b';
const COORD_ID_1 = '00000000-0000-4000-8000-0000000000c1';
const COORD_ID_2 = '00000000-0000-4000-8000-0000000000c2';
const NOW_1 = '2026-07-20T00:00:00.000Z';
const NOW_2 = '2026-07-20T00:05:00.000Z';

let openDbs: Db[];

beforeEach(() => {
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
});

function store(): { db: Db; sessions: CoordinatorSessionStore } {
  const db = openDatabase(':memory:');
  openDbs.push(db);
  return { db, sessions: new CoordinatorSessionStore(db) };
}

function countRows(db: Db): number {
  const row = db
    .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM coordinator_sessions')
    .get();
  return row?.n ?? -1;
}

describe('CoordinatorSessionStore (ADR-0006 thread → coordinator codex thread)', () => {
  it('findByThreadKey returns undefined for an unseen thread', () => {
    const { sessions } = store();

    expect(sessions.findByThreadKey(THREAD_A)).toBeUndefined();
  });

  it('upsert inserts a fresh mapping; findByThreadKey reads it back with both timestamps = now', () => {
    const { sessions } = store();

    sessions.upsert(THREAD_A, COORD_ID_1, NOW_1);

    expect(sessions.findByThreadKey(THREAD_A)).toEqual({
      threadKey: THREAD_A,
      coordinatorThreadId: COORD_ID_1,
      createdAt: NOW_1,
      updatedAt: NOW_1,
    });
  });

  it('a second upsert on the same thread updates the id + updated_at but PRESERVES created_at, keeping one row', () => {
    const { db, sessions } = store();

    sessions.upsert(THREAD_A, COORD_ID_1, NOW_1);
    sessions.upsert(THREAD_A, COORD_ID_2, NOW_2);

    expect(sessions.findByThreadKey(THREAD_A)).toEqual({
      threadKey: THREAD_A,
      coordinatorThreadId: COORD_ID_2,
      createdAt: NOW_1,
      updatedAt: NOW_2,
    });
    // upsert, not append — the thread keeps exactly one coordinator row.
    expect(countRows(db)).toBe(1);
  });

  it('re-upserting the SAME id is idempotent on the id and only advances updated_at', () => {
    const { sessions } = store();

    sessions.upsert(THREAD_A, COORD_ID_1, NOW_1);
    sessions.upsert(THREAD_A, COORD_ID_1, NOW_2);

    expect(sessions.findByThreadKey(THREAD_A)).toEqual({
      threadKey: THREAD_A,
      coordinatorThreadId: COORD_ID_1,
      createdAt: NOW_1,
      updatedAt: NOW_2,
    });
  });

  it('distinct threads keep distinct coordinator ids', () => {
    const { db, sessions } = store();

    sessions.upsert(THREAD_A, COORD_ID_1, NOW_1);
    sessions.upsert(THREAD_B, COORD_ID_2, NOW_2);

    expect(sessions.findByThreadKey(THREAD_A)?.coordinatorThreadId).toBe(COORD_ID_1);
    expect(sessions.findByThreadKey(THREAD_B)?.coordinatorThreadId).toBe(COORD_ID_2);
    expect(countRows(db)).toBe(2);
  });
});
