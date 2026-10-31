import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const verifier = fileURLToPath(new URL("../scripts/npm-release.mjs", import.meta.url));

test("the real release verifier reads a retained candidate from a native absolute path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "npm-release-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "artifact");
  mkdirSync(join(directory, "package"), { recursive: true });
  const manifest = { name: "pi-copy-message", version: "4.0.1", repository: { url: "git+https://github.com/fitchmultz/pi-copy-message.git" } };
  writeFileSync(join(directory, "package/package.json"), JSON.stringify(manifest));
  const packed = spawnSync("tar", ["-czf", "candidate.tgz", "package"], { cwd: directory, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
  const bytes = readFileSync(join(directory, "candidate.tgz"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const source = "a".repeat(40);
  const forkRef = "b".repeat(40);
  const cohort = { "@earendil-works/pi-coding-agent": "1.4.0" };
  const host = (flavor, provenance) => {
    const observation = { version: "1.4.0", indexSha256: "c".repeat(64), cliSha256: "d".repeat(64) };
    return { flavor, ...observation, observation, runtimeLockSha256: "e".repeat(64), runtimeGraphSha256: "f".repeat(64),
      cohort, companions: { typebox: "1.0.0" }, provenance };
  };
  const candidate = { repository: "fitchmultz/pi-copy-message", source, releaseSource: source,
    name: manifest.name, version: manifest.version, approval: false, filename: "candidate.tgz", sha256, integrity,
    notes: "Native release verifier test.", hosts: {
      official: host("official", { version: "1.4.0", cohort }),
      fork: host("fork", { ref: forkRef }),
    } };
  writeFileSync(join(directory, "release.json"), JSON.stringify(candidate));
  writeFileSync(join(directory, "release-notes.md"), `${candidate.notes}\n`);
  const result = spawnSync(process.execPath, [verifier, "verify", "--artifact", directory, "--source-ref", source,
    "--release-source", source, "--official-version", "1.4.0", "--fork-ref", forkRef], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: candidate.repository },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
