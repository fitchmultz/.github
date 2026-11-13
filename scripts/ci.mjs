import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";

const help = `Usage:
  node scripts/ci.mjs scope --event pull_request|push|workflow_dispatch --base SHA --head SHA
  node scripts/ci.mjs check

scope compares immutable Git commits (the merge base for a PR), prints JSON,
and writes fleet-required=true|false plus fleet-repository=all|<repos>|"" to
GITHUB_OUTPUT when set.
Manual dispatch always requires the full fleet and needs no base/head.
check requires SCOPE, HOSTS, TESTS and CONFIGURATION=success, plus an explicit
FLEET_REQUIRED=true|false and FLEET=success (or skipped only when not required, or intentionally
skipped on a main push with EVENT=push).
Both commands write their decision to GITHUB_STEP_SUMMARY when set.

Examples:
  node scripts/ci.mjs scope --event push --base "$(git rev-parse HEAD^)" --head "$(git rev-parse HEAD)"
  SCOPE=success HOSTS=success TESTS=success CONFIGURATION=success FLEET_REQUIRED=false FLEET_REPOSITORY="" FLEET=skipped node scripts/ci.mjs check

Exit codes: 0 = planned or checks passed; 1 = invalid input, Git failure or failed gate.
  -h, --help  Show this help`;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
const smokeRepo = "pi-calculator";
const nonFleetExact = new Set([
  "README.md",
  "renovate.json",
  "pi-extensions.json",
  ".gitignore",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  "tsconfig.json",
  ".github/actions/npm-publish/action.yml",
  ".github/workflows/npm-release-bump.yml",
  ".github/workflows/npm-release-plan.yml",
  ".github/workflows/npm-release-prepare.yml",
  ".github/workflows/npm-release-qualified.yml",
  ".github/workflows/npm-release.yml",
  ".github/workflows/pi-canary.yml",
  "scripts/check-quality.mjs",
  "scripts/npm-package.mjs",
  "scripts/npm-release-core.mjs",
  "scripts/npm-release.mjs",
  "scripts/npm-version.mjs",
  "scripts/observe.ts",
  "scripts/release-fetch.mjs",
  "scripts/report-canary.mjs",
]);
const nonFleetPath = (path) => nonFleetExact.has(path)
  || path.startsWith("docs/")
  || path.startsWith(".github/readme/")
  || path.startsWith("test/");
const ciWiringPath = (path) => path === ".github/workflows/ci.yml" || path === "scripts/ci.mjs";

function compatibilityEntry({ repo, kind, npmPackage, npmRelease, os, nodes, extraPlatforms, contractTimeoutMs }) {
  return { repo, kind, npmPackage, npmRelease, os, nodes, extraPlatforms, contractTimeoutMs };
}

function readFleet(revision) {
  let raw;
  try {
    raw = git("show", `${revision}:fleet.json`);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const seen = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(entry.repo) || seen.has(entry.repo)) return null;
    seen.add(entry.repo);
  }
  return parsed;
}

function diffFleet(before, head) {
  const beforeFleet = readFleet(before);
  const headFleet = readFleet(head);
  if (!beforeFleet || !headFleet) return "all";
  const beforeMap = new Map(beforeFleet.map((entry) => [entry.repo, compatibilityEntry(entry)]));
  return headFleet
    .filter((entry) => !beforeMap.has(entry.repo) || !isDeepStrictEqual(beforeMap.get(entry.repo), compatibilityEntry(entry)))
    .map((entry) => `fitchmultz/${entry.repo}`);
}

function scope(values) {
  if (values.event === "workflow_dispatch") {
    return { fleetRequired: true, fleetRepository: "all", reason: "Manual dispatch requires full qualification.", files: [] };
  }
  if (!["pull_request", "push"].includes(values.event)) throw new Error("Event must be pull_request, push or workflow_dispatch");
  for (const name of ["base", "head"]) {
    if (!/^[a-f0-9]{40}$/.test(values[name] ?? "")) throw new Error(`${name} must be a full commit SHA`);
    git("rev-parse", "--verify", `${values[name]}^{commit}`);
  }
  const before = values.event === "pull_request" ? git("merge-base", values.base, values.head).trim() : values.base;
  // NUL preserves unusual filenames; disabling rename detection retains deleted runtime paths.
  const files = git("diff", "--name-only", "-z", "--no-renames", before, values.head, "--").split("\0").filter(Boolean);
  if (!files.length) {
    return { fleetRequired: true, fleetRepository: "all", reason: "No changed paths to prove a fast-path scope.", files };
  }
  const fullFleetPaths = files.filter((path) => !nonFleetPath(path) && !ciWiringPath(path) && path !== "fleet.json");
  if (fullFleetPaths.length) {
    const paths = fullFleetPaths.map((path) => JSON.stringify(path)).join(", ");
    return {
      fleetRequired: true,
      fleetRepository: "all",
      reason: `Default rule: these changed paths affect shared compatibility qualification, so the full fleet is required: ${paths}.`,
      files,
    };
  }
  const targeted = new Set();
  const reasons = [];
  if (files.includes("fleet.json")) {
    const fleetDiff = diffFleet(before, values.head);
    if (fleetDiff === "all") {
      return {
        fleetRequired: true,
        fleetRepository: "all",
        reason: "fleet.json could not be compared across revisions, so the full fleet is required.",
        files,
      };
    }
    for (const repo of fleetDiff) targeted.add(repo);
    if (fleetDiff.length) reasons.push(`fleet.json compatibility entries changed (${fleetDiff.join(", ")})`);
  }
  if (files.some(ciWiringPath) && targeted.size === 0) {
    const headFleet = readFleet(values.head);
    if (!headFleet?.some((entry) => entry.repo === smokeRepo)) {
      const paths = files.filter(ciWiringPath).map((path) => JSON.stringify(path)).join(", ");
      return {
        fleetRequired: true,
        fleetRepository: "all",
        reason: `CI wiring changed (${paths}) without a readable ${smokeRepo} smoke entry in fleet.json, so the full fleet is required.`,
        files,
      };
    }
    targeted.add(`fitchmultz/${smokeRepo}`);
    reasons.push(`CI wiring changed (${files.filter(ciWiringPath).map((path) => JSON.stringify(path)).join(", ")})`);
  }
  if (targeted.size) {
    const fleetRepository = [...targeted].join(",");
    return {
      fleetRequired: true,
      fleetRepository,
      reason: `Targeted fleet qualification (${fleetRepository}): ${reasons.join("; ")}.`,
      files,
    };
  }
  return {
    fleetRequired: false,
    fleetRepository: "",
    reason: "Changed files do not affect shared Pi compatibility qualification.",
    files,
  };
}

function check() {
  for (const name of ["SCOPE", "HOSTS", "TESTS", "CONFIGURATION"]) {
    if (process.env[name] !== "success") throw new Error(`${name} must succeed (received ${JSON.stringify(process.env[name])})`);
  }
  const required = process.env.FLEET_REQUIRED;
  if (!["true", "false"].includes(required)) throw new Error("FLEET_REQUIRED must be explicitly true or false");
  const repository = process.env.FLEET_REPOSITORY ?? (required === "true" ? "all" : "");
  if (required === "false" && repository !== "") {
    throw new Error(`FLEET_REPOSITORY must be empty when FLEET_REQUIRED=false (received ${JSON.stringify(repository)})`);
  }
  if (required === "true" && repository === "") {
    throw new Error("FLEET_REPOSITORY must name a target repository or all when FLEET_REQUIRED=true");
  }
  const fleet = process.env.FLEET;
  // A push to main is smoke-only: its pull request already qualified the same content, and the daily canary re-qualifies.
  const pushSkip = required === "true" && process.env.EVENT === "push" && fleet === "skipped";
  if (fleet !== "success" && !(required === "false" && fleet === "skipped") && !pushSkip) {
    throw new Error(`Fleet must succeed${required === "false" || pushSkip ? " or be intentionally skipped" : ""} (received ${JSON.stringify(fleet)})`);
  }
  if (pushSkip) {
    return "Automation passed. Fleet intentionally skipped on the main push; the pull request run qualified this content and the daily canary re-qualifies.";
  }
  if (fleet === "skipped") return "Automation passed. Fleet intentionally skipped; this is not fleet qualification.";
  return repository === "all" || repository === ""
    ? "Automation passed, including full fleet qualification."
    : `Automation passed, including targeted fleet qualification (${repository}).`;
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    event: { type: "string" }, base: { type: "string" }, head: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) console.log(help);
  else {
    if (positionals.length !== 1 || !["scope", "check"].includes(positionals[0])) throw new Error("Choose scope or check; use --help for usage");
    let summary;
    if (positionals[0] === "scope") {
      const plan = scope(values);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `fleet-required=${plan.fleetRequired}\nfleet-repository=${plan.fleetRepository}\n`);
      }
      console.log(JSON.stringify(plan, null, 2));
      summary = `Fleet required: **${plan.fleetRequired}**${plan.fleetRepository ? ` (\`${plan.fleetRepository}\`)` : ""}. ${plan.reason}`;
    } else {
      if (values.event !== undefined || values.base !== undefined || values.head !== undefined) throw new Error("check takes no options");
      summary = check();
      console.log(summary);
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
