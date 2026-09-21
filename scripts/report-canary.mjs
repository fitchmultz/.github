import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function failureReports(qualifications, runUrl) {
  const groups = new Map();
  for (const result of qualifications.filter((result) => result.lane !== "baseline")) {
    const identity = result.host?.provenance.ref ?? result.host?.version ?? result.target ?? "unresolved";
    const key = `<!-- pi-compatibility:${result.repo}:${result.flavor}:${identity} -->`;
    if (!groups.has(key)) groups.set(key, { key, repo: result.repo, identity, flavor: result.flavor, results: [] });
    groups.get(key).results.push(result);
  }
  return [...groups.values()].map((group) => {
    const failures = group.results.filter((result) => result.result !== "passed");
    const body = [group.key, `Latest qualification: ${runUrl}`, "",
      `Repository: fitchmultz/${group.repo}. Host: ${group.flavor} ${group.identity}.`, "",
      ...group.results.map((result) => `- ${result.platform} / ${result.node}: **${result.result}**${result.phase ? ` (${result.phase})` : ""}; source \`${result.source}\`.`), "",
      ...failures.flatMap((result) => ["```text", String(result.error ?? "See the failing job log").slice(0, 5000), "```", ""]),
      "Reproduce by checking out the recorded source commit and this run's automation revision, then running:", "",
      "```sh", `node scripts/qualify.mjs --repo ${group.repo} --source /path/to/checkout --host ${group.flavor} --target ${group.flavor === "fork" ? "/path/to/downloaded/fork-host-artifact" : group.identity} --output /tmp/pi-qualification`, "```", "",
      "The run's qualification artifacts include the selected SDK/CLI paths and hashes, host provenance, packed npm artifact, and native probe output. Published-package failures are checked by adding --published. Repair through the repository's normal PR and compatibility checks; this canary never creates a repair PR or promotes a release.",
    ].join("\n");
    return { key: group.key, failed: failures.length > 0, title: `Pi compatibility: ${group.repo} / ${group.flavor} ${group.identity}`, body };
  });
}

async function main() {
  const [directory, conclusion] = process.argv.slice(2);
  assert.ok(directory && conclusion, "Usage: report-canary.mjs ARTIFACT_DIRECTORY QUALIFICATION_RESULT");
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, "fitchmultz/.github", "Canary reports belong in the automation repository");
  const runUrl = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const qualifications = globSync("**/qualification.json", { cwd: directory }).map((file) => JSON.parse(readFileSync(resolve(directory, file), "utf8")));
  const reports = failureReports(qualifications, runUrl);
  // Resolver/build/runner failures can happen before any per-repository evidence exists.
  reports.push({ key: "<!-- pi-compatibility:infrastructure -->", failed: conclusion !== "success" && !reports.some((report) => report.failed),
    title: "Pi compatibility: fleet qualification infrastructure", body: `<!-- pi-compatibility:infrastructure -->\n\nLatest run: ${runUrl}\n\nQualification result: ${conclusion}. A failed run without a package failure needs investigation in the resolver, fork build or runner jobs. Incomplete publication is infrastructure; it is not an extension incompatibility.` });
  async function github(path, method = "GET", body) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub canary report ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }
  const issues = [];
  for (let page = 1; ; page++) {
    const batch = await github(`issues?state=all&per_page=100&page=${page}`);
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) break;
  }
  for (const report of reports) {
    const existing = issues.find((issue) => issue.body?.includes(report.key));
    // A failed runner can omit an artifact. Only a complete green fleet can close prior reports.
    if (!report.failed && conclusion !== "success") continue;
    if (existing) {
      await github(`issues/${existing.number}`, "PATCH", { title: report.title, body: report.body, state: report.failed ? "open" : "closed" });
    } else if (report.failed) {
      await github("issues", "POST", { title: report.title, body: report.body });
    }
    console.log(`${report.failed ? "FAIL" : "PASS"} ${report.title}${existing ? ` (#${existing.number})` : ""}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
