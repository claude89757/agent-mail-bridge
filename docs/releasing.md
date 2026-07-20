# Releasing

`agent-mail-bridge` publishes on tag. Pushing a `v*` tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds,
gates, publishes to npm with provenance, and cuts a GitHub Release. Credentials
never pass through a person or an agent interactively — see
[ADR-0005](adr/0005-release-automation-ci-agent-tags.md) for why.

## One-time setup (maintainer)

Publishing authenticates via **OIDC trusted publishing** — no npm token is stored
anywhere. Configure the trusted publisher once on npmjs.com:

1. Open the package settings on npmjs.com → **Trusted Publisher** → select
   **GitHub Actions**.
2. Fill: organization/user `claude89757`, repository `agent-mail-bridge`, workflow
   filename `release.yml`, environment blank; allow **npm publish**.

That's all — nothing lives in GitHub secrets. Each release, GitHub Actions proves
its identity to npm with a short-lived OIDC token; `GITHUB_TOKEN` for the Release
is provided automatically, and provenance is generated automatically.

## Cutting a release

1. Bump `version` in [`package.json`](../package.json) and move the
   [`CHANGELOG.md`](../CHANGELOG.md) top section to the new version with today's
   date. Commit to `main`.
2. Wait for CI on that commit to go green.
3. Tag and push:

   ```sh
   git tag v0.1.0        # must equal package.json version
   git push origin v0.1.0
   ```

That is the whole trigger. The workflow then, on the tag:

- installs, then runs `lint` / `typecheck` / `build` / `test`;
- **fails closed** if the tag (`v0.1.0`) and `package.json` version disagree;
- `npm publish` authenticating via OIDC trusted publishing (provenance automatic);
- creates the GitHub Release, linking the npm version and the changelog.

## If a release fails

- **Gate or version-mismatch failure:** nothing was published (the publish step
  runs last). Fix the commit, delete and re-push the tag.
- **Publish succeeded but the Release step failed:** the npm version is already
  live and immutable — do **not** bump to "fix" it. Re-run the failed job, or
  create the GitHub Release by hand from the existing tag.
- **Wrong version published:** npm forbids re-publishing a version. Publish a new
  patch version and deprecate the bad one on npm if needed.

## What the agent does vs. what stays with you

- The agent writes and maintains this workflow and pushes the release tag —
  **confirming with you each time**, because the tag push triggers a real publish.
- The agent never handles any npm token or login credential; that is a hard rule
  ([ADR-0005](adr/0005-release-automation-ci-agent-tags.md), AGENTS.md 安全红线 4).
  With OIDC trusted publishing there is no token at all — GitHub Actions
  authenticates to npm per-run via short-lived OIDC.
