# ADR-0005: Release automation via CI — agent tags, CI publishes; credentials never touch the agent

- Status: **accepted (user, 2026-07-20)** — the maintainer chose CI auto-publish
  over manual release and over per-action connector operation.
- Deciders: user (repo owner) + bridge maintainers
- Supersedes: the manual-only stance of AGENTS.md 安全红线 4 ("npm publish、
  GitHub Release、修改仓库设置等对外发布动作一律不执行，到点整理好产物提请用户
  手动操作") for the **publish + GitHub Release** path. Red line 4 is revised, not
  deleted: its non-amendable core — the agent never handles raw credentials — is
  kept and made explicit.
- Related: [`.github/workflows/release.yml`](../../.github/workflows/release.yml),
  [`docs/releasing.md`](../releasing.md), `package.json` (`publishConfig`,
  `prepublishOnly`), `CHANGELOG.md` `[0.1.0]`.

## Context

This project is developed and iterated by AI agents. The maintainer wants agents
to drive releases with minimal friction, not to hand every release back for
manual execution. The prior policy (red line 4) forbade the agent from any
publish/release action outright.

Two constraints bound how far that can be relaxed:

1. **An agent must never handle the maintainer's raw login credentials** (npm
   token, GitHub password). This is an Anthropic-level safety rule, independent of
   this repository's policy — no edit to AGENTS.md can grant it. So "the agent
   logs in and runs `npm publish`" is permanently out of scope.
2. **Publishing is an irreversible, outward-facing action.** Even when automated,
   the action that *triggers* a real publish warrants a per-action confirmation
   rather than standing, blanket pre-authorization.

The friction the maintainer wants to remove is *mechanical* (build, auth,
publish, cut release), not *decisional* (whether to release this commit).

## Decision

Adopt **publish-on-tag CI automation**:

- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) triggers
  on any `v*` tag push. It re-runs the four gates (lint / typecheck / build /
  test), verifies the tag matches `package.json` version (fail closed on
  mismatch), then `npm publish --provenance --access public` using the repository
  secret `NPM_TOKEN`, then cuts a GitHub Release with the built-in `GITHUB_TOKEN`.
- The **agent** authors and maintains this workflow and pushes the release tag —
  confirming that one action with the user each time, because pushing the tag
  triggers a real publish.
- The **maintainer** configures the `NPM_TOKEN` repository secret once. The token
  lives in GitHub's secret store; it is never printed, never passes through chat,
  and never touches the agent.
- The credential-bearing step runs inside GitHub Actions, not on anyone's
  keyboard. No human or agent types the token to publish.

Scope kept out of this decision:

- **`npm publish` authentication stays out of the agent's hands permanently** —
  the agent triggers the automation, CI holds the secret. This is the constraint
  from Context §1 and is not amendable by this or any future ADR.
- **Repository-settings changes** (e.g. enabling Private vulnerability reporting)
  are not covered here. The agent does not change repo settings unilaterally;
  those happen with per-action user confirmation (e.g. via a GitHub connector when
  one is wired) or are performed by the maintainer.

## Consequences

- Releases become agent-driven with a single per-release confirmation (the tag
  push); everything after the tag is automated and auditable in the Actions log.
- Supply-chain posture improves: every publish carries a provenance attestation,
  the gates re-run on the release commit before publishing, and a tag/version
  mismatch aborts before any publish.
- The maintainer's standing burden shrinks to a **one-time** `NPM_TOKEN` secret
  setup (documented in [`docs/releasing.md`](../releasing.md) and AGENTS.md
  需要用户介入的时点).
- Red line 4 is revised to describe this model while preserving, in bold, the
  non-amendable rule that the agent never handles raw credentials.
- If a future path needs the agent to perform repo-settings or other outward
  actions, that is a separate, per-action, user-confirmed decision — not implied
  by this ADR.

## Verification

- `release.yml` is skipped by construction on normal pushes/PRs (it triggers only
  on `v*` tags), so landing it publishes nothing.
- The first real exercise is the `v0.1.0` tag push, gated on: (a) the maintainer
  having added `NPM_TOKEN`, and (b) the agent's per-release confirmation. Until
  then the pipeline is dormant.
