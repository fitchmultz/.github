import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./common.mjs";

export function checkResources(packageDir) {
  const manifest = readJson(join(packageDir, "package.json"));
  for (const kind of ["extensions", "skills", "prompts", "themes"]) {
    const patterns = manifest.pi?.[kind] ?? [];
    const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
    for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
      assert.ok(existsSync(join(packageDir, pattern)) || fs.globSync(pattern, { cwd: packageDir, exclude }).length > 0,
        `Missing packaged ${kind}: ${pattern}`);
    }
  }
}

export function probeCli(host, packageDir, directory, env, { expectedRefusal = false } = {}) {
  mkdirSync(directory, { recursive: true });
  const observer = join(directory, "observe.ts");
  cpSync(fileURLToPath(new URL("observe.ts", import.meta.url)), observer);
  const observation = join(directory, "observation.json");
  const args = [host.cli, "--offline", "--mode", "rpc", "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-approve",
    "--no-session", "-e", packageDir, "-e", observer];
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    env: { ...env, PI_PACKAGE_DIR: host.packageDir, PI_COMPAT_OBSERVATION: observation },
    encoding: "utf8",
    input: `${JSON.stringify({ id: "qualification", type: "prompt", message: "/compatibility-probe-internal" })}\n`,
    timeout: 45_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(join(directory, "stdout.jsonl"), result.stdout ?? "");
  writeFileSync(join(directory, "stderr.log"), result.stderr ?? "");
  writeJson(join(directory, "command.json"), { executable: process.execPath, args, status: result.status, signal: result.signal });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const errors = events.filter((event) => event.type === "extension_error");
  if (expectedRefusal) {
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0].event, "session_start");
    assert.match(errors[0].error, /^Posthorse requires the fitchmultz\/pi fork with native context windows/);
  } else {
    assert.deepEqual(errors, [], "Native extension lifecycle errors");
  }
  assert.ok(events.some((event) => event.id === "qualification" && event.type === "response" && event.success === true), "Probe command did not complete");
  assert.ok(!events.some((event) => event.type === "agent_start"), "Fixture unexpectedly started a model turn");
  const observed = readJson(observation);
  assert.equal(realpathSync(observed.packageDir), realpathSync(host.packageDir));
  assert.equal(observed.version, host.version);
  assert.equal(observed.indexSha256, host.indexSha256);
  assert.equal(observed.cliSha256, host.cliSha256);
  return { expectedRefusal, ...observed };
}
