# Use the shared automation

[Back to the README](../README.md)

This setup is for a repository already represented in [`fleet.json`](../fleet.json). A new repository needs an inventory entry with its package kind, Node/platform lanes and exact owned npm name where applicable, plus a package-specific `check:compat` script.

## Connect a repository

1. Enable GitHub Dependabot alerts and security updates as described below, and add the shared preset that disables Renovate.
2. Choose a reviewed commit on this repository's `main`, then put its full SHA in **both** places in this caller. Replace `REVIEWED_AUTOMATION_SHA` before committing:

   ```yaml
   name: Pi compatibility

   on:
     pull_request:
     push:
       branches: [main]

   permissions:
     contents: read

   jobs:
     compatibility:
       uses: fitchmultz/.github/.github/workflows/pi-compatibility.yml@REVIEWED_AUTOMATION_SHA # main
       with:
         automation-ref: REVIEWED_AUTOMATION_SHA # main
   ```

   Leave `host` at its default `both` for normal extension PRs. The workflow selects the caller's repository and source commit by default.
3. Open a PR, inspect its compatibility aggregate, and require the repository's actual successful aggregate check in branch protection. The displayed check name depends on the caller's job name.

Keep the workflow revision and `automation-ref` together. [Qualification](qualification.md) explains exact host selection, lane budgets, artifacts and the Windows waiver. [npm releases](npm-releases.md) covers the separate publishing setup.

## Repository callers

Each repository owns its source, lockfile, package-specific `check:compat` command, and release channel. Its small workflow calls `.github/workflows/pi-compatibility.yml` at a reviewed commit and passes that same commit as `automation-ref`. Keep both pins together. The shared preset disables Renovate; native GitHub Dependabot handles security fixes. Ordinary dependency upgrades are manual; development lockfiles remain reproducible snapshots, not qualification targets. Review Node/Pi compatibility and the required checks before merging security PRs; automatic merge is not enabled.

For reviewed automation revisions on `main` without a release tag, annotate both immutable SHA pins with `# main`. Update both pins together in a reviewed PR; the workflow executes the reviewed SHA, never a floating automation branch.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>fitchmultz/.github:pi-extensions"]
}
```

Host qualification resolves current releases automatically; the fork's own npm dependencies continue to follow its reviewed dependency-integration process.

## Security updates

Enable the dependency graph, Dependabot alerts, and native [Dependabot security updates](https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/configuring-dependabot-security-updates) before disabling Renovate in a consuming repository:

```sh
repo=fitchmultz/REPO
gh api --method PUT "repos/$repo/vulnerability-alerts"
gh api --method PUT "repos/$repo/automated-security-fixes"
gh api "repos/$repo/automated-security-fixes"
```

The final response must report `enabled: true` and `paused: false`. Enable these settings explicitly for maintained forks too; do not unarchive retired repositories merely to run dependency automation.

No `.github/dependabot.yml` is needed for security updates. Do not add a version-update schedule: routine version and digest upgrades remain manual. Native security updates can repair npm transitive lockfile dependencies that current Renovate cannot remediate. GitHub opens a PR only when it can produce a fix; alerts without a patched version or a resolvable upgrade still need maintainer attention. Keep the existing compatibility gates and review security fixes rather than enabling automatic merge.

## Rollout and administration

1. Qualify the full candidate fleet. `PI_COMPATIBILITY_SOURCE_REF` may temporarily select a coordinated rollout branch in this repository and an integrated fork caller; clear it after the extension branches merge.
   To qualify an unmerged fork candidate, dispatch `Automation CI` at the reviewed automation branch with `fork-ref` set to its full commit SHA and `source-ref: main` after changed package PRs merge (or one coordinated source branch present in every fleet repository). The run freezes latest official and candidate fork identities and qualifies all 24 repositories across all 90 configured lanes, including 45 fork lanes; Windows remains waived diagnostics. An empty `fork-ref` still resolves maintained main. This dispatch does not activate code or update canary issues.
2. Obtain the required owner-designated reviews before merging or activating the rollout. Publish the shared workflow's version tag only after approval, then keep callers pinned to its reviewed commit.
3. Enable native GitHub Dependabot security updates for the selected repositories. Keep Renovate disabled and do not enable scheduled version updates or a second dependency updater. When switching an existing repository, close obsolete Renovate PRs and Dependency Dashboard issues after activation; preserve human-modified work and leave archived repositories untouched.
4. Require each repository's actual successful aggregate compatibility check on its default branch, preserving existing protection and useful required checks. A fork integration must include reverse-dependency qualification in its `build-check-test` aggregate.
5. Set this repository's `PI_COMPATIBILITY_ENABLED` Actions variable to `true` to enable the canary, and run it once manually. Until then both its scheduled and manual entrypoints remain disabled.

A development-dependency-only change does not require a new npm release. For a shipped fix on an owned npm channel, publish the exact checked tarball and verify package/tag/source identity; retain any package-specific live release gates. Git-only packages stay Git-delivered. Consumer updates use normal Pi package updates and a fresh process or the fork's native restart. Qualification itself never activates code.
