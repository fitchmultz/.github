import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { codingAgent, isolatedEnvironment, writeJson } from "../scripts/common.mjs";
import { prepareHost } from "../scripts/hosts.mjs";

test("pack-fork packs only the pinned source and native production lock from a parent cwd", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pack-fork-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "fork");
  const output = join(root, "artifacts");
  const env = {
    ...isolatedEnvironment(root),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
    ...(process.env.npm_execpath ? { npm_execpath: process.env.npm_execpath } : {}),
  };
  const exec = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  cpSync(new URL("./fixtures/fork-pack", import.meta.url), source, { recursive: true });
  writeJson(join(source, "package.json"), { private: true, type: "module", devDependencies: { yaml: "2.9.1" } });
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  writeJson(join(source, "package-lock.json"), { lockfileVersion: 3, packages: {} });
  const data = join(source, "packages/ai/src/providers/data");
  mkdirSync(data, { recursive: true });
  writeJson(join(data, ".manifest.json"), { source: "packing contract" });
  writeJson(join(source, "packages/ai/package.json"), { name: "@pack-fork-test/private", version: "1.2.3", private: true });
  const publicDirectory = join(source, "packages/nested/public");
  mkdirSync(publicDirectory, { recursive: true });
  writeJson(join(publicDirectory, "package.json"), {
    name: codingAgent, version: "1.2.3", files: ["payload.txt"],
    scripts: { prepack: "node -e \"process.exit(1)\"" },
  });
  writeFileSync(join(publicDirectory, "payload.txt"), "built bytes from the pinned source\n");
  const installSource = join(source, "packages/coding-agent/install-lock");
  mkdirSync(installSource, { recursive: true });
  const installManifest = { private: true, dependencies: { [codingAgent]: "1.2.3" } };
  const optional = { version: "1.0.0", resolved: "https://registry.npmjs.org/fixture-optional/-/fixture-optional-1.0.0.tgz",
    integrity: "sha512-optional-fixture", optional: true, os: ["darwin"], cpu: ["arm64"] };
  writeJson(join(installSource, "package.json"), installManifest);
  writeJson(join(installSource, "package-lock.json"), { lockfileVersion: 3, packages: {
    "": installManifest, [`node_modules/${codingAgent}`]: { version: "1.2.3" },
    "node_modules/fixture-optional": optional,
  } });
  const callerDirectory = join(root, "packages/unrelated");
  mkdirSync(callerDirectory, { recursive: true });
  writeJson(join(callerDirectory, "package.json"), { name: "@pack-fork-test/unrelated", version: "9.9.9" });
  writeFileSync(join(callerDirectory, "payload.txt"), "must not be packed\n");
  exec("npm", ["install", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"], source);

  exec("git", ["init", "--quiet", "--initial-branch=main"], source);
  exec("git", ["-c", "user.name=Pack test", "-c", "user.email=pack@example.invalid", "-c", "core.hooksPath=/dev/null",
    "add", "."], source);
  exec("git", ["-c", "user.name=Pack test", "-c", "user.email=pack@example.invalid", "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "-m", "Packing contract"], source);
  const ref = exec("git", ["rev-parse", "HEAD"], source);
  const cli = fileURLToPath(new URL("../scripts/pack-fork.mjs", import.meta.url));
  const refused = spawnSync(process.execPath, [cli, "fork", "refused", "0".repeat(40)], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /AssertionError/);
  assert.equal(existsSync(join(root, "refused")), false);
  const sourceLock = join(installSource, "package-lock.json");
  const sourceLockBytes = readFileSync(sourceLock);
  writeFileSync(sourceLock, "{}\n");
  const changedLock = spawnSync(process.execPath, [cli, "fork", "refused", ref], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(changedLock.status, 0);
  assert.match(changedLock.stderr, /Installer input differs from exact source/);
  assert.equal(existsSync(join(root, "refused")), false);
  writeFileSync(sourceLock, sourceLockBytes);

  exec(process.execPath, [cli, "fork", "artifacts", ref]);
  const receipt = JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"));
  assert.equal(receipt.ref, ref);
  assert.equal(receipt.node, process.version);
  assert.equal(receipt.npm, exec("npm", ["--version"], source));
  assert.equal(receipt.lockSha256, hash(join(source, "package-lock.json")));
  assert.equal(receipt.modelDataManifestSha256, hash(join(data, ".manifest.json")));
  assert.deepEqual(receipt.packages.map(({ name, version }) => ({ name, version })), [
    { name: codingAgent, version: "1.2.3" },
  ]);
  assert.match(receipt.packages[0].file, /^tarballs\/earendil-works-pi-coding-agent-1\.2\.3-[a-f0-9]{12}\.tgz$/);
  const tarball = join(output, receipt.packages[0].file);
  assert.equal(receipt.packages[0].sha256, hash(tarball));
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.source, { commit: ref, dirty: false });
  assert.deepEqual(manifest.packages, [{
    name: codingAgent, version: "1.2.3", tarball: receipt.packages[0].file,
    integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
  }]);
  assert.deepEqual(readdirSync(output).sort(), ["install-lock", "manifest.json", "package-lock.json", "package.json", "receipt.json", "tarballs"]);
  assert.deepEqual(readFileSync(join(output, "install-lock/package-lock.json")), sourceLockBytes);
  assert.equal(receipt.artifactManifestSha256, hash(join(output, "manifest.json")));
  for (const [file, digest] of Object.entries(receipt.installFiles)) assert.equal(hash(join(output, file)), digest);
  const consumerLock = JSON.parse(readFileSync(join(output, "package-lock.json"), "utf8"));
  assert.deepEqual(consumerLock.packages["node_modules/fixture-optional"], optional);
  assert.equal(consumerLock.packages[`node_modules/${codingAgent}`].integrity, manifest.packages[0].integrity);
  assert.equal(consumerLock.packages[`node_modules/${codingAgent}`].resolved, `file:./${receipt.packages[0].file}`);
  assert.equal(readdirSync(join(output, "tarballs")).length, 1);
  assert.equal(exec("tar", ["-xOf", tarball, "package/payload.txt"]), "built bytes from the pinned source");
  const packedManifest = JSON.parse(exec("tar", ["-xOf", tarball, "package/package.json"]));
  assert.equal(packedManifest.name, codingAgent);
  assert.equal(packedManifest.version, "1.2.3");
  assert.equal(exec("git", ["status", "--porcelain"], source), "");
  assert.deepEqual(readdirSync(callerDirectory).sort(), ["package.json", "payload.txt"]);

  const receiptBytes = readFileSync(join(output, "receipt.json"));
  const manifestBytes = readFileSync(join(output, "manifest.json"));
  const reused = spawnSync(process.execPath, [cli, "fork", "artifacts", ref], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /Output directory already exists/);
  const unsupported = spawnSync(process.execPath, [cli, "fork", "artifacts", ref, "--force"], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /Usage: node scripts\/pack-fork\.mjs SOURCE OUTPUT EXPECTED_SHA/);
  assert.deepEqual(readFileSync(join(output, "receipt.json")), receiptBytes);
  assert.deepEqual(readFileSync(join(output, "manifest.json")), manifestBytes);
  assert.equal(hash(tarball), receipt.packages[0].sha256);
  const installedLock = join(output, "package-lock.json");
  const installedLockBytes = readFileSync(installedLock);
  writeFileSync(installedLock, "{}\n");
  await assert.rejects(prepareHost(join(root, "host"), "fork", output, env), /Changed fork install input: package-lock.json/);
  writeFileSync(installedLock, installedLockBytes);

  const unsafe = spawnSync(process.execPath, [cli, "fork", "fork/unsafe-output", ref], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /Repository-local output directory must be inside/);
  assert.equal(existsSync(join(source, "unsafe-output")), false);
});
