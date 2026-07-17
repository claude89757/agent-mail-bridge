# ADR-0001: SQLite driver — better-sqlite3 over node:sqlite

- Status: accepted (2026-07-17, Phase 2 planning)
- Deciders: bridge maintainers
- Related: spec §4 ("final choice during implementation planning"), threat-model C5 (idempotency), C3 (echo gate)

## Context

The store layer carries the security-critical guarantees: Message-ID unique
index (idempotency), transactional outbox, `readyAt` fence, UID high-water
marks. It needs a synchronous, transactional SQLite API with boring stability.

Two candidates:

1. **`node:sqlite`** (built-in): zero install cost — attractive for the
   5-minute-setup target. Measured reality (2026-07-17): flag-free since
   Node 22.13, but **Stability 1.1 "Active development"** in the v22 docs, and
   on Node 24.4.1 every process start prints
   `ExperimentalWarning: SQLite is an experimental feature and might change at
   any time`.
2. **`better-sqlite3`**: mature synchronous API, real prepared statements and
   `.transaction()`, prebuilt binaries for mainstream macOS/Linux × Node 22/24;
   cost: a native module (rebuild on unusual platforms/Node versions).

## Decision

Use **better-sqlite3** for the v0.1 store. Wrap all access behind `src/store/`
modules so no other layer imports the driver directly.

## Rationale

- The store is the foundation for effectively-once semantics; building it on
  an interface documented as "might change at any time" contradicts the
  fail-closed principle and risks silent behavior drift inside our transaction
  boundaries.
- A daemon that prints `ExperimentalWarning` on every start undermines the
  security-tool credibility the project sells.
- `engines: node >=22` includes 22.0–22.12 where `node:sqlite` still needs a
  flag; narrowing engines for a store driver is backwards.

## Consequences

- One native dependency: install falls back to source compilation on unusual
  platforms (documented in operations.md troubleshooting later).
- Revisit when `node:sqlite` reaches Stability 2 across supported LTS lines —
  the `src/store/` seam keeps the migration surface small; a future ADR may
  swap the driver.

## Reproduce

```sh
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; new DatabaseSync(':memory:'); console.log(process.version)"
# → prints ExperimentalWarning on v24.4.1
# v22 docs: https://nodejs.org/docs/latest-v22.x/api/sqlite.html — "Stability: 1.1 - Active development",
# history: "v22.13.0 SQLite is no longer behind --experimental-sqlite but still experimental."
```
