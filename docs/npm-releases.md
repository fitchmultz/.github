# npm release guide

[Back to the README](../README.md) · [Repository setup](integration.md)

## Automatic releases

[`fleet.json`](../fleet.json) lists the owned npm channels. A repository's callers enable its channel only after its existing release qualifications can run for the exact publication source. A fleet entry or a green offline compatibility check alone is not proof that a package is ready to publish.

1. A merge to `main` enters the version queue. The first queued commit installs the version workflow; later source commits are processed in first-parent order, even if the first run is delayed. The workflow verifies the preceding aligned npm/GitHub release and waits for each automatic version to appear on both registries before starting another.
2. A repository-scoped GitHub App opens a version PR. It chooses the next stable patch above the manifest, npm versions and existing tags; updates `package.json` and `package-lock.json`; and combines `Unreleased` notes, the source commit and generated GitHub release notes under a versioned changelog heading. The original source commit remains recorded even when `main` advances during review.
3. The PR is updated to current `main` and must pass its actual current-head compatibility checks, Pi Durable and Cursor reviews, and resolved review threads. GitHub still enforces the repository's branch rules. If a Pi finding is genuinely addressed and its inline thread resolved, the version branch receives an empty recheck commit so the reviewers can reassess it on a new head. Standalone findings have no GitHub resolution state and require an actual agent disposition; a green check alone does not establish that they were addressed.
4. After the version PR merges, the repository's `npm-release.yml` plans from that exact main event. Its existing package-specific jobs must pass before the shared publisher runs. The planner freezes the latest official Pi version and maintained fork commit for that run. Preparation builds one candidate without publication credentials, installs the **same tarball** into independent consumers of both hosts, and exercises their bundled Pi CLIs. The candidate, host identities and checksum are retained as workflow artifacts.
5. Publication rechecks package ownership, environment, source ancestry, tag and tarball identity. It creates an annotated tag and draft GitHub Release, publishes the candidate with npm trusted publishing, verifies registry integrity, and finalizes the GitHub Release. The tag, release, package version and npm provenance identify the verified publication source. A release completion wakes the version queue so later merges are not stranded.

Version PRs and their release notes are generated automatically; maintainers can keep writing useful `Unreleased` notes. Package lifecycle scripts are disabled during the final credentialed `npm publish`, so each caller must provide any additional release gate before invoking the shared publisher:

- **pi-agent-browser-native:** its own release verification includes the configured-source Pi lifecycle and required macOS/Ubuntu Crabbox smoke; its release instructions also require real-site dogfood. The shared host checks do not replace them.
- **pi-oracle:** its `release:check` requires eight actual ChatGPT preset jobs for the exact post-merge HEAD and its doctor-first macOS, Ubuntu and native Windows platform suites. A PR-head run or offline test is not equivalent.
- **pi-cursor-sdk:** its release instructions require a deep maintainability review of the exact release diff, with findings addressed and review repeated until clear, in addition to applicable verification.
- **pi-zai-mcp:** its release and completion checks include the production `npm audit`, which is not part of `check:compat`.
- **pi-codex-goal:** release-sensitive changes require interactive real-model `/goal` session evidence, which offline compatibility does not provide.
- **pi-posthorse:** delivery requires independent evidence that the complete verification workflow rejects each documented class of bad change.

The shared versioner and publisher hold these six channels until their additional gates are wired; Cursor also needs its required pre-commit and pre-push review. Keep their callers disabled. Other package-specific requirements remain in their repositories and are not waived by this guide. If a package defines `release:dry-run`, preparation runs it without publication credentials before packing.

## Recovery

A scheduled reconciliation and a manual dispatch on `main` retry incomplete work. Pending source commits are not assigned new versions while the latest automatic release is incomplete. An existing npm version is never republished with different bytes. For a recognized unfinished draft, the publisher can recover the originally verified tarball and receipt from the draft, verify their GitHub digests, and finish that same version. A conflicting tag, release, identity or integrity fails closed.

For an incomplete release, reconciliation reruns its original `npm-release.yml` run so the GitHub Actions SHA and npm provenance remain aligned. GitHub limits [workflow reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) to 30 days and 50 attempts. A later main dispatch cannot substitute for an unavailable original run when a draft belongs to an older SHA; investigate that case rather than moving a tag or overwriting an npm version. Successful npm publication may take time to become visible; the publisher verifies the exact version and `latest` before finalizing the GitHub Release.

If a review or CI check fails, address the real finding or failure and resolve its thread. While the version workflow is running, it watches unresolved Pi inline findings and dispatches a fresh main-ref reconciliation once they are resolved. A version-branch update also wakes reconciliation; the schedule retries work after a run has ended. Do not treat a canceled, missing, skipped, stale-head or stale-base check as a pass.

## Repository setup

- Configure an `npm` environment restricted to `main`. Configure npm trusted publishing for the repository's caller filename `npm-release.yml` and environment `npm`; the reusable workflow authenticates as that caller. Existing packages use OIDC rather than an npm token.
- Configure a separate `release` environment restricted to `main` with `RELEASE_APP_PRIVATE_KEY`, and a repository variable `RELEASE_APP_CLIENT_ID` for the installed GitHub App. Its per-repository token needs contents and pull-request write access. The version workflow uses the ordinary GitHub token for check, pull-request and Actions reads/retries.
- The repository's `npm-version.yml` calls `.github/workflows/npm-release-bump.yml` at a reviewed immutable automation revision, passing that same revision as `automation-ref`, the App client ID, and the named environment secret. Its main-push, external Pi Durable and Cursor check-run completion, release-completion, schedule and dispatch events share a native queued concurrency group. These events run trusted main automation in the main-only environment, never code from an untrusted PR.
- The `npm-release.yml` caller keeps its existing package jobs, calls the shared planner, and forwards `source`, `release-source`, `official-version` and `fork-ref` to the shared publisher. It runs publication from the exact main push or a rerun of that push. Both the workflow reference and `automation-ref` use the same reviewed revision.
- Before enabling the caller, verify that the latest npm version, its published GitHub release and tag, and the manifest at that tag agree, with the tag commit on main's first-parent history. The initial version queue starts at the caller's installation commit. Preserve all actual branch protections and package-specific qualification.

To configure trusted publishing for an existing package:

```sh
npm trust github PACKAGE --repo fitchmultz/REPO --file npm-release.yml --env npm --allow-publish --yes
```

For a genuine first publication of an enabled owned scoped package, npm currently requires an environment-only `NPM_BOOTSTRAP_TOKEN`. The caller explicitly maps that optional secret; preparation and checks never receive it. The publisher verifies the authenticated account before making release writes, uses the token only for that first scoped publication, and retains provenance and integrity checks. Configure native trust and remove the temporary environment secret after publication. Registry responses other than a genuine 404 do not authorize this path.

Set `NPM_RELEASE_ENABLED=false` in a package repository to stop new release runs, and cancel already-running runs if a stop is needed. Never delete an existing npm version, move a conflicting tag, or replace a release asset to conceal an uncertain outcome. Prereleases and other dist-tags remain outside this stable automatic channel.

The read-only planner and candidate verifier can also run locally; `node scripts/npm-release.mjs --help` describes their inputs.
