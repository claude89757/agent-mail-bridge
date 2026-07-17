# Phase 2 — 可靠事件核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, crash-safe mail-event core: idempotent ingest (Message-ID unique), SYSTEM_ECHO loop guard, `readyAt` fence, strict self-address gate (C1), time-window queueing, transactional dispatch-intent creation, and a transactional outbox skeleton — proven under duplicate delivery, reordering and crash injection with a fake transport.

**Architecture:** Pure decision logic in `src/domain/` (no IO, clock passed in); persistence behind `src/store/` (better-sqlite3, ADR-0001, WAL, single writer); the `ingestMail` use case in `src/application/` runs the whole gate chain inside ONE SQLite transaction. Real IMAP/SMTP stays out of Phase 2 — a `FakeMailTransport` test helper drives everything. Zero model calls anywhere in this pipeline (MVP acceptance).

**Tech Stack:** TypeScript strict ESM, better-sqlite3, vitest.

**Spec exit criteria (§5 Phase 2):** under simulated IMAP, duplicate delivery / reordering / crash-restart produce no duplicate commands; self-sent system replies are recognized as echo 100%.

---

## Locked design decisions

Subagents implement exactly this; deviations require coming back to the orchestrator.

### D-P2-1 Message-ID normalization (idempotency key)

`normalizeMessageId(raw)`: trim → strip ONE outer `<...>` pair if present → must be non-empty and contain `@`, else `null`. Case is preserved. Missing/invalid Message-ID ⇒ command is stored with synthetic key `synthetic:<uidValidity>:<uid>` and status `REJECTED` / reason `NO_MESSAGE_ID` (fail closed, still idempotent per UID).

### D-P2-2 Command states (Phase 2 subset)

```
RECEIVED → SYSTEM_ECHO   (terminal; loop guard hit)
RECEIVED → REJECTED      (terminal; reason ∈ NO_MESSAGE_ID | BEFORE_READY | IDENTITY_FROM | IDENTITY_TO | IDENTITY_CC | IDENTITY_MULTI_RECIPIENT | IDENTITY_PLUS_TAG)
RECEIVED → QUEUED_WINDOW (outside time window; deterministic queue, NO intent yet)
RECEIVED → READY_FOR_DISPATCH (all gates passed; dispatch intent created in same tx)
QUEUED_WINDOW → READY_FOR_DISPATCH (window opens later; Phase 2 exposes the transition, scheduling loop lands in Phase 3)
```
Any other transition throws `IllegalTransitionError`. Phase 3 will extend beyond `READY_FOR_DISPATCH`.

### D-P2-3 Outbox states (skeleton now, real SMTP in Phase 3)

```
PENDING → SENDING → SENT
          SENDING → UNCERTAIN   (send outcome unknown; reconciliation, never blind resend)
          UNCERTAIN → SENT      (reconciled)
```
Outbox rows carry `id` (= future `X-AMB-Outbox-ID` nonce) and self-generated RFC `message_id` — both recorded BEFORE any send, so the echo gate can always recognize our own mail.

### D-P2-4 Echo gate (control C3)

Input: normalized inbound Message-ID + `x-amb-outbox-id` header value (if any). Echo iff header value matches a known outbox `id` OR inbound Message-ID matches a known outbox `message_id`. Echo commands are stored terminal `SYSTEM_ECHO` and MUST never gain a dispatch intent.

### D-P2-5 Identity gate C1 (deterministic part only; DKIM=C2 waits for P0-3, Phase 3)

Addresses arrive already parsed (addr-spec strings). Normalize: lowercase whole address. Pass iff: exactly 1 From, exactly 1 To, 0 Cc, no other recipients, From === To === configured self, and local part contains no `+` (v0.1 rejects plus-tags; reason `IDENTITY_PLUS_TAG`). First failing check decides the reason (order: MULTI_RECIPIENT (from/to count ≠ 1) → CC → PLUS_TAG → FROM → TO).

### D-P2-6 Time window

```ts
interface TimeWindowConfig { timezone: string; days: number[]; start: string; end: string; excludeDates: string[]; }
```
`undefined` config ⇒ always within. Local wall-clock in `timezone` via `Intl.DateTimeFormat('en-CA', { timeZone, hour12: false, ... }).formatToParts`. `start <= end` same-day window (inclusive start, exclusive end); `start > end` crosses midnight. `days` = allowed weekdays (0=Sunday). `excludeDates` = local `YYYY-MM-DD` strings, always outside.

### D-P2-7 UID high-water mark

Per `(mailbox, uidValidity)`. `filterNewUids(uids, watermark)` keeps only `uid > watermark` — this neutralizes the RFC 3501 `UID SEARCH n:*` range-inversion quirk observed in the P0-1 smoke run (an empty search still returns the last message). Watermark only ever advances.

### D-P2-8 Ingest = one transaction

`ingestMail` performs: idempotent insert → echo gate → readyAt fence (`internalDate >= readyAt`, ISO comparison) → C1 → time window → intent creation, ALL inside one better-sqlite3 `.transaction()`. Result:

```ts
type IngestOutcome = 'duplicate' | 'echo' | 'rejected' | 'queued-window' | 'ready';
interface IngestResult { outcome: IngestOutcome; commandId: number | null; intentId: string | null; reason: string | null; }
```
`dryRun: true` in config marks created intents `dry_run = 1` (Phase 3 dispatcher will skip real execution). Intent id = `di-` + first 16 hex chars of SHA-256 of the normalized Message-ID (deterministic ⇒ idempotent).

### D-P2-9 SQLite schema v1 (migration 001)

```sql
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
```
Pragmas on open: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`. Migrations tracked via `PRAGMA user_version`.

### D-P2-10 Store API shapes

```ts
// src/store/database.ts
export function openDatabase(path: string): Database;   // applies pragmas + runs migrations; ':memory:' allowed in tests

// src/store/commandStore.ts
export interface CommandRecordInput { messageId: string; status: CommandStatus; statusReason: string | null; internalDate: string; uid: number | null; uidValidity: string | null; now: string; }
export interface CommandRecord extends CommandRecordInput { id: number; receivedAt: string; updatedAt: string; }
export class CommandStore {
  constructor(db: Database);
  insertIfAbsent(input: CommandRecordInput): { inserted: boolean; record: CommandRecord };
  updateStatus(id: number, next: CommandStatus, reason: string | null, now: string): CommandRecord; // enforces D-P2-2 via domain transition fn
  getByMessageId(messageId: string): CommandRecord | null;
}

// src/store/intentStore.ts
export class IntentStore {
  constructor(db: Database);
  createForCommand(intentId: string, commandId: number, dryRun: boolean, now: string): { created: boolean };
  getByCommandId(commandId: number): { id: string; status: string; dryRun: boolean } | null;
  countAll(): number;
}

// src/store/outboxStore.ts
export class OutboxStore {
  constructor(db: Database);
  create(entry: { id: string; messageId: string; commandId: number | null; kind: OutboxKind; now: string }): void; // status PENDING
  transition(id: string, next: OutboxStatus, now: string): void; // enforces D-P2-3
  isKnownOutboxId(id: string): boolean;
  isKnownOutboxMessageId(messageId: string): boolean;
}

// src/store/metaStore.ts
export class MetaStore {
  constructor(db: Database);
  getReadyAt(): string | null;  setReadyAtIfUnset(iso: string): string; // first-install fence, never overwritten
  getWatermark(mailbox: string, uidValidity: string): number;           // 0 when unknown
  advanceWatermark(mailbox: string, uidValidity: string, uid: number): void; // no-op if uid <= current
}
```
All stores are thin synchronous wrappers; `Database` is the better-sqlite3 handle. Only `src/store/**` may import `better-sqlite3`.

### D-P2-11 Transport seam + fake

```ts
// src/transports/types.ts
export interface IncomingMail {
  messageId: string | null;            // raw header value
  headers: ReadonlyMap<string, string>; // lowercased header names
  from: readonly string[]; to: readonly string[]; cc: readonly string[]; // parsed addr-specs
  internalDate: string;                // ISO
  uid: number; uidValidity: string; mailbox: string;
}
export interface OutboundMail { kind: OutboxKind; commandId: number | null; subjectRedacted: string; bodyRedacted: string; }
export interface SendReceipt { outboxId: string; messageId: string; }
export interface MailTransport {
  fetchSince(mailbox: string, uidValidity: string, sinceUid: number): Promise<IncomingMail[]>;
  send(mail: OutboundMail): Promise<SendReceipt>;
  markProcessed(mail: IncomingMail): Promise<void>;
  close(): Promise<void>;
}
```
`tests/helpers/fakeTransport.ts` implements it in-memory with `deliver(mail)` (supports duplicates + out-of-order), `sentMails` list, and `reflectOutbound(receipt)` that re-delivers a sent mail as an `IncomingMail` carrying `x-amb-outbox-id` (drives the echo tests). Fake `send` asks a caller-provided `registerOutbox` callback so outbox rows are recorded BEFORE the receipt is returned (mirrors the real send order).

---

## Task list

Tasks 2–5 are independent of each other; Task 1 blocks 6; Tasks 1–6 block 7+. Each task follows strict TDD (write failing test → watch it fail → minimal code → green → commit). Run a task's tests with `pnpm vitest run <test-file>`; before every commit run `pnpm lint && pnpm typecheck && pnpm test`.

### Task 1: better-sqlite3 + database open/migrations

**Files:** Create `src/store/database.ts`, `src/store/migrations.ts`; Test `tests/unit/store-database.test.ts`. Run `pnpm add better-sqlite3 && pnpm add -D @types/better-sqlite3` first.

- [ ] Failing tests: `openDatabase(':memory:')` → `user_version` becomes 1; tables `meta/uid_watermark/commands/dispatch_intents/outbox` exist (query `sqlite_master`); pragmas `journal_mode`(memory db reports `memory` — assert not `delete`), `foreign_keys = 1`; re-opening same file path is idempotent (user_version stays 1). Use a temp-dir file for the reopen test.
- [ ] Verify RED (module missing) → implement `migrations.ts` (array of `{ version: 1, sql: SCHEMA_V1 }`, applied in a transaction with `user_version` bump) and `database.ts` → GREEN → commit.

### Task 2: domain mail types + Message-ID + echo gate

**Files:** Create `src/domain/mail.ts` (`normalizeMessageId`, `syntheticMessageKey(uidValidity, uid)`, `deriveIntentId(normalizedMessageId)` using `node:crypto` sha256), `src/domain/echo.ts` (`classifyEcho({messageId, outboxHeaderValue}, {isKnownOutboxId, isKnownOutboxMessageId}) → boolean`); Test `tests/unit/domain-mail.test.ts`, `tests/unit/domain-echo.test.ts`.

- [ ] Failing tests — normalize: `'<a@b>'→'a@b'`, `'  <a@b>  '→'a@b'`, `'a@b'→'a@b'`, case preserved, `''→null`, `'<>'→null`, `'no-at'→null`, only ONE outer pair stripped (`'<<a@b>>'→'<a@b>'`); intent id deterministic, `di-` + 16 hex, same input ⇒ same id, different input ⇒ different id; echo: header match ⇒ true, message-id match ⇒ true, neither ⇒ false, header present but unknown ⇒ false (not echo — unknown nonce is NOT proof it is ours).
- [ ] RED → implement → GREEN → commit.

### Task 3: identity gate C1

**Files:** Create `src/domain/identity.ts` (`checkIdentityC1(mail: {from, to, cc}, selfAddress) → {ok: true} | {ok: false; reason: IdentityReason}`); Test `tests/unit/domain-identity.test.ts`.

- [ ] Failing tests: exact self→self passes; case-insensitive match passes; two From ⇒ `IDENTITY_MULTI_RECIPIENT`; two To ⇒ same; empty To ⇒ same; any Cc ⇒ `IDENTITY_CC`; `user+tag@…` (self configured without tag) ⇒ `IDENTITY_PLUS_TAG`; wrong From ⇒ `IDENTITY_FROM`; wrong To ⇒ `IDENTITY_TO`; use placeholder address `bridge-user@example.com` everywhere (public repo rule).
- [ ] RED → implement (reason priority exactly per D-P2-5) → GREEN → commit.

### Task 4: time window

**Files:** Create `src/domain/timeWindow.ts` (`isWithinWindow(config: TimeWindowConfig | undefined, now: Date) → {within: boolean; reason: string | null}`); Test `tests/unit/domain-time-window.test.ts`.

- [ ] Failing tests (fixed `Date` instants, timezone `Asia/Shanghai` and `America/New_York`): undefined config ⇒ within; inside 09:00–18:00 ⇒ within; before/after ⇒ not (`reason: 'outside-hours'`); `end` exclusive (exactly 18:00 ⇒ outside); disallowed weekday ⇒ `'outside-days'`; excluded local date ⇒ `'excluded-date'`; cross-midnight 22:00–06:00: 23:00 within, 05:00 within, 12:00 outside; timezone correctness: pick a UTC instant that is a different calendar day in the two zones and assert opposite verdicts.
- [ ] RED → implement via `Intl.DateTimeFormat` parts → GREEN → commit.

### Task 5: state machines (command + outbox)

**Files:** Create `src/domain/commandState.ts`, `src/domain/outboxState.ts` (exported `const` transition maps + `assertTransition(from, to)` throwing `IllegalTransitionError`, + `COMMAND_STATUSES`/`OUTBOX_STATUSES` unions); Test `tests/unit/domain-state-machines.test.ts`.

- [ ] Failing tests: every legal edge in D-P2-2/D-P2-3 passes; illegal samples throw (`SYSTEM_ECHO→READY_FOR_DISPATCH`, `REJECTED→READY_FOR_DISPATCH`, `SENT→PENDING`, `PENDING→UNCERTAIN`); terminal states have no outgoing edges (property test over the map).
- [ ] RED → implement → GREEN → commit.

### Task 6: stores (command / intent / outbox / meta)

**Files:** Create `src/store/commandStore.ts`, `src/store/intentStore.ts`, `src/store/outboxStore.ts`, `src/store/metaStore.ts` per D-P2-10; Test `tests/unit/store-records.test.ts` (in-memory db per test).

- [ ] Failing tests: `insertIfAbsent` twice with same messageId ⇒ second `{inserted: false}` and same record id; `updateStatus` illegal transition throws and does NOT persist; intent `createForCommand` twice ⇒ second `{created: false}`, `countAll` stays 1; two different intents for same command impossible (UNIQUE) — assert throw or `{created:false}`; outbox `create`+`isKnownOutboxId/MessageId` true, unknown false; `transition` follows D-P2-3, illegal throws; meta: `setReadyAtIfUnset` twice keeps first value; watermark starts 0, advances, never retreats (`advanceWatermark` with smaller uid is a no-op); watermark is per-uidValidity (new uidValidity starts at 0 — the bounded-rescan hook).
- [ ] RED → implement → GREEN → commit.

### Task 7: transport types + fake transport + uid filter

**Files:** Create `src/transports/types.ts` (D-P2-11), `src/domain/uid.ts` (`filterNewUids(uids: number[], watermark: number): number[]`), `tests/helpers/fakeTransport.ts`; Test `tests/unit/domain-uid.test.ts`, `tests/unit/fake-transport.test.ts`.

- [ ] Failing tests — uid filter: `filterNewUids([16102], 16102) ⇒ []` (the P0-1 `n:*` quirk case), mixed list filters correctly, empty ⇒ empty; fake transport: `deliver` then `fetchSince` respects `sinceUid`; duplicates preserved (transport is at-least-once — dedupe is the store's job); `send` invokes `registerOutbox` BEFORE resolving; `reflectOutbound` re-delivers with `x-amb-outbox-id` header and the same Message-ID.
- [ ] RED → implement → GREEN → commit.

### Task 8: ingestMail use case (single transaction)

**Files:** Create `src/application/ingest.ts` (`createIngest(deps: { db, commandStore, intentStore, outboxStore, metaStore, config: { selfAddress, timeWindow?, dryRun } }) → (mail: IncomingMail, now: Date) => IngestResult` per D-P2-8, wrapping the chain in `db.transaction()`); Test `tests/unit/ingest.test.ts`.

- [ ] Failing tests (fresh in-memory db, readyAt = 2026-07-17T00:00:00Z, self = `bridge-user@example.com`): valid mail ⇒ `ready`, command `READY_FOR_DISPATCH`, exactly 1 intent with derived id; re-ingest same mail ⇒ `duplicate`, still 1 intent; echo mail (outbox row pre-registered, then reflected) ⇒ `echo`, `SYSTEM_ECHO`, 0 intents; mail with internalDate before readyAt ⇒ `rejected`/`BEFORE_READY`; missing Message-ID ⇒ `rejected`/`NO_MESSAGE_ID` with synthetic key, re-ingest of same uid ⇒ `duplicate`; C1 violations map to `rejected` with exact reason; outside window ⇒ `queued-window`, 0 intents; `dryRun: true` ⇒ intent has `dryRun` flag set.
- [ ] RED → implement → GREEN → commit.

### Task 9: integration — duplicates, reorder, 100% echo

**Files:** Test `tests/integration/ingest-pipeline.test.ts` (uses fake transport + real in-memory stores + ingest).

- [ ] Failing tests: deliver 50 valid mails each duplicated 3× in shuffled order (deterministic seeded shuffle — implement a tiny LCG in the test file, no Math.random) ⇒ exactly 50 commands, 50 intents; watermark advances to max uid; send 20 outbound replies via fake transport (registering outbox rows), reflect ALL back ⇒ 20/20 classified `echo` (100%), 0 new intents; mixed stream (valid + echo + forged-identity + pre-readyAt) ⇒ counts per outcome exactly as constructed.
- [ ] RED → implement (this is mostly wiring; production code changes only if a real defect surfaces) → GREEN → commit.

### Task 10: integration — crash recovery at transaction boundaries

**Files:** Test `tests/integration/crash-recovery.test.ts`.

- [ ] Failing tests: (a) mid-transaction crash — inject an `intentIdFactory` (add optional dep to `createIngest`, default = `deriveIntentId`) that throws on first call: ingest throws, db shows 0 commands & 0 intents (full rollback), retry with normal factory ⇒ `ready`, exactly 1 command + 1 intent; (b) crash AFTER commit, BEFORE transport ack — re-deliver same mail ⇒ `duplicate`, still 1 intent; (c) process-restart simulation with a FILE-backed temp db: open db #1, ingest, close; open db #2 on same file ⇒ command/intent/watermark all persisted; re-ingest ⇒ `duplicate`.
- [ ] RED → implement (only test code + the optional factory seam) → GREEN → commit.

### Task 11: Phase 2 exit self-check + acceptance report

**Files:** Create `docs/reports/phase-2-acceptance.md`.

- [ ] Run `pnpm lint && pnpm typecheck && pnpm build && pnpm test` — all green, paste summary counts.
- [ ] Map each spec exit criterion + relevant MVP criteria (duplicate/crash safety, echo 100%, zero model calls by construction, first-install fence, exactly-one-intent) to the test file/case that proves it, in a table.
- [ ] Commit report; push.

---

## Self-review notes

- Spec coverage: transactional outbox ✓ (D-P2-3/Task 6), loop guard ✓ (Task 2/8/9), time window ✓ (Task 4/8), dry-run ✓ (Task 8), crash recovery ✓ (Task 10), simulated-IMAP exit criteria ✓ (Task 9). "MailTransport(imap-smtp)" from the Phase 2 line ships its interface + fake here; the real imap-smtp implementation lands with Phase 3's live loop (P0-1 informs it), which spec Phase 3 exercises end-to-end.
- Type consistency: `IngestResult`/store shapes defined once in D-P2-8/10/11 and referenced by tasks.
- No placeholders: every task carries concrete assertions; code-level minutiae are delegated to TDD inside the locked interfaces.
