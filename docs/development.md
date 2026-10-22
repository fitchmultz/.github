# Work on the automation

[Back to the README](../README.md) · [Qualification reference](qualification.md)

The automation package is private and is used directly from this repository. Its Node engine ranges and reviewed npm version are in [`package.json`](../package.json). Use Node 24 and the npm version from `packageManager` for the complete local validation sequence below.

## Local checks

Node 24 runs the native Renovate validator. Pi host qualification and the unit/native tests also run on Node 22.22.2, the floor required by the pinned npm 12 release.

```sh
npm ci --ignore-scripts
npm rebuild re2
npm test
npm run check:renovate
actionlint
PI_TEST_HOST=/path/to/installed/pi-consumer npm run test:native

node scripts/qualify.mjs --repo pi-calculator --source /path/to/checkout \
  --host official --target latest --output /tmp/pi-qualification

node scripts/pack-fork.mjs /path/to/built/fork /tmp/fork-package FULL_FORK_SHA
node scripts/qualify.mjs --repo pi-calculator --source /path/to/checkout \
  --host fork --target /tmp/fork-package --output /tmp/pi-fork-qualification
```

A prepared Pi host contains its own native npm installation. Only disposable development consumers use npm-managed directory links to that external installation; no dependency tree is hand-linked. Fork packing requires the native offline build first and a new output directory; it never rebuilds or replaces an existing output. Repository-local output is allowed only inside the fork's `.artifacts` directory. The native artifact manifest, hash-suffixed `tarballs/` archives, exact source `install-lock/` inputs and applied root manifest/lock are retained alongside `receipt.json`; full SHA-256 digests cover all installer inputs and physical archives, and native SHA-512 integrities bind archives to lock entries. Local qualification copies uncommitted tracked/untracked source into a disposable checkout; CI checks immutable commits. Evidence records when a local source checkout was dirty.

## CI scope

Every automation PR and push to `main` resolves the latest hosts, runs unit/native CLI checks on Node 22.22.2 and 24, validates Renovate configuration, and runs actionlint. The required `automation` check joins those results with the scope decision and, when required, the full fleet.

Documentation (`README.md`, `docs/`, `.github/readme/`) and the two Renovate JSON files do not need fleet qualification. Package manifest/lock changes take this fast path only when both Git revisions prove that Renovate is the sole development dependency, every locked package is development-only, and all other manifest fields, scripts and root lock metadata are unchanged. Unknown package layouts take the full path.

All scripts, tests and workflows (including the scope selector), `fleet.json`, and unknown paths require the full 24-repository fleet: 82 Linux and macOS lanes by default on PRs, pushes, manual dispatches and the daily canary. Full native Windows qualification is best-effort and requires an explicit `waived-platforms: true` opt-in, adding eight diagnostic lanes (90 total). Deleting or renaming runtime files still requires the fleet. PR comparisons use the Git merge base; pushes compare the previous commit with the pushed head. Missing refs or failed scope/local checks cannot produce a passing `automation` result. The Windows environment diagnostic runs only on the full path and remains best-effort and nonblocking.

An intentional fleet skip is **not** qualification of package code or a new Pi host. Individual package callers and the canary still qualify all required lanes. Manual `Automation CI` dispatches always qualify the full required fleet and a supplied candidate fork; Windows diagnostics are included only when explicitly requested. GitHub's native account/runner limits govern parallelism; the reusable workflow does not impose an additional six-lane cap.

Inspect a committed change locally:

```sh
node scripts/ci.mjs scope --event push --base "$(git rev-parse HEAD^)" --head "$(git rev-parse HEAD)"
node scripts/ci.mjs --help
```
