import assert from "node:assert/strict";
import test from "node:test";
import { failureReports, matchIssues, reportKey, requiredLaneCount } from "../scripts/report-canary.mjs";

const pass = { repo: "pi-calculator", flavor: "official", lane: "official", host: { version: "0.86.1", provenance: { version: "0.86.1" } },
  platform: "linux", node: "v24.21.0", source: "a".repeat(40), result: "passed" };
const fork = { ...pass, flavor: "fork", lane: "fork", host: { version: "0.86.1", provenance: { ref: "b".repeat(40) } } };
const run = "https://github.com/fitchmultz/.github/actions/runs/123";
const inventory = [{ repo: "pi-calculator", kind: "extension", nodes: ["24"], extraPlatforms: ["windows-latest"] }];

test("one repository report keeps every host, Node and platform result together", () => {
  const reports = failureReports([pass, fork, { ...pass, node: "v22.19.0", result: "failed", phase: "package-contracts", error: "seeded fixture failure" }], run, inventory);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].key, reportKey("pi-calculator"));
  assert.equal(reports[0].title, "Pi compatibility: pi-calculator");
  assert.equal(reports[0].failed, true);
  assert.match(reports[0].body, /seeded fixture failure/);
  assert.match(reports[0].body, /v22.19.0/);
  assert.match(reports[0].body, /--target 0.86.1/);
  assert.match(reports[0].body, new RegExp(`fork ${"b".repeat(40)}`));
  // New host identities update the same report instead of opening another issue.
  assert.equal(failureReports([{ ...pass, host: { version: "0.87.0", provenance: { version: "0.87.0" } }, result: "failed" }], `${run}4`, inventory)[0].key, reports[0].key);
});

test("owner-waived Windows failures stay visible without keeping the report open", () => {
  const [report] = failureReports([pass, fork, { ...pass, platform: "win32", result: "failed", phase: "published-npm", error: "windows diagnostic" }], run, inventory);
  assert.equal(report.failed, false);
  assert.equal(report.complete, true);
  assert.match(report.body, /owner-waived diagnostic/);
  assert.match(report.body, /windows diagnostic/);
});

test("only complete required evidence can close a report", () => {
  assert.equal(requiredLaneCount(inventory[0]), 2);
  assert.equal(requiredLaneCount({ repo: "cli", kind: "cli", nodes: ["22.22.2", "24"] }), 2);
  const [partial] = failureReports([pass], run, inventory);
  assert.equal(partial.failed, false);
  assert.equal(partial.complete, false);
  const [unknown] = failureReports([{ ...pass, repo: "retired" }], run, inventory);
  assert.equal(unknown.complete, false);
});

test("an installation failure retains the requested host before provenance is available", () => {
  const [report] = failureReports([{ ...pass, host: undefined, target: "0.87.0", result: "failed", phase: "host-install" }], run, inventory);
  assert.match(report.body, /official 0.87.0/);
  assert.match(report.body, /host-install/);
});

test("legacy per-host issues fold into one canonical repository issue", () => {
  const report = { key: reportKey("pi-calculator"), repo: "pi-calculator" };
  const issue = (number, key, state, updated) => ({ number, state, updated_at: updated, body: `${key}\nLatest qualification: x` });
  const issues = [
    issue(1, "<!-- pi-compatibility:pi-calculator:official:0.87.1 -->", "open", "2026-09-01T00:00:00Z"),
    issue(2, "<!-- pi-compatibility:pi-calculator:fork:abc -->", "open", "2026-10-01T00:00:00Z"),
    issue(3, "<!-- pi-compatibility:pi-calculator-extra:fork:abc -->", "open", "2026-10-02T00:00:00Z"),
    issue(4, "<!-- pi-compatibility:pi-calculator:official:0.80.0 -->", "closed", "2026-08-01T00:00:00Z"),
  ];
  let { canonical, duplicates } = matchIssues(issues, report);
  assert.equal(canonical.number, 2);
  assert.deepEqual(duplicates.map((item) => item.number), [1]);
  ({ canonical, duplicates } = matchIssues([...issues, issue(5, reportKey("pi-calculator"), "closed", "2026-07-01T00:00:00Z")], report));
  assert.equal(canonical.number, 2, "an open legacy issue is preferred over reopening a closed one");
  ({ canonical, duplicates } = matchIssues([...issues, issue(6, reportKey("pi-calculator"), "open", "2026-07-01T00:00:00Z")], report));
  assert.equal(canonical.number, 6);
  assert.deepEqual(duplicates.map((item) => item.number), [2, 1]);
  ({ canonical, duplicates } = matchIssues([issue(5, reportKey("pi-calculator"), "closed", "2026-07-01T00:00:00Z")], report));
  assert.equal(canonical.number, 5);
  assert.deepEqual(duplicates, []);
});
