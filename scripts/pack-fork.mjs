import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run, sha256, writeJson } from "./common.mjs";

const usage = `Usage: node scripts/pack-fork.mjs SOURCE OUTPUT EXPECTED_SHA
Pack a built fork's public workspaces and write OUTPUT/receipt.json.
SOURCE and OUTPUT are relative to the caller's directory. EXPECTED_SHA must match SOURCE's Git HEAD.
Run the fork's offline build before packing.
Example: node scripts/pack-fork.mjs ./fork ./fork-package FULL_FORK_SHA
Exit codes: 0 success/help; 1 invalid arguments, ref mismatch or packing failure.`;
if (["-h", "--help"].includes(process.argv[2])) {
  console.log(usage);
  process.exit(0);
}
const [sourceArg, outputArg, expectedRef] = process.argv.slice(2);
assert.ok(sourceArg && outputArg && expectedRef, usage);
const source = resolve(sourceArg);
const output = resolve(outputArg);
const ref = run("git", ["rev-parse", "HEAD"], { cwd: source, quiet: true }).trim();
assert.equal(ref, expectedRef);
process.chdir(source);
const { getPublicWorkspacePackages } = await import(pathToFileURL(join(source, "scripts/release-packages.mjs")));
const { packReleasePackages } = await import(pathToFileURL(join(source, "scripts/coding-agent-consumer.mjs")));
mkdirSync(output, { recursive: true });
const packages = getPublicWorkspacePackages();
const tarballs = packReleasePackages(packages, output);
writeJson(join(output, "receipt.json"), {
  ref,
  node: process.version,
  npm: run("npm", ["--version"], { cwd: source, quiet: true }).trim(),
  lockSha256: sha256(join(source, "package-lock.json")),
  modelDataManifestSha256: sha256(join(source, "packages/ai/src/providers/data/.manifest.json")),
  packages: packages.map(({ name, version }) => ({ name, version, file: basename(tarballs.get(name)), sha256: sha256(tarballs.get(name)) })),
});
