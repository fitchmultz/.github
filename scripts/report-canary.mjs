import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fleetPlatforms, readJson, runnerPlatform, waivedPlatforms } from "./common.mjs";

const fleet = readJson(new URL("../fleet.json", import.meta.url));
export const reportKey = (repo) => `<!-- pi-compatibility:${repo} -->`;
// Earlier reports opened one issue per repository, host flavor and exact host identity.
const legacyKeyPrefix = (repo) => `<!-- pi-compatibility:${repo}:`;
const identity = (result) => result.host?.provenance.ref ?? result.host?.version ?? result.target ?? "unresolved";
const waived = (result) => [...waivedPlatforms].some((os) => runnerPlatform(os) === result.platform);

// Required (non-waived) lanes a complete canary run produces for one fleet entry.
export function requiredLaneCount(entry) {
  const hosts = entry.kind === "cli" ? 1 : 2;
  return fleetPlatforms(entry).filter((platform) => !waivedPlatforms.has(platform.os)).length * hosts;
}

// One report per repository: the latest run's lanes across both hosts. Only required lanes keep it failing,
// and only complete required evidence may close it (a failed runner can omit an artifact).
export function failureReports(qualifications, runUrl, inventory = fleet) {
  const groups = new Map();
  for (const result of qualifications.filter((result) => result.lane !== "baseline")) {
    if (!groups.has(result.repo)) groups.set(result.repo, []);
    groups.get(result.repo).push(result);
  }
  return [...groups].map(([repo, results]) => {
    results.sort((a, b) => `${a.flavor}/${a.platform}/${a.node}`.localeCompare(`${b.flavor}/${b.platform}/${b.node}`));
    const required = results.filter((result) => !waived(result));
    const failures = required.filter((result) => result.result !== "passed");
    const diagnostics = results.filter((result) => waived(result) && result.result !== "passed");
    const entry = inventory.find((item) => item.repo === repo);
    const complete = Boolean(entry) && required.length >= requiredLaneCount(entry);
    const hosts = [...new Set(results.map((result) => `${result.flavor} ${identity(result)}`))];
    const body = [reportKey(repo), `Latest qualification: ${runUrl}`, "",
      `Repository: fitchmultz/${repo}. Hosts: ${hosts.join(", ")}.`, "",
      ...results.map((result) => `- ${result.flavor} ${identity(result)} / ${result.platform} / ${result.node}: **${result.result}**${result.phase ? ` (${result.phase})` : ""}${waived(result) ? " — owner-waived diagnostic" : ""}; source \`${result.source}\`.`), "",
      ...[...failures, ...diagnostics].flatMap((result) => [`${result.flavor} ${identity(result)} / ${result.platform} / ${result.node}${waived(result) ? " (waived diagnostic)" : ""}:`,
        "```text", String(result.error ?? "See the failing job log").slice(0, 5000), "```", ""]),
      "Reproduce by checking out the recorded source commit and this run's automation revision, then running:", "",
      "```sh", ...[...new Set((failures.length ? failures : results).map((result) =>
        `node scripts/qualify.mjs --repo ${repo} --source /path/to/checkout --host ${result.flavor} --target ${result.flavor === "fork" ? "/path/to/downloaded/fork-host-artifact" : identity(result)} --output /tmp/pi-qualification`))], "```", "",
      "This single issue tracks the repository across official and fork hosts; each canary run updates it and closes it once every required lane passes. Owner-waived Windows lanes are reported as diagnostics and do not keep it open. The run's qualification artifacts include the selected SDK/CLI paths and hashes, host provenance, packed npm artifact, and native probe output. Published-package failures are checked by adding --published. Repair through the repository's normal PR and compatibility checks; this canary never creates a repair PR or promotes a release.",
    ].join("\n");
    return { key: reportKey(repo), repo, failed: failures.length > 0, complete, title: `Pi compatibility: ${repo}`, body };
  });
}

// Choose the issue that carries a repository's report and every older duplicate that it supersedes.
export function matchIssues(issues, report) {
  const related = issues.filter((issue) => issue.body?.includes(report.key) || (report.repo && issue.body?.includes(legacyKeyPrefix(report.repo))))
    .sort((a, b) => Date.parse(b.updated_at ?? 0) - Date.parse(a.updated_at ?? 0));
  const current = related.filter((issue) => issue.body?.includes(report.key));
  const canonical = current.find((issue) => issue.state === "open") ?? related.find((issue) => issue.state === "open") ?? current[0];
  return { canonical, duplicates: related.filter((issue) => issue !== canonical && issue.state === "open") };
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
    complete: conclusion === "success",
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
    const { canonical, duplicates } = matchIssues(issues, report);
    if (report.failed || report.complete) {
      if (canonical) {
        await github(`issues/${canonical.number}`, "PATCH", { title: report.title, body: report.body, state: report.failed ? "open" : "closed",
          ...(report.failed ? {} : { state_reason: "completed" }) });
      } else if (report.failed) {
        await github("issues", "POST", { title: report.title, body: report.body });
      }
    }
    // Incomplete evidence never closes the tracking issue, but older per-host duplicates are always folded into it.
    for (const duplicate of duplicates) {
      await github(`issues/${duplicate.number}/comments`, "POST", { body: `Superseded by ${canonical ? `#${canonical.number}` : "the repository's single compatibility issue"}, which now tracks ${report.repo ?? "this report"} across all hosts. Latest run: ${runUrl}` });
      await github(`issues/${duplicate.number}`, "PATCH", { state: "closed", state_reason: "not_planned" });
    }
    console.log(`${report.failed ? "FAIL" : report.complete ? "PASS" : "INCOMPLETE"} ${report.title}${canonical ? ` (#${canonical.number})` : ""}${duplicates.length ? `; superseded ${duplicates.map((issue) => `#${issue.number}`).join(", ")}` : ""}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
