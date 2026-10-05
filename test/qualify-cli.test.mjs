import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("qualification help is available without required arguments; ordinary invocations still require them", () => {
  const invoke = (...args) => spawnSync(process.execPath, ["scripts/qualify.mjs", ...args], { encoding: "utf8" });
  for (const flag of ["-h", "--help"]) {
    const result = invoke(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:.*--repo.*--source.*--host.*--output/);
    assert.match(result.stdout, /Examples?:/);
    assert.match(result.stdout, /Exit codes:/);
    assert.doesNotMatch(result.stdout, /\$ npm/);
  }
  const missing = invoke();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Required: --repo/);
});
