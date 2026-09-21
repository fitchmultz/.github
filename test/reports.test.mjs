import assert from "node:assert/strict";
import test from "node:test";
import { failureReports } from "../scripts/report-canary.mjs";

const pass = { repo: "pi-calculator", flavor: "official", lane: "official", host: { version: "0.86.1", provenance: { version: "0.86.1" } },
  platform: "linux", node: "v24.21.0", source: "a".repeat(40), result: "passed" };
const run = "https://github.com/fitchmultz/.github/actions/runs/123";

test("one affected release report keeps all Node failures together", () => {
  const reports = failureReports([pass, { ...pass, node: "v22.19.0", result: "failed", phase: "package-contracts", error: "seeded fixture failure" }], run);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].failed, true);
  assert.match(reports[0].body, /seeded fixture failure/);
  assert.match(reports[0].body, /v22.19.0/);
  assert.match(reports[0].body, /v24.21.0/);
  assert.match(reports[0].body, /--target 0.86.1/);
  assert.equal(failureReports([{ ...pass, result: "failed" }], `${run}4`)[0].key, reports[0].key);
});

test("distinct official releases and a same-version fork never share an issue identity", () => {
  const reports = failureReports([pass, { ...pass, host: { version: "0.87.0", provenance: { version: "0.87.0" } } },
    { ...pass, flavor: "fork", lane: "fork", host: { version: "0.86.1", provenance: { ref: "b".repeat(40) } } }], run);
  assert.equal(new Set(reports.map((report) => report.key)).size, 3);
  assert.match(reports[2].body, /downloaded\/fork-host-artifact/);
});

test("diagnostic baseline failure does not become a required compatibility failure", () => {
  const reports = failureReports([pass, { ...pass, lane: "baseline", result: "failed" }], run);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].failed, false);
});

test("an installation failure retains the requested host before provenance is available", () => {
  const reports = failureReports([{ ...pass, host: undefined, target: "0.87.0", result: "failed", phase: "host-install" }], run);
  assert.match(reports[0].key, /official:0.87.0/);
  assert.match(reports[0].body, /host-install/);
});
