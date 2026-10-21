import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { failureReports, matchIssues, reportKey, requiredLaneCount, retiredIssues } from "../scripts/report-canary.mjs";

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

test("retirement requires an open automation marker for a repository absent from the fleet", () => {
  const issue = (number, repo, overrides = {}) => ({ number, state: "open", body: reportKey(repo), ...overrides });
  const issues = [
    issue(96, "pi-local-agents-only"),
    issue(97, "pi-edit-session-in-place"),
    issue(1, "pi-calculator"),
    issue(2, "pi-local-agents-only", { state: "closed" }),
    issue(3, "infrastructure"),
    issue(4, "pi-local-agents-only", { pull_request: {} }),
    issue(5, "retired-legacy", { body: "<!-- pi-compatibility:retired-legacy:fork:abc -->\nOld evidence" }),
    issue(6, "x", { title: "Pi compatibility: retired", body: "Not an automation-owned issue" }),
    issue(7, "x", { body: "<!-- pi-compatibility:pi-calculator-extra -->" }),
    issue(8, "x", { body: "<!-- pi-compatibility:broken marker -->" }),
  ];
  assert.deepEqual(retiredIssues(issues, inventory).map(({ repo, issue }) => [repo, issue.number]), [
    ["pi-local-agents-only", 96], ["pi-edit-session-in-place", 97], ["retired-legacy", 5], ["pi-calculator-extra", 7],
  ]);
  assert.equal(retiredIssues([issues[0]], [{ repo: "pi-local-agents-only" }]).length, 0, "a re-enrolled repository remains active");
});

test("the reporter retires removed entries only on the current default branch, preserving active and failure evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-retired-reports-"));
  const script = fileURLToPath(new URL("../scripts/report-canary.mjs", import.meta.url));
  const callsFile = join(root, "calls.json");
  const issues = [
    { number: 96, state: "open", body: `${reportKey("pi-local-agents-only")}\nOriginal failed evidence` },
    { number: 97, state: "open", body: reportKey("pi-edit-session-in-place") },
    { number: 128, state: "open", body: reportKey("macuse") },
    { number: 129, state: "open", body: reportKey("pi-agent-skills") },
    { number: 130, state: "open", body: "<!-- pi-compatibility:infrastructure -->" },
  ];
  try {
    for (const { ref, defaultBranch, mayRetire } of [
      { ref: "refs/heads/candidate", defaultBranch: "main", mayRetire: false },
      { ref: "refs/heads/main", defaultBranch: "main", mayRetire: true },
      { ref: "refs/heads/trunk", defaultBranch: "trunk", mayRetire: true },
      { ref: "refs/heads/main", defaultBranch: "", mayRetire: false },
      { ref: "", defaultBranch: "main", mayRetire: false },
    ]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import { writeFileSync } from "node:fs";
        import { pathToFileURL } from "node:url";
        const calls = [];
        globalThis.fetch = async (url, options) => {
          calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
          return { ok: true, json: async () => options.method === "GET" ? ${JSON.stringify(issues)} : {} };
        };
        process.argv = [process.execPath, ${JSON.stringify(script)}, ${JSON.stringify(root)}, "failure"];
        await import(pathToFileURL(${JSON.stringify(script)}));
        writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
      `], { encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "fitchmultz/.github", GITHUB_RUN_ID: "123", GH_TOKEN: "fixture-only",
        GITHUB_REF: ref, CANARY_DEFAULT_BRANCH: defaultBranch } });
      assert.equal(result.status, 0, result.stderr);
      const calls = JSON.parse(readFileSync(callsFile, "utf8"));
      for (const number of [96, 97]) {
        const mutations = calls.filter((call) => call.url.includes(`/issues/${number}`));
        if (!mayRetire) {
          assert.deepEqual(mutations, [], `do not retire from ${ref || "an unknown ref"} with default branch ${defaultBranch || "unknown"}`);
          continue;
        }
        assert.deepEqual(mutations.map((call) => call.method), ["POST", "PATCH"]);
        assert.match(mutations[0].body.body, /not as a passing compatibility check/);
        assert.match(mutations[0].body.body, /actions\/runs\/123/);
        assert.deepEqual(mutations[1].body, { state: "closed", state_reason: "not_planned" });
        assert.ok(!("body" in mutations[1].body), "retain the last failure evidence");
      }
      assert.ok(!calls.some((call) => /issues\/(128|129)(?:\/|$)/.test(call.url)), "missing artifacts cannot retire active entries");
      const infrastructure = calls.find((call) => call.url.endsWith("/issues/130"));
      assert.equal(infrastructure.body.state, "open", "a failed run still reports missing evidence as infrastructure");
      if (mayRetire) assert.match(result.stdout, /RETIRED Pi compatibility: pi-local-agents-only \(#96\)/);
      else assert.doesNotMatch(result.stdout, /RETIRED/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
