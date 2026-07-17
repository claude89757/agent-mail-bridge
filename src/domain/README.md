# domain/

Pure decision logic, **no IO** (no network, no filesystem, no subprocess, no clock reads —
time is always passed in).

Planned contents (spec §3.1): command/outbox state machines, identity policy,
time-window policy, risk policy.

- Does: encode every security- and correctness-critical decision as pure functions.
- Used by: `application/` use cases.
- Depends on: nothing outside this directory (standard library types only).
