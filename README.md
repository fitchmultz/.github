# Shared Pi automation

This repository provides GitHub Actions checks, a Renovate preset, and npm release automation for Mitch's Pi packages. Connect your package repository with the [setup guide](docs/integration.md).

![An extension PR resolves exact Pi hosts, tests separate official and maintained-host lanes, and joins their results in the compatibility check.](.github/readme/qualification.png)

An extension PR tests the same source against both Pi hosts before the compatibility check reports a result.

## Use the shared automation

Each package repository keeps its source, lockfile, and `check:compat` command.

1. Add the compatibility workflow to your repository. Pin the workflow and `automation-ref` to the same reviewed commit.
2. Add this preset to your repository's `renovate.json`:

   ```json
   {
     "$schema": "https://docs.renovatebot.com/renovate-schema.json",
     "extends": ["github>fitchmultz/.github:pi-extensions"]
   }
   ```

3. Give the Renovate GitHub App access to your repository. Open a PR. Check its compatibility result.

The preset groups updates for Pi development dependencies and shared workflows. It does not enable automerge.

## Package checks

Normal extension PRs test the latest stable official Pi and maintained `fitchmultz/pi` main. Each run resolves both host identities once.

Each extension lane runs package contracts, installs a fresh Git checkout with production dependencies, and loads extensions and themes through the real Pi CLI. Owned npm channels also test a tarball install and compare its tools, commands, and providers with the Git install. Skills packages retain their resource contracts.

The checks use empty profiles without provider credentials. Keep each package's separate browser, desktop, and paid-provider release checks.

Windows checks remain owner-waived diagnostics. Review those diagnostics before you claim Windows support. The [qualification reference](docs/qualification.md) records the waiver, host preparation, lane settings, and command budgets.

## Results and failures

Read the compatibility check in GitHub Actions. Download its `qualification-*` artifacts to find the tested source, exact hosts, failed phase, and consumer output. Missing evidence, cancellation, or a failed required lane prevents a successful result.

The Pi release canary checks repository default branches and published npm versions. It updates one issue per affected repository. Set `PI_COMPATIBILITY_ENABLED=true` in this repository's Actions variables to enable it.

The canary reports failures without publishing packages or changing Pi installations. Fix failures through the affected repository's normal PR process.

## npm releases

Release only the package names in [fleet.json](fleet.json). Choose a stable version. Add a versioned changelog entry in a PR.

After the PR merges, the release workflow verifies one candidate tarball on both Pi hosts. Browser Native, Oracle, and Cursor also require manual evidence and approval of the `npm` environment.

The release workflow does not republish existing versions. README updates need no release. Follow the [npm release guide](docs/npm-releases.md) for setup, candidate downloads, and recovery.

## Contribute

Use Node 24. Run the unit tests from a checkout:

```sh
npm test
```

Follow the [development guide](docs/development.md) for dependency setup, native CLI tests, Renovate validation, and local qualification.
