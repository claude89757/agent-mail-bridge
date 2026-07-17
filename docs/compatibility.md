# Compatibility

> Status: current. A Codex CLI compatibility table ships with every release
> (spec §4); this file pins the development baseline until then.

## Development baseline (locked 2026-07-17, Phase 0)

| Component | Version | Notes |
| --- | --- | --- |
| Node.js | 24.4.1 (dev machine); supported range `>=22` | matrix-tested on 22 and 24 in CI |
| pnpm | 10.13.1 | pinned via `packageManager` in `package.json` |
| TypeScript | 6.0.3 | pinned below 6.1: typescript-eslint 8.64 does not yet support TS 7 |
| Codex CLI | 0.140.0 | the external system under test; see policy below |
| OS targets | macOS (launchd), Linux (systemd user unit) | decision D6; Windows deferred |

## Codex CLI policy

Codex CLI is 0.x and drifts frequently (spec §1.3 rates this high-frequency /
low-severity). The bridge therefore:

1. drives Codex only through the stable non-interactive surface
   (`codex exec --json`, `codex exec resume`) — decision D4;
2. records the schema of the richer app-server protocol as a point-in-time
   archive (see [reference/](reference/)) for the P0-4 spike and the future
   v0.3 driver, without depending on it in the MVP;
3. verifies observed behavior with contract tests; on drift the bridge fails
   closed rather than guessing (an ADR records each adaptation);
4. publishes a version compatibility table with every release.

## Protocol schema archive

`docs/reference/codex-app-server-schema/` was generated on 2026-07-17 from
Codex CLI 0.140.0 via `codex app-server generate-json-schema --out <dir>`
(261 JSON files, v1 + v2). Regenerate with the same command against a newer
CLI and diff to detect drift. Verified present in v2:
`TurnStartParams.clientUserMessageId`, `AppsList*` (EXPERIMENTAL), `Thread*`
and approval-notification families — the surfaces the spec's assumptions
rest on (spec §1.2, §8).
