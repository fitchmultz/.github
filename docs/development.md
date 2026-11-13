# Work on the automation

[Back to the README](../README.md) · [Qualification reference](qualification.md)

The automation package is private and is used directly from this repository. Its Node engine ranges and reviewed npm version are in [`package.json`](../package.json). Use Node 24.22.3 or a newer Node 24 release and the npm version from `packageManager` for the complete local validation sequence below.

## Local checks

Node 24 runs the native Renovate validator. Pi host qualification and the unit/native tests also run on Node 22.23.5, the security floor for the supported Node 22 line.

```sh
npm ci --ignore-scripts
npm rebuild re2
npm test
npm run check:renovate
npm run check:quality
actionlint
PI_TEST_HOST=/path/to/installed/pi-consumer npm run test:native

node scripts/qualify.mjs --repo pi-calculator --source /path/to/checkout \
  --host official --target latest --output /tmp/pi-qualification

node scripts/pack-fork.mjs /path/to/built/fork /tmp/fork-package FULL_FORK_SHA
node scripts/qualify.mjs --repo pi-calculator --source /path/to/checkout \
  --host fork --target /tmp/fork-package --output /tmp/pi-fork-qualification
```

A prepared Pi host contains its own native npm installation. Only disposable development consumers use npm-managed directory links to that external installation; no dependency tree is hand-linked. Fork packing requires the native offline build first and a new output directory; it never rebuilds or replaces an existing output. Repository-local output is allowed only inside the fork's `.artifacts` directory. The native artifact manifest, hash-suffixed `tarballs/` archives, exact source `install-lock/` inputs and applied root manifest/lock are retained alongside `receipt.json`; full SHA-256 digests cover all installer inputs and physical archives, and native SHA-512 integrities bind archives to lock entries. Local qualification copies uncommitted tracked/untracked source into a disposable checkout; CI checks immutable commits. Evidence records when a local source checkout was dirty.

## Strict quality scope

[`strict-quality-standard.md`](strict-quality-standard.md) is the adopted Strict Oxlint and Oxfmt Engineering Standard 5.1.2. Its adoption record lists the strict scope, locked tools and remaining migration work. `npm run check:quality` is the acceptance command for that scope. It runs the TypeScript compiler on checked JavaScript, type-aware Oxlint, a directive check, Oxfmt and a policy check that compares the configurations with the adopted copy. Relax a rule or limit only through a recorded quality exception under Section 2 of the standard.

The scope is `scripts/select-development-host.mjs`, `scripts/check-quality.mjs` and every repository module that the compiler resolves from them. A new import enters lint and formatting automatically. Also list it in the `tsconfig.json` `files`, because Oxlint gives compiler types only to listed files.

Extension CI selects the already-resolved official development host with the checked CLI:

```sh
node scripts/select-development-host.mjs --source /path/to/extension \
  --directory /tmp/extras-host --version X.Y.Z
```

It installs the exact official release with the canonical installer, selects that SDK/CLI graph for the source checkout and restores the checkout's `package.json` and `package-lock.json`. It writes `host.json` (installation provenance plus the selected identity) in the host directory and prints the selected identity as the last stdout line.

## CI scope

Every automation PR and push to `main` resolves the latest hosts, runs unit/native CLI checks on Node 22.23.5 and 24, validates Renovate configuration, runs actionlint and runs the strict quality check. The required `automation` check joins those results with the scope decision. PRs and manual dispatches run full or targeted fleet qualification when scope requires it; pushes to `main` intentionally skip the fleet because the pull request run already qualified the same content and the daily canary re-qualifies.

Changes that do not execute in `pi-compatibility.yml` skip fleet qualification (`fleet-required=false`): documentation (`README.md`, `docs/`, `.github/readme/`), Renovate configuration (`renovate.json`, `pi-extensions.json`), repository lint/format/compiler configuration and checker (`.gitignore`, `.oxfmtrc.json`, `.oxlintrc.json`, `tsconfig.json`, `scripts/check-quality.mjs`), npm release workflows/actions/scripts (`npm-publish`, `npm-release*.yml`, `npm-package.mjs`, `npm-release-core.mjs`, `npm-release.mjs`, `npm-version.mjs`, `release-fetch.mjs`), canary reporting and local diagnostics (`pi-canary.yml`, `report-canary.mjs`, `observe.ts`), unit/native test files (`test/`), and `fleet.json` edits that only remove entries or change release-only flags (`releaseQualification`, `versionQualification`).

Targeted qualification runs only the affected repositories instead of all 18:
- Editing compatibility fields on specific `fleet.json` entries (`repo`, `kind`, `npmPackage`, `npmRelease`, `os`, `nodes`, `extraPlatforms`, `contractTimeoutMs`) or adding entries qualifies only those `fitchmultz/<repo>` entries.
- Editing only `.github/workflows/ci.yml` or `scripts/ci.mjs` runs `fitchmultz/pi-calculator` to exercise the live `scope -> fleet -> automation` workflow handoff.

Every other path requires the full 18-repository fleet (`repository: all`, 56 Linux and macOS lanes). That includes `.github/workflows/pi-compatibility.yml`, `.github/workflows/resolve-hosts.yml`, `setup-linux-dns`, `qualify.mjs`, `cli-probe.mjs`, `probe-model.mjs`, `hosts.mjs`, `official-release.mjs`, `pack-fork.mjs`, `resolve-hosts.mjs`, `resolve-matrix.mjs`, `select-development-host.mjs`, `common.mjs`, `package.json`, `package-lock.json`, unreadable `fleet.json` diffs, deleted or renamed compatibility runtime files, and unknown paths. PR comparisons use the Git merge base; pushes compare the previous commit with the pushed head. Missing refs or failed scope/local checks cannot produce a passing `automation` result.

The `scope` job prints its decision and writes it to the job summary, listing any changed paths that required the fleet.

An intentional fleet skip is **not** qualification of package code or a new Pi host. Individual package callers and the canary still qualify all required lanes. Manual `Automation CI` dispatches always qualify the full required fleet and a supplied candidate fork. GitHub's native account/runner limits govern parallelism; the reusable workflow does not impose an additional six-lane cap.

Inspect a committed change locally:

```sh
node scripts/ci.mjs scope --event push --base "$(git rev-parse HEAD^)" --head "$(git rev-parse HEAD)"
node scripts/ci.mjs --help
```
