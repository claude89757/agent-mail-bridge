# Reference archives

## codex-app-server-schema/

Point-in-time JSON Schema archive of the Codex app-server protocol (v1 + v2),
generated on 2026-07-17 from Codex CLI 0.140.0:

```sh
codex app-server generate-json-schema --out docs/reference/codex-app-server-schema
```

Why it is archived (spec §5 Phase 0):

- **P0-4 spike** (connector reserve experiment) needs the exact
  `AppsList*` / `DynamicToolCall*` shapes that were verified to exist at
  design time;
- the **v0.3 app-server driver** will be designed against a pinned schema and
  then diffed forward, instead of chasing a moving 0.x target;
- drift detection: regenerate with a newer CLI and `git diff` this directory.

The MVP does **not** depend on this protocol (decision D4: `codex exec --json`
only).
