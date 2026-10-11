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
