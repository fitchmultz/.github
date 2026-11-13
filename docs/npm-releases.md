# Automatic npm releases

[Back to the README](../README.md)

The release workflows publish packages in [`fleet.json`](../fleet.json) whose `npmRelease` is `"automatic"`. Each entry names its exact `npmPackage`.

## Pipeline

1. A merge to `main` enters the version queue after passing normal PR checks and reviews. A release happens only when the installable package changes: `npm-version.mjs reconcile` builds and packs current `main` with the release preparation steps and compares every installed file, executable bit, and runtime manifest field against the latest published tarball. Merges that change only CI, tests, development scripts, `devDependencies`, or `CHANGELOG.md` wait for a change that affects the package.
2. When installable bytes change, the repository-scoped release GitHub App (`Pi Durable`, granted ruleset bypass on `pi-compatibility` while ordinary pushes and PRs still require every check) chooses the next stable patch above the manifest, npm versions, and existing tags; updates `package.json` and `package-lock.json`; curates `Unreleased` notes from `CHANGELOG.md` plus sorted `changelog.d/*.md` fragments (excluding `changelog.d/README.md`) inside a `<!-- npm-release:unreleased:start -->` / `<!-- npm-release:unreleased:end -->` block; removes the consumed fragment files; appends GitHub's generated notes since the previous published tag; and runs the package's `format` script when present.
3. For packages with `versionQualification: true` (`pi-cursor-sdk`), `reconcile` runs the package's isolated exact-diff `pre-commit` and `pre-push` version reviews before publishing the commit. It then creates a GitHub-signed commit (`chore(release): X.Y.Z` carrying `<!-- pi-npm-source: <sha> -->`), verifies that the remote Git tree SHA matches the reviewed local tree byte-for-byte, and atomically fast-forwards `refs/heads/main` (`force: false`), retrying cleanly on the latest `main` if another PR merged concurrently.
4. Pushing that GitHub-signed Bot commit to `main` triggers the repository's `npm-release.yml` on the exact release commit (`GITHUB_SHA`). Only a GitHub-verified Bot commit that modifies solely version metadata (`package.json`, `package-lock.json`, `CHANGELOG.md`, and `changelog.d/*.md`) can authorize automatic release planning; unverified commits, human commits, or commits altering other files are rejected. The planner freezes the latest official Pi version and maintained fork commit for that run. Preparation selects any recognized original draft tarball first, or builds a new candidate without publication credentials, and exercises the **same tarball** across independent consumers of both hosts.
5. Packages with additional release requirements run their exact-source and exact-candidate gates before publication. Their `Release qualification` job uses the shared `qualify` command to bind the source, tarball, host receipt, and workflow run in an artifact. The qualified publisher verifies that artifact and the successful job before releasing. Callers without additional gates use the ordinary shared publisher.
6. Publication rechecks package ownership, environment, source ancestry, tag, and tarball identity. It creates an annotated tag and draft GitHub Release, publishes the candidate with npm trusted publishing (OIDC), verifies registry integrity, and finalizes the GitHub Release. A release completion wakes the version queue so later merges are not stranded.

Release notes are generated automatically; maintainers can write curated notes as `changelog.d/*.md` fragments (so concurrent PRs do not conflict on `CHANGELOG.md`) or under `## Unreleased` in `CHANGELOG.md`. Write fragments as list items or `###` sections; any level-2 `##` heading line in a fragment is published nested as `###`. Package lifecycle scripts are disabled during the final credentialed `npm publish`, so each caller must provide any additional release gate before invoking the shared publisher:

- **pi-subagents:** its packed entry must load through real Pi and exercise an actual native child session on the selected hosts; a loader-only smoke is not equivalent.
- **pi-agent-browser-native:** its own release verification includes the configured-source Pi lifecycle and required macOS/Ubuntu Crabbox smoke against the retained candidate tarball; its release instructions also require real-site dogfood. The shared host checks do not replace them.
- **pi-oracle:** its `release:check` requires eight actual ChatGPT preset jobs for the exact post-merge HEAD. A PR-head run or offline test is not equivalent.
- **pi-cursor-sdk:** its release instructions require a deep maintainability review of the exact release diff in addition to applicable catalog and native Zod installer verification.
- **pi-zai-mcp:** its release and completion checks include the production `npm audit`, which is not part of `check:compat`.
- **pi-codex-goal:** release-sensitive changes require interactive real-model `/goal` session evidence, which offline compatibility does not provide.
- **pi-posthorse:** delivery requires independent evidence that the complete verification workflow rejects each documented class of bad change.
- **pi-mcp-adapter:** the packed candidate must pass its real tool/SDK and consumer-type checks, not only a separately packed CI build.

The shared versioner and publisher hold these eight channels until their additional gates are wired; Cursor SDK also needs its required pre-commit and pre-push review. Once a caller includes its exact-candidate gate, it passes `package-qualified: true` to the version workflow and routes publication through the shared qualified publisher. If a package defines `release:dry-run`, preparation runs it without publication credentials before packing.

## Recovery

Idempotent `GET` and `HEAD` requests retry transient transport failures and HTTP `502`, `503`, and `504` responses before failing; writes are never retried automatically. When fetch still rejects, version clients report the service, HTTP method, and public endpoint, followed by Node's native error and cause details. Endpoint diagnostics omit URL credentials, query strings, and fragments; request headers and bodies are not logged.

A scheduled reconciliation and a manual dispatch on `main` retry incomplete work. Without an explicit supersession request, pending source commits are not assigned new versions while the latest automatic release is incomplete. An existing npm version is never republished with different bytes. For a recognized unfinished draft, preparation recovers the original tarball and receipt, verifies their GitHub digests, and requalifies those same bytes against the selected hosts and package gates before the publisher finishes that version.

For an incomplete release, reconciliation reruns its original `npm-release.yml` run so the GitHub Actions SHA and npm provenance remain aligned. A failed-job rerun can reuse a previously successful qualification from that run when the candidate and host receipt match and GitHub reports the same job execution times. GitHub limits [workflow reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) to 30 days and 50 attempts.

### Replace a failed unpublished version with fixed source

When an automatic release fails because its source needs a fix, merge the fix through the repository's normal PR process. Dispatch the repository's `npm-version.yml` on `main`, supplying both values:

```sh
gh workflow run npm-version.yml --repo fitchmultz/REPO --ref main \
  -f supersede-version=FAILED_VERSION \
  -f supersede-source=FAILED_VERSION_COMMIT_SHA
```

`supersede-source` is the full commit SHA of the failed automatic version commit on `main`, not its earlier `pi-npm-source` queue marker. The versioner verifies that pair against the latest genuine GitHub-signed Bot automatic version. The exact version must be absent from npm, any GitHub release for it must still be a draft, and its latest original main `npm-release.yml` run must have completed with failure. Only an operator dispatch of the trusted main `npm-version.yml` caller can request a replacement.

The release App commits a new GitHub-signed version directly onto fixed `main`. The native version selector chooses a new stable patch above the manifest, every npm version, and all version tags. Generated notes span the previous published tag through fixed `main`. The new section copies the unpublished version's curated notes into a `<!-- npm-release:carried:start -->` / `<!-- npm-release:carried:end -->` block before generated notes, leaving the old version's full section and release records unchanged. Once that replacement publishes on npm and GitHub, the ordinary version queue resumes after its commit.

## Repository setup

- Configure an `npm` environment restricted to `main`. Configure npm trusted publishing for the repository's caller filename `npm-release.yml` and environment `npm`; existing packages use OIDC rather than an npm token.
- Configure a `release` environment restricted to `main` with `RELEASE_APP_PRIVATE_KEY` and `RELEASE_APP_CLIENT_ID`. Grant the installed release GitHub App (`Pi Durable`, integration ID `5180273`) repository `contents: write` access and add it as an `Integration` bypass actor (`bypass_mode: "always"`) on the repository's default-branch status-check ruleset so only GitHub-signed release commits from the App can advance `main` without opening a second PR.
- The repository's `npm-version.yml` calls `.github/workflows/npm-release-bump.yml` at a reviewed immutable automation revision, passing that same revision as `automation-ref`, `RELEASE_APP_CLIENT_ID`, and `RELEASE_APP_PRIVATE_KEY` (plus `version-reviewed: true` and `ZAI_API_KEY` for `pi-cursor-sdk`). Its events (`push` on `main`, `workflow_run` of `npm release`, `schedule`, and `workflow_dispatch`) share a queued concurrency group, and its job condition skips version commits (`chore(release): …`) on `push` so the release commit itself triggers `npm-release.yml` without re-entering `npm-version.yml`.
- The `npm-release.yml` caller forwards `source`, `release-source`, `official-version`, and `fork-ref` from the shared planner, runs `npm-release-prepare.yml` plus any package-specific candidate gates against `npm-candidate-${source}`, binds them in `Release qualification`, and publishes via `npm-release-qualified.yml` (or calls `npm-release.yml` directly when no package-specific gates apply).

To configure trusted publishing for an existing package:

```sh
npm trust github PACKAGE --repo fitchmultz/REPO --file npm-release.yml --env npm --allow-publish --yes
```

For a genuine first publication of an enabled owned scoped package, npm currently requires an environment-only `NPM_BOOTSTRAP_TOKEN`. Set `NPM_RELEASE_ENABLED=false` in a package repository to pause automatic releases. Never delete an existing npm version, move a conflicting tag, or replace a release asset to conceal an uncertain outcome.
