# Shared Pi automation

This repository gives Mitch's Pi packages a shared set of GitHub Actions checks, dependency updates and npm release automation. To use it in a fleet repository, add the [reusable workflow and Renovate preset](docs/integration.md); contributors can [run the automation tests locally](docs/development.md).

![An extension PR resolves exact Pi hosts, runs separate official and maintained-fork lanes, and joins them in the compatibility check.](.github/readme/qualification.png)

An extension PR tests the same source against both Pi hosts; the compatibility check collects the required lane results.

## Start using it

Each package keeps its own source, lockfile and `check:compat` command. This repository supplies the shared workflows and the [fleet inventory](fleet.json).

1. Follow the [repository setup guide](docs/integration.md) to connect the compatibility workflow. Use one reviewed automation commit for the workflow and its scripts.
2. Add the shared preset to your repository's `renovate.json`:

   ```json
   {
     "$schema": "https://docs.renovatebot.com/renovate-schema.json",
     "extends": ["github>fitchmultz/.github:pi-extensions"]
   }
   ```

3. Give the managed Renovate GitHub App access, then open a PR and check its compatibility result. The preset groups Pi development dependencies and shared workflow updates; it does not enable automerge.

## What gets checked?

Normal extension PRs test the **latest stable official Pi** and the **maintained `fitchmultz/pi` main**. Host identities are resolved once for the run, so later jobs keep using the same official version and fork commit. A fork integration can select its exact candidate commit instead.

Each applicable Node/platform lane runs:

- The package's own compatibility contracts.
- A fresh Git checkout with production dependencies and its normal install lifecycle.
- The selected host's real Pi CLI, including extension loading and shipped-theme discovery.
- For owned npm channels, a packed tarball install and a comparison of its tools, commands and providers with the Git install.

Skills retain their resource contracts. These offline checks use empty profiles and no provider credentials; authenticated browser, desktop and paid-provider release checks remain package-specific.

**Windows qualification is currently owner-waived.** Windows jobs remain visible diagnostics; Linux/macOS and the other required gates still apply. The [qualification reference](docs/qualification.md#qualification) records the waiver, preparation details and per-package budgets.

## Find results and failures

Look for the **compatibility** aggregate in GitHub Actions. Its job summary and `qualification-*` artifacts show the tested source, exact hosts, failed phase and consumer output. Missing evidence, cancellation or a failed required lane prevents a successful result.

The scheduled **Pi release canary** checks fleet default branches and existing owned npm releases. It maintains one issue per affected repository and closes it when every required lane passes with complete evidence. It must be enabled through the repository's Actions variable; [administration steps](docs/integration.md#rollout-and-administration) cover that setup.

The canary reports problems without publishing packages or updating anyone's Pi installation. Fixes go through the affected repository's normal PR process.

## Release an npm package

The [fleet inventory](fleet.json) identifies owned npm channels and whether they publish automatically or need maintainer approval. A release starts with an intentional stable version and versioned changelog entry in a PR.

After the PR merges, the release pipeline checks the resolved Pi hosts, builds one candidate tarball and verifies that same archive on both hosts before publishing. Browser Native, Oracle and Cursor also require their existing manual evidence and approval of the `npm` environment.

**An already-published version does not publish new source changes.** A README-only update needs no version bump. The [npm release guide](docs/npm-releases.md) covers trusted publishing, first publication, candidate downloads and safe recovery.

## Contribute

Use Node 24. The repository's [development guide](docs/development.md) covers dependency setup, native CLI tests, Renovate validation and local qualification. The unit tests can run directly from a checkout:

```sh
npm test
```

Changes to shared automation run fleet-wide checks in this repository's PR CI. Packages keep their own tests and release requirements.

## Guides and source

- [Repository setup and administration](docs/integration.md)
- [Qualification details, platform waiver and troubleshooting evidence](docs/qualification.md)
- [npm release setup and recovery](docs/npm-releases.md)
- [Local development and reproduction commands](docs/development.md)
- [Reusable workflows](.github/workflows/) · [Automation scripts](scripts/) · [Renovate preset](pi-extensions.json)
