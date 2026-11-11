# npm release guide

[Back to the README](../README.md) · [Repository setup](integration.md)

## Automatic releases

[`fleet.json`](../fleet.json) lists the owned npm channels. A repository's callers enable its channel only after its existing release qualifications can run for the exact publication source. A fleet entry or a green offline compatibility check alone is not proof that a package is ready to publish.

Installing `.github/workflows/npm-version.yml` enables the automatic queue below. A repository that has not installed it can continue publishing manually versioned, merged PRs through its existing pinned release caller; its release source defaults to the publication commit. The holds described below apply when adopting this automation revision.

1. A merge to `main` enters the version queue. The first queued commit installs the version workflow; later source commits are processed in first-parent order, even if the first run is delayed. Commits that a version PR merged from `main` before it merged ship in its release, so the queue resumes after the latest published commit. A release happens only when the installable package changes. Before it opens a version PR, the workflow builds and packs current `main` with the release preparation steps, in an environment without credentials. It downloads the latest published tarball, verifies it against the registry integrity, and compares the two. No version PR opens when every packed file has the same bytes and executable bits, apart from `CHANGELOG.md`, `changelog.d/`, and the `package.json` fields that an installation does not use: `version`, `devDependencies`, and every script except the install lifecycle (`preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`). Commits that change only CI workflows, tests or development tooling therefore stay unreleased. The next version that changes the package starts from the oldest unreleased commit and lists all of them in its notes. A release proceeds whenever the comparison cannot prove the package unchanged: the build or download fails, or the build is not reproducible. The comparison runs only when a new version PR would open, not while a version PR is open or a release is in flight. An operator's supersession dispatch opens its replacement without the comparison, because the failed version blocks every later release until a replacement merges. When `main`'s repository files match the latest release apart from version metadata (`package.json` and `package-lock.json` versions, `CHANGELOG.md`, and `changelog.d/*.md` fragments), nothing is built: no version PR opens, and an open version PR that adds only version metadata is closed and its branch deleted without being updated. The workflow verifies the preceding aligned npm/GitHub release and waits for each automatic version to appear on both registries before starting another.
2. A repository-scoped GitHub App opens a version PR. It chooses the next stable patch above the manifest, npm versions and existing tags; updates `package.json` and `package-lock.json`; and writes a versioned changelog section. The section starts with curated notes: `Unreleased` notes from `CHANGELOG.md` followed by sorted `changelog.d/*.md` fragments (excluding `changelog.d/README.md`), inside a `<!-- npm-release:unreleased:start -->` / `<!-- npm-release:unreleased:end -->` block, and removes the consumed `changelog.d/*.md` files. Fragment note content nests under the version heading exactly like generated notes: level-2 `##` heading lines are published as `###`, including inside code fences, so note content cannot end the version section. The text after the curated blocks is generated: a line for the source commit, then GitHub's release notes from the previous published tag to `main`. The original source commit remains recorded even when `main` advances during review.
3. The PR is updated to current `main`. Each update merges `main`'s `Unreleased` notes and `changelog.d/*.md` fragments into the curated block, removes newly consumed fragment files, and regenerates the text after the curated blocks, so the section lists every change the version ships. Hand edits to the generated text are replaced on the next update; curated text belongs inside the blocks. Pi Durable addresses failed checks and review findings on the existing version branch, replying to each finding and resolving its thread. It reads complete Cursor run reports, including reports from earlier PR heads and findings not posted as comments. Each source has one durable operation, plus at most one request in the same chat to restate a malformed final disposition; a native completion alone does not establish that a GitHub change or reply happened. The workflow verifies replies and resolved threads, and binds merge to the handled current Cursor check and the current Pi-reviewed base/head. A completed Pi finding review receives an empty recheck commit once its findings are addressed. A Cursor review that completes without a report, as Cursor's automation errors do, also receives one empty recheck commit; if the review of that recheck commit has no report either, the workflow fails and names the Cursor check instead of waiting. Actual compatibility checks and GitHub branch rules still apply.
4. After the version PR merges, the repository's `npm-release.yml` plans from that exact main event. Only the reviewed version PR's merge commit can create or resume that automatic release; later main commits start the next version PR. The planner freezes the latest official Pi version and maintained fork commit for that run. Preparation selects any recognized original draft tarball first, or builds a new candidate without publication credentials. It installs the **same tarball** into independent consumers of both hosts and exercises their bundled Pi CLIs. The candidate, host identities and checksum are retained as workflow artifacts.
5. Packages with additional release requirements run their own exact-source and exact-candidate gates before publication. Their `Release qualification` job uses the shared `qualify` command to bind the source, tarball, host receipt and workflow run in an artifact. The qualified publisher verifies that artifact and the successful job before releasing. Legacy callers without additional gates use the ordinary shared publisher.
6. Publication rechecks package ownership, environment, source ancestry, tag and tarball identity. It creates an annotated tag and draft GitHub Release, publishes the candidate with npm trusted publishing, verifies registry integrity, and finalizes the GitHub Release. The tag, release, package version and npm provenance identify the verified publication source. A release completion wakes the version queue so later merges are not stranded.

Version PRs and their release notes are generated automatically; maintainers can write curated notes as `changelog.d/*.md` fragments (so concurrent PRs do not conflict on `CHANGELOG.md`) or under `## Unreleased` in `CHANGELOG.md`. Write fragments as list items or `###` sections; any level-2 `##` heading line in a fragment is published nested as `###`. Package lifecycle scripts are disabled during the final credentialed `npm publish`, so each caller must provide any additional release gate before invoking the shared publisher:

- **pi-subagents:** its packed entry must load through real Pi and exercise an actual native child session on the selected hosts; a loader-only smoke is not equivalent.
- **pi-agent-browser-native:** its own release verification includes the configured-source Pi lifecycle and required macOS/Ubuntu Crabbox smoke; its release instructions also require real-site dogfood. The shared host checks do not replace them.
- **pi-oracle:** its `release:check` requires eight actual ChatGPT preset jobs for the exact post-merge HEAD and its doctor-first macOS, Ubuntu and native Windows platform suites. A PR-head run or offline test is not equivalent.
- **pi-cursor-sdk:** its release instructions require a deep maintainability review of the exact release diff, with findings addressed and review repeated until clear, in addition to applicable verification.
- **pi-zai-mcp:** its release and completion checks include the production `npm audit`, which is not part of `check:compat`.
- **pi-codex-goal:** release-sensitive changes require interactive real-model `/goal` session evidence, which offline compatibility does not provide.
- **pi-posthorse:** delivery requires independent evidence that the complete verification workflow rejects each documented class of bad change.
- **pi-mcp-adapter:** the packed candidate must pass its real tool/SDK and consumer-type checks, not only a separately packed CI build.

The shared versioner and publisher hold these eight channels until their additional gates are wired; Cursor also needs its required pre-commit and pre-push review. Once a caller includes its exact-candidate gate, it passes `package-qualified: true` to the version workflow and routes publication through the shared qualified publisher. The publisher independently verifies the gate's successful run and candidate receipt. Other package-specific requirements remain in their repositories and are not waived by this guide. If a package defines `release:dry-run`, preparation runs it without publication credentials before packing.

Automated package checks use offline proof unless the changed behavior needs real inference. Necessary calls use direct `zai/glm-5.3-flash`. The Pi Durable remediator selects that model on its task-owned chat before submitting new work, independently of the owner's defaults for ordinary chats.

## Recovery

Idempotent `GET` and `HEAD` requests retry transient transport failures and HTTP `502`, `503` and `504` responses before failing; writes are never retried automatically. When fetch still rejects, version and remediation clients report the service, HTTP method and public endpoint, followed by Node's native error and cause details. Endpoint diagnostics omit URL credentials, query strings and fragments; request headers and bodies are not logged. Invalid or credential-bearing request URLs fail without echoing their input. A transport failure does not establish whether a remote write completed. Inspect its effects before retrying.

A scheduled reconciliation and a manual dispatch on `main` retry incomplete work. Without an explicit supersession request, pending source commits are not assigned new versions while the latest automatic release is incomplete. An existing npm version is never republished with different bytes. For a recognized unfinished draft, preparation recovers the original tarball and receipt, verifies their GitHub digests, and requalifies those same bytes against the selected hosts and package gates before the publisher finishes that version. A conflicting tag, release, identity or integrity fails closed.

For an incomplete release, reconciliation reruns its original `npm-release.yml` run so the GitHub Actions SHA and npm provenance remain aligned. A failed-job rerun can reuse a previously successful qualification from that run when the candidate and host receipt match and GitHub reports the same job execution times. GitHub limits [workflow reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) to 30 days and 50 attempts. If the original run is unavailable and `main` has advanced past the reviewed version commit, a later main dispatch cannot substitute for it, whether or not a draft exists; investigate rather than moving a tag or overwriting an npm version. Successful npm publication may take time to become visible; the publisher verifies the exact version and `latest` before finalizing the GitHub Release.

### Replace a failed unpublished version with fixed source

When an automatic release fails because its source needs a fix, merge the fix through the repository's normal PR process. Adopt a reviewed automation revision that supports the paired `supersede-version` and `supersede-source` inputs. Add these optional string inputs to the caller's existing `workflow_dispatch` and forward them to `.github/workflows/npm-release-bump.yml`:

```yaml
on:
  workflow_dispatch:
    inputs:
      supersede-version:
        description: Failed unpublished automatic version
        required: false
        type: string
        default: ''
      supersede-source:
        description: Failed automatic version merge SHA
        required: false
        type: string
        default: ''
```

Add the forwarding entries to the existing reusable version job's `with` block. Keep its other inputs, secrets, events, and immutable pins unchanged.

```yaml
with:
  supersede-version: ${{ inputs.supersede-version || '' }}
  supersede-source: ${{ inputs.supersede-source || '' }}
```

Dispatch the repository's `npm-version.yml` on `main`, supplying both values:

```sh
gh workflow run npm-version.yml --repo fitchmultz/REPO --ref main \
  -f supersede-version=FAILED_VERSION \
  -f supersede-source=FAILED_VERSION_MERGE_SHA
```

`supersede-source` is the full merge SHA of the failed automatic version PR, not its earlier `pi-npm-source` queue marker. The versioner verifies that pair against the latest genuine Bot-authored automatic version. The exact version must be absent from npm, any GitHub release for it must still be a draft, and its latest original main `npm-release.yml` run must have completed with failure. Only an operator dispatch of the trusted main `npm-version.yml` caller can request a replacement. An ordinary later commit cannot become the old version's publication source.

The existing release App opens a normal version PR from current fixed `main`. The native version selector chooses a new stable patch above the manifest, every npm version, and all version tags. Generated notes span the previous published tag through fixed main. The new section copies the unpublished version's curated notes outside its mutable pending block, before generated notes, leaving the old version's full section unchanged. A `<!-- npm-release:carried:start -->` / `<!-- npm-release:carried:end -->` block holds these cumulative curated notes. If a replacement also fails unpublished, the next recovery copies its carried block plus its own pending notes, not its generated notes. Original automatic versions have no carried block. Maintainers can edit curated text inside the blocks while retaining their markers. Only current `Unreleased` notes enter the pending block. Every main update uses the same changelog note merge, whether Git reports a clean merge or a conflict, so appended and prepended main notes stay in that recoverable block before review. The new section and PR identify the superseded version and merge SHA.

The PR's `pi-npm-supersedes` marker lets ordinary check, schedule, and reconciliation events resume that same replacement PR without repeating dispatch inputs. The versioner rechecks that the old version remains unpublished and its original release run remains failed. Pre-commit and pre-push reviews, remediation, current-head CI and Pi/Cursor reviews, resolved threads, prospective candidate review, and package-specific gates remain in place. Post-merge release planning still admits only the new genuine version merge. No supersession input reaches the publisher.

Supersession does not rerun, delete, relabel, or overwrite the old commit, branch, tag, draft, assets, candidate, or failed run. Those records keep their original version and source identity. Only the new version can publish the fixed bytes. Once that replacement publishes on npm and GitHub, the ordinary version queue resumes after its merge.

### Resume review remediation

An incomplete Pi review with settled, non-uncertain comment effects is recovered through Pi Durable's native single-PR reconciliation. The version workflow observes the resulting check rather than treating admission as success. For each feedback source it records the prompt's reviewed automation revision and digest in archived Pi Durable metadata before submitting; retries reconstruct that exact prompt and reject changed source data. An unanswered or uncertain remediation stays visible and is not automatically replayed; inspect the original operation and external effects. If a completed remediation does not end with a valid single-line JSON disposition, the workflow asks once, in the same Pi Durable chat, for only that line. Every source of the PR shares that chat, so the request names its source and quotes the malformed line. If the answer is not valid either, the workflow fails and names both operations; inspect them and their effects, then close the version PR so reconciliation opens a new one with new operations. A version-branch update wakes reconciliation, and the schedule resumes work after a run ends. After a repeated Cursor error, push a new commit to the version branch once Cursor reviews normally again; the new head gets a fresh review. Canceled, missing, skipped, stale-head or stale-base checks do not pass.

## Repository setup

- Configure an `npm` environment restricted to `main`. Configure npm trusted publishing for the repository's caller filename `npm-release.yml` and environment `npm`; the reusable workflow authenticates as that caller. Existing packages use OIDC rather than an npm token.
- Configure a separate `release` environment restricted to `main` with `RELEASE_APP_PRIVATE_KEY`, `PI_DURABLE_ACCESS_TOKEN`, and `CURSOR_API_KEY`; set `PI_DURABLE_ORIGIN` to the HTTPS owner installation and `RELEASE_APP_CLIENT_ID` to the installed GitHub App client ID. The App's per-repository token needs contents and pull-request write access. The version workflow uses the ordinary GitHub token for check, pull-request and Actions reads/retries. The Pi Durable owner token has full installation authority and belongs only in the protected environment.
- The repository's `npm-version.yml` calls `.github/workflows/npm-release-bump.yml` at a reviewed immutable automation revision, passing that same revision as `automation-ref`, the App client ID, and all three named environment secrets. GitHub [requires the caller to pass each secret](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) by name even when it exists only in the called job's environment. Its events share a native queued concurrency group, and its job condition starts the reusable workflow only for an event that concerns a release:
  - a push to `main`, the schedule or a manual dispatch;
  - a Pi Durable or Cursor check run that completes on a version branch (`npm-version/…`);
  - a comment on a pull request that the release App opened;
  - an `npm-release.yml` run that completes, when a push did not start it or its commit is a version commit (`chore(release): …`).

  Every other check-run, comment and release-completion event skips the job and uses no runner. The events that start the job run trusted main automation in the main-only environment, never code from an untrusted PR.
- Cursor SDK also sets `version-reviewed: true` and maps `ZAI_API_KEY` and `CURSOR_CATALOG_API_KEY` from its main-only `release` environment. The catalog key runs the package's authenticated model-list check, which reads metadata without inference. It is separate from `CURSOR_API_KEY`, used to read Cursor automation reports. The Z.ai key reaches only the required independent review steps.
- After wiring Cursor SDK's exact-diff review commands, its caller also passes `version-reviewed: true` and the protected `ZAI_API_KEY` secret. Version creation and updates require successful pre-commit and pre-push receipts. Cursor remediation receives an isolated credential upload for those same reviews, not publication credentials.
- The `npm-release.yml` caller keeps its existing package jobs and forwards `source`, `release-source`, `official-version` and `fork-ref` from the shared planner. For packages with additional gates, it calls `npm-release-prepare.yml`, runs those gates against the uploaded `npm-candidate-${source}` and `npm-fork-host-${source}` artifacts, then runs the shared `qualify` command in a job named `Release qualification` and uploads its output as `npm-release-qualification`. Only after that job passes does it call `npm-release-qualified.yml`, granting `actions: read`, `contents: write` and `id-token: write`. Packages without additional gates can call the ordinary `npm-release.yml` reusable workflow. Publication runs from the exact main push or a rerun of that push. Every workflow reference and `automation-ref` uses the same reviewed revision.
- Before enabling the caller, verify that the latest npm version, its published GitHub release and tag, and the manifest at that tag agree, with the tag commit on main's first-parent history. The initial version queue starts at the caller's installation commit. Preserve all actual branch protections and package-specific qualification.

For Cursor SDK, successful current-head CI and PR reviews are followed by the prospective release review before the version PR can merge. The shared action prepares that exact version head, checks the authenticated catalog, captures the complete prior-published-tag-to-head diff and PR/issue context, runs the affected native Zod installer checks, and performs the required deep review with direct `zai/glm-5.3-flash`. Its artifacts retain the candidate and review receipts. Post-merge qualification still checks the actual main publication source; a pre-merge pass does not certify different bytes after merge.

To configure trusted publishing for an existing package:

```sh
npm trust github PACKAGE --repo fitchmultz/REPO --file npm-release.yml --env npm --allow-publish --yes
```

For a genuine first publication of an enabled owned scoped package, npm currently requires an environment-only `NPM_BOOTSTRAP_TOKEN`. The caller explicitly maps that optional secret; preparation and checks never receive it. The publisher verifies the authenticated account before making release writes, uses the token only for that first scoped publication, and retains provenance and integrity checks. Configure native trust and remove the temporary environment secret after publication. Registry responses other than a genuine 404 do not authorize this path.

Set `NPM_RELEASE_ENABLED=false` in a package repository to stop new release runs, and cancel already-running runs if a stop is needed. Never delete an existing npm version, move a conflicting tag, or replace a release asset to conceal an uncertain outcome. Prereleases and other dist-tags remain outside this stable automatic channel.

The read-only planner and candidate verifier can also run locally; `node scripts/npm-release.mjs --help` describes their inputs. `node scripts/npm-version.mjs --help` describes the Actions-only version commands and supersession inputs.
