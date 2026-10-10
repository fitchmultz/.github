import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codingAgent, readJson, run, sha256, writeJson } from "./common.mjs";

const usage = `Usage: node scripts/pack-fork.mjs SOURCE OUTPUT EXPECTED_SHA
Pack a built fork's public workspaces and write OUTPUT/receipt.json.
SOURCE and OUTPUT are relative to the caller's directory. EXPECTED_SHA must match SOURCE's Git HEAD.
OUTPUT must not exist; repository-local output must be inside SOURCE/.artifacts.
Run the fork's offline build before packing.
Example: node scripts/pack-fork.mjs ./fork ./fork-package FULL_FORK_SHA
Exit codes: 0 success/help; 1 invalid arguments, ref mismatch or packing failure.`;
if (["-h", "--help"].includes(process.argv[2])) {
  console.log(usage);
  process.exit(0);
}
const [sourceArg, outputArg, expectedRef] = process.argv.slice(2);
assert.ok(sourceArg && outputArg && expectedRef && process.argv.length === 5, usage);
const source = resolve(sourceArg);
const output = resolve(outputArg);
const ref = run("git", ["rev-parse", "HEAD"], { cwd: source, quiet: true }).trim();
assert.equal(ref, expectedRef);
const installSource = "packages/coding-agent/install-lock";
for (const file of ["package.json", "package-lock.json"]) {
  assert.equal(readFileSync(join(source, installSource, file), "utf8"),
    run("git", ["show", `${ref}:${installSource}/${file}`], { cwd: source, quiet: true }), `Installer input differs from exact source: ${file}`);
}
const { produceArtifactSet } = await import(pathToFileURL(join(source, "scripts/package-artifacts.mjs")));
const { wireConsumer } = await import(pathToFileURL(join(source, "scripts/local-package-install.mjs")));
const artifactSet = produceArtifactSet({ repoRoot: source, outDir: output, build: false });
assert.deepEqual(artifactSet.source, { commit: ref, dirty: false });
const { packages } = artifactSet;
mkdirSync(join(output, "install-lock"));
for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(source, installSource, file), join(output, "install-lock", file));
copyFileSync(join(output, "install-lock/package.json"), join(output, "package.json"));
const manifest = wireConsumer({ artifactSet, consumerDirectory: output, packageNames: [codingAgent] });
const lock = readJson(join(output, "install-lock/package-lock.json"));
lock.packages[""].dependencies = manifest.dependencies;
for (const [path, entry] of Object.entries(lock.packages)) {
  const artifact = packages.find((pkg) => pkg.name === path.split("node_modules/").at(-1));
  if (!artifact) continue;
  assert.equal(entry.version, artifact.version, `Source installer/artifact version mismatch: ${artifact.name}`);
  entry.resolved = manifest.overrides[artifact.name];
  entry.integrity = artifact.integrity;
}
writeJson(join(output, "package-lock.json"), lock);
writeJson(join(output, "receipt.json"), {
  ref,
  node: process.version,
  npm: run("npm", ["--version"], { cwd: source, quiet: true }).trim(),
  lockSha256: sha256(join(source, "package-lock.json")),
  artifactManifestSha256: sha256(join(output, "manifest.json")),
  installFiles: Object.fromEntries(["package.json", "package-lock.json", "install-lock/package.json", "install-lock/package-lock.json"]
    .map((file) => [file, sha256(join(output, file))])),
  modelDataManifestSha256: sha256(join(source, "packages/ai/src/providers/data/.manifest.json")),
  packages: packages.map(({ name, version, tarball, tarballPath, integrity }) => ({ name, version, file: tarball, integrity, sha256: sha256(tarballPath) })),
});
