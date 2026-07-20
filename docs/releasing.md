# Releasing

`agent-mail-bridge` publishes on tag. Pushing a `v*` tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds,
gates, publishes to npm with provenance, and cuts a GitHub Release. Credentials
never pass through a person or an agent interactively — see
[ADR-0005](adr/0005-release-automation-ci-agent-tags.md) for why.

## One-time setup (maintainer)

Add an npm **automation** access token as a repository secret named `NPM_TOKEN`:

1. On npmjs.com: Account → Access Tokens → Generate New Token → **Automation**
   (or a Granular token scoped to publish `agent-mail-bridge`).
2. In GitHub: repo **Settings → Secrets and variables → Actions → New repository
   secret**. Name it exactly `NPM_TOKEN`, paste the token, save.

The token is write-scoped to publishing and lives only in GitHub's secret store.
Nothing else is needed — `GITHUB_TOKEN` for the Release is provided automatically.

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
- `npm publish --provenance --access public` using `NPM_TOKEN`;
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
- The agent never handles the `NPM_TOKEN` or any login credential; that is a hard
  rule ([ADR-0005](adr/0005-release-automation-ci-agent-tags.md), AGENTS.md
  安全红线 4). CI holds the secret; you set it once.
