import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("host selection help needs no arguments; invalid invocations fail before installing a host", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-select-host-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "host");
  const invoke = (...args) => spawnSync(process.execPath, ["scripts/select-development-host.mjs", ...args], { encoding: "utf8" });
  for (const flag of ["-h", "--help"]) {
    const result = invoke(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:.*--source.*--directory.*--version/);
    assert.match(result.stdout, /Example:/);
    assert.match(result.stdout, /Exit codes:/);
  }
  const missing = invoke("--directory", directory, "--version", "0.86.1");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Required: --source PATH --directory PATH --version X\.Y\.Z/);
  for (const version of ["latest", "", "0.86", "0.87.0-beta.1"]) {
    const invalid = invoke("--source", root, "--directory", directory, "--version", version);
    assert.equal(invalid.status, 1, version);
    assert.match(invalid.stderr, /--version must be the exact official X\.Y\.Z release/);
  }
  assert.equal(existsSync(directory), false);
});
