import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run, sha256, writeJson } from "./common.mjs";

const [sourceArg, outputArg, expectedRef] = process.argv.slice(2);
assert.ok(sourceArg && outputArg && expectedRef, "Usage: pack-fork.mjs SOURCE OUTPUT EXPECTED_SHA");
const source = resolve(sourceArg);
const output = resolve(outputArg);
const ref = run("git", ["rev-parse", "HEAD"], { cwd: source, quiet: true }).trim();
assert.equal(ref, expectedRef);
const { getPublicWorkspacePackages } = await import(pathToFileURL(join(source, "scripts/release-packages.mjs")));
const { packReleasePackages } = await import(pathToFileURL(join(source, "scripts/coding-agent-consumer.mjs")));
mkdirSync(output, { recursive: true });
const packages = getPublicWorkspacePackages(join(source, "packages"));
const tarballs = packReleasePackages(packages, output);
writeJson(join(output, "receipt.json"), {
  ref,
  node: process.version,
  lockSha256: sha256(join(source, "package-lock.json")),
  modelDataManifestSha256: sha256(join(source, "packages/ai/src/providers/data/.manifest.json")),
  packages: packages.map(({ name, version }) => ({ name, version, file: basename(tarballs.get(name)), sha256: sha256(tarballs.get(name)) })),
});
