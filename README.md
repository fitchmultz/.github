# Pi release compatibility

Shared Renovate policy and native GitHub Actions qualification for the Pi packages in `fleet.json`. Official stable releases are the primary host. The maintained `fitchmultz/pi` fork is a separate required host; Posthorse intentionally supports only that fork.

## Repository callers

Each repository owns its source, lockfile, package-specific `check:compat` command, and release channel. Its small workflow calls `.github/workflows/pi-compatibility.yml` at a reviewed commit and passes that same commit as `automation-ref`. Keep both pins together. The shared Renovate preset groups those references and groups declared Pi development dependencies into one stable-version update PR. It pins only the Pi development cohort to exact test baselines, not unrelated development-tool ranges. It leaves wildcard host peers alone and does not enable automerge.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>fitchmultz/.github:pi-extensions"]
}
```

The managed Renovate GitHub App must have access to the selected repositories. A checked-in config does not install the App. This repository maintains the shared host targets; the fork's own npm dependencies continue to follow its reviewed upstream-integration process.

## Qualification

The reusable workflow resolves each source ref to an exact commit. An individual extension PR selects the exact official development version in its candidate manifest. A shared fleet run selects `host-targets.json`; the scheduled canary resolves npm's latest stable release once for the run. When selecting an official host, the resolver verifies publication of the whole Pi workspace cohort before scheduling extension checks. A partially published host is an infrastructure failure.

The reusable workflow's `host` input accepts only `both` (default) or `fork`; other values fail resolution. Normal extension PRs and the fleet canary leave it at `both`, preserving official/fork qualification for all applicable packages, Posthorse's official refusal, diagnostic baseline comparisons, and the standalone CLI's `host: none` checks across all 26 repositories. Only the fork's reverse-dependency CI passes `host: fork` with `repository: all`. That mode qualifies all 25 Pi-host-qualified fleet packages against the exact `fork-ref`, retains every configured Node/platform lane, and excludes the standalone CLI, which has no Pi dependency. It does not resolve a candidate official version, read candidate manifests for host selection, or query/preflight official npm metadata (even if `official-version` is supplied). Unrelated official-host failures therefore do not block fork changes.

CI installs the reviewed npm version from `package.json#packageManager` on every Node baseline; Renovate maintains that standard metadata. Each host gets an independent npm dependency graph. The official cohort is pinned to one release; the fork uses the native public-workspace packaging helpers from the exact fork commit. Host preparation records the SDK and bundled CLI hashes, cohort, lock integrity or fork tarball hashes, Node version, and resolved paths. The selected host's TypeBox version is used rather than assumed to follow Pi's version number. The public source manifest and lockfile are restored before package checks; the selected installed graph remains in place for types and imports.

The fork is built once per workflow and shared as an artifact. Its cache includes runner architecture, Node version, fork commit, automation revision, lockfile and hydrated model-data contents. The fork's reverse-dependency caller supplies `fork-ref: ${{ github.sha }}` and its existing `fork-source-artifact` from the same run, so all gates use that exact commit and frozen model data. It preserves `source-ref: ${{ vars.PI_COMPATIBILITY_SOURCE_REF || 'main' }}` for candidate rollout branches, then default-branch qualification. Other public callers build directly from public source without cross-repository artifact credentials.

Required lanes run the repository's contracts, a fresh Git checkout with production dependencies and normal install lifecycle, and the real bundled Pi CLI. Owned npm channels also pack and install a real tarball, then compare its registered tools, active tools, commands and provider surface with the Git consumer. Skills, project-local workflows and the standalone CLI retain their resource/CLI contracts instead of being treated as fictitious extensions. Package identities in `fleet.json` are explicit: a matching npm name alone is not ownership evidence.

Package contract commands have a 10-minute watchdog by default. The fleet inventory gives Browser's Windows contract command 15 minutes to accommodate its full serial suite and package smoke. That Windows job has a 35-minute limit for cold installation and the remaining consumer checks; other jobs retain 25 minutes. These are whole-command and whole-job CI budgets; individual tests and production deadlines remain unchanged. Each qualification receipt records the selected command budget.

Posthorse's official lane requires its clear native startup refusal. Its fork lane requires rollover, recovery history and checkpoint restore. Applicable fork capabilities must fail when absent. The kit's Unix terminal contract exercises the current fork's managed launcher restart; its legacy multi-session helper is not activated inside that launcher.

**Windows qualification is owner-waived for this rollout (September 21, 2026).** Windows matrix jobs remain visible diagnostics and retain their actual failures and artifacts, but they do not gate merges or releases. The Windows environment self-check is also non-blocking. This waiver is not a Windows pass or a claim that the known Browser process-coordination failures are fixed. Linux/macOS, Node floors, host identity, consumer artifacts and the three owner-designated final reviews remain required. Restore the Windows gate through a reviewed follow-up after the recorded failures are resolved.

The previous official target is a diagnostic comparison when it differs from a candidate; it is not a blanket promise of historical support. Node/OS lanes are selected by the fleet and existing repository-specific workflows. Additional platform lanes use the latest Node 24 release; the primary platform also tests the declared Node floor. Native `setup-node` version resolution checks for the latest release matching each selector rather than accepting an older runner-cache entry; exact floor selectors remain exact. Routine checks use empty profiles and no provider credentials. These results do not certify live browser, Cursor, Oracle, OAuth or desktop operations. Those existing release gates remain separate when a shipped change touches their behavior. An unavailable platform must be recorded as unqualified or explicitly waived, never counted as passed.

Windows jobs initialize `PSModulePath` through the runner's native PowerShell shell (`pwsh`) and carry its value into bash using GitHub's environment file. Isolation retains that native module path alongside Windows runtime variables; HOME, configuration and temp roots remain private, without inherited credentials. The diagnostic `windows-environment` self-check uses the same setup and runs a real `Get-Process` identity query under that isolation via bash. It warms ambient PowerShell once to separate cold CLR startup from the environment regression, then enforces the consumer's 5-second query bound. The `automation` aggregate excludes this owner-waived native diagnostic; its outcome is never presented as required Windows qualification.

## Results and the maintenance loop

`compatibility` is the stable aggregate job. It requires resolution, the fork artifact when applicable, and every required matrix lane. Cancellation, missing jobs and required-lane failures do not become successful qualification. GitHub checks and job summaries show the result; `qualification-*` artifacts contain per-lane provenance, failures, consumer CLI output and tested npm tarballs.

The scheduled `Pi release canary` checks all default branches against the latest stable release and the maintained fork, including the existing owned npm releases. It uses Actions concurrency and updates one native GitHub issue per affected repository/host identity. A failed runner without package evidence gets an infrastructure issue. A complete green fleet closes resolved reports. The canary creates no repair PR, publishes nothing, and never updates a user's Pi installation.

Repairs use the repository's ordinary PR process. A fixture or host-selection failure is repaired there; a product failure gets a focused regression and source fix. The automation's own native tests deliberately introduce factory/startup failures and require the real bundled CLI to reject them, proving that the gate cannot pass solely because a process started. Metadata tests cover incomplete publication and exact cohort selection; resolver-entrypoint tests cover default and fork-only lanes, source refs and fail-closed selection with mocked external fetches; report tests cover deduplication and distinct official/fork identities.

## Rollout and administration

1. Qualify the full candidate fleet on PR branches. `PI_COMPATIBILITY_SOURCE_REF` may temporarily select the coordinated rollout branch in this repository and the fork; clear it after the extension branches merge.
2. Obtain the required owner-designated reviews before merging or activating the rollout. Publish the shared workflow's version tag only after approval, then keep callers pinned to its reviewed commit.
3. Install the managed Renovate App for the selected repositories, using the owner's normal GitHub authentication. Do not run a second dependency updater.
4. Require each repository's actual successful aggregate compatibility check on its default branch, preserving existing protection and useful required checks. The fork includes reverse-dependency qualification in its existing `build-check-test` aggregate.
5. Set this repository's `PI_COMPATIBILITY_ENABLED` Actions variable to `true` to enable the canary, and run it once manually. Until then both its scheduled and manual entrypoints remain disabled.

A dev-baseline-only change does not require a new npm release. For a shipped fix on an owned npm channel, publish the exact checked tarball and verify package/tag/source identity; retain any package-specific live release gates. Git-only packages stay Git-delivered. Consumer updates use normal Pi package updates and a fresh process or the fork's native restart. Qualification itself never activates code.

## Local checks

Node 24 runs the native Renovate validator. Pi host qualification and the unit/native tests also run on Node 22.19; the standalone CLI's host-free lane additionally runs on Node 20.

```sh
npm ci --ignore-scripts
npm rebuild re2
npm test
npm run check:renovate
actionlint
PI_TEST_HOST=/path/to/installed/pi-consumer npm run test:native

node scripts/qualify.mjs --repo pi-calculator --source /path/to/checkout \
  --host official --target 0.86.1 --output /tmp/pi-qualification

node scripts/pack-fork.mjs /path/to/built/fork /tmp/fork-package FULL_FORK_SHA
node scripts/qualify.mjs --repo pi-calculator --source /path/to/checkout \
  --host fork --target /tmp/fork-package --output /tmp/pi-fork-qualification
```

A Pi consumer directory contains its own `node_modules/@earendil-works/pi-coding-agent` installation, not a manually linked dependency tree. Fork packing requires the native offline build first. Local qualification copies uncommitted tracked/untracked source into a disposable checkout; CI checks immutable commits. Evidence records when a local source checkout was dirty.
