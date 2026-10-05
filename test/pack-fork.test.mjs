import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnvironment, writeJson } from "../scripts/common.mjs";

test("pack-fork packs only the pinned source from a parent cwd with relative source/output", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pack-fork-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "fork");
  const output = join(root, "artifacts");
  const env = { ...isolatedEnvironment(root), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const exec = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  cpSync(new URL("./fixtures/fork-pack", import.meta.url), source, { recursive: true });
  writeJson(join(source, "package.json"), { private: true, type: "module" });
  writeJson(join(source, "package-lock.json"), { lockfileVersion: 3, packages: {} });
  const data = join(source, "packages/ai/src/providers/data");
  mkdirSync(data, { recursive: true });
  writeJson(join(data, ".manifest.json"), { source: "packing contract" });
  writeJson(join(source, "packages/ai/package.json"), { name: "@pack-fork-test/private", version: "1.2.3", private: true });
  const publicDirectory = join(source, "packages/nested/public");
  mkdirSync(publicDirectory, { recursive: true });
  writeJson(join(publicDirectory, "package.json"), { name: "@pack-fork-test/public", version: "1.2.3", files: ["payload.txt"] });
  writeFileSync(join(publicDirectory, "payload.txt"), "built bytes from the pinned source\n");
  const callerDirectory = join(root, "packages/unrelated");
  mkdirSync(callerDirectory, { recursive: true });
  writeJson(join(callerDirectory, "package.json"), { name: "@pack-fork-test/unrelated", version: "9.9.9" });
  writeFileSync(join(callerDirectory, "payload.txt"), "must not be packed\n");

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

  exec(process.execPath, [cli, "fork", "artifacts", ref]);
  const receipt = JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"));
  assert.equal(receipt.ref, ref);
  assert.equal(receipt.node, process.version);
  assert.equal(receipt.lockSha256, hash(join(source, "package-lock.json")));
  assert.equal(receipt.modelDataManifestSha256, hash(join(data, ".manifest.json")));
  assert.deepEqual(receipt.packages.map(({ name, version, file }) => ({ name, version, file })), [
    { name: "@pack-fork-test/public", version: "1.2.3", file: "pack-fork-test-public-1.2.3.tgz" },
  ]);
  const tarball = join(output, receipt.packages[0].file);
  assert.equal(receipt.packages[0].sha256, hash(tarball));
  assert.deepEqual(readdirSync(output).sort(), ["pack-fork-test-public-1.2.3.tgz", "receipt.json"]);
  assert.equal(exec("tar", ["-xOf", tarball, "package/payload.txt"]), "built bytes from the pinned source");
  const packedManifest = JSON.parse(exec("tar", ["-xOf", tarball, "package/package.json"]));
  assert.equal(packedManifest.name, "@pack-fork-test/public");
  assert.equal(packedManifest.version, "1.2.3");
  assert.equal(exec("git", ["status", "--porcelain"], source), "");
  assert.deepEqual(readdirSync(callerDirectory).sort(), ["package.json", "payload.txt"]);
});
