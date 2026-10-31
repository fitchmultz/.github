import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";

const help = `Usage:
  node scripts/ci.mjs scope --event pull_request|push|workflow_dispatch --base SHA --head SHA
  node scripts/ci.mjs check

scope compares immutable Git commits (the merge base for a PR), prints JSON,
and writes fleet-required=true|false to GITHUB_OUTPUT when set.
Manual dispatch always requires the full fleet and needs no base/head.
check requires SCOPE, HOSTS, TESTS, WINDOWS_RELEASE and CONFIGURATION=success, plus an explicit
FLEET_REQUIRED=true|false and FLEET=success (or skipped only when not required).
Both commands write their decision to GITHUB_STEP_SUMMARY when set.

Examples:
  node scripts/ci.mjs scope --event push --base "$(git rev-parse HEAD^)" --head "$(git rev-parse HEAD)"
  SCOPE=success HOSTS=success TESTS=success WINDOWS_RELEASE=success CONFIGURATION=success FLEET_REQUIRED=false FLEET=skipped node scripts/ci.mjs check

Exit codes: 0 = planned or checks passed; 1 = invalid input, Git failure or failed gate.
  -h, --help  Show this help`;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));
const validatorDependency = (value) => object(value) && Object.keys(value).length === 1
  && typeof value.renovate === "string" && value.renovate.length > 0;
const withoutDev = ({ devDependencies, ...rest }) => rest;

function validatorOnly(before, after) {
  // ponytail: Only the single-validator npm v3 layout gets a fast path; extend this proof when adopting another tool or lock format.
  try {
    const read = (ref, file) => JSON.parse(git("show", `${ref}:${file}`));
    const inputs = [before, after].map((ref) => ({
      manifest: read(ref, "package.json"), lock: read(ref, "package-lock.json"),
    }));
    for (const { manifest, lock } of inputs) {
      if (!onlyKeys(manifest, ["name", "version", "private", "type", "packageManager", "scripts", "engines", "devDependencies", "allowScripts"])
        || !validatorDependency(manifest.devDependencies)
        || !object(manifest.scripts) || typeof manifest.scripts["check:renovate"] !== "string"
        || !Object.values(manifest.scripts).every((script) => typeof script === "string")
        || !onlyKeys(lock, ["name", "version", "lockfileVersion", "requires", "packages"])
        || lock.lockfileVersion !== 3 || lock.requires !== true || !object(lock.packages)) return false;
      const root = lock.packages[""];
      if (!onlyKeys(root, ["name", "version", "devDependencies", "engines"])
        || !isDeepStrictEqual(root.devDependencies, manifest.devDependencies)
        || root.name !== manifest.name || root.version !== manifest.version
        || !object(lock.packages["node_modules/renovate"])
        || !Object.entries(lock.packages).every(([path, entry]) => path === ""
          || (path.startsWith("node_modules/") && object(entry) && entry.dev === true && !Object.hasOwn(entry, "link")))) return false;
    }
    const comparable = ({ manifest, lock }) => ({
      manifest: { ...withoutDev(manifest), scripts: Object.fromEntries(Object.entries(manifest.scripts).filter(([key]) => key !== "check:renovate")) },
      lock: { ...lock, packages: { "": withoutDev(lock.packages[""]) } },
    });
    return isDeepStrictEqual(comparable(inputs[0]), comparable(inputs[1]));
  } catch {
    return false;
  }
}

function scope(values) {
  if (values.event === "workflow_dispatch") return { fleetRequired: true, reason: "Manual dispatch requires full qualification.", files: [] };
  if (!["pull_request", "push"].includes(values.event)) throw new Error("Event must be pull_request, push or workflow_dispatch");
  for (const name of ["base", "head"]) {
    if (!/^[a-f0-9]{40}$/.test(values[name] ?? "")) throw new Error(`${name} must be a full commit SHA`);
    git("rev-parse", "--verify", `${values[name]}^{commit}`);
  }
  const before = values.event === "pull_request" ? git("merge-base", values.base, values.head).trim() : values.base;
  // NUL preserves unusual filenames; disabling rename detection retains deleted runtime paths.
  const files = git("diff", "--name-only", "-z", "--no-renames", before, values.head, "--").split("\0").filter(Boolean);
  if (!files.length) return { fleetRequired: true, reason: "No changed paths to prove a fast-path scope.", files };
  const fast = (path) => path === "README.md" || path.startsWith("docs/") || path.startsWith(".github/readme/")
    || ["renovate.json", "pi-extensions.json"].includes(path);
  const packageFiles = ["package.json", "package-lock.json"];
  const runtime = files.filter((path) => !fast(path) && !packageFiles.includes(path));
  if (runtime.length) return { fleetRequired: true, reason: "Runtime, reusable workflow or unknown paths changed.", files };
  if (files.some((path) => packageFiles.includes(path)) && !validatorOnly(before, values.head)) {
    return { fleetRequired: true, reason: "Package inputs are not proven to be validator-only.", files };
  }
  return { fleetRequired: false, reason: "Only documentation, policy or proven validator-only inputs changed.", files };
}

function check() {
  for (const name of ["SCOPE", "HOSTS", "TESTS", "WINDOWS_RELEASE", "CONFIGURATION"]) {
    if (process.env[name] !== "success") throw new Error(`${name} must succeed (received ${JSON.stringify(process.env[name])})`);
  }
  const required = process.env.FLEET_REQUIRED;
  if (!["true", "false"].includes(required)) throw new Error("FLEET_REQUIRED must be explicitly true or false");
  const fleet = process.env.FLEET;
  if (fleet !== "success" && !(required === "false" && fleet === "skipped")) {
    throw new Error(`Fleet must succeed${required === "false" ? " or be intentionally skipped" : ""} (received ${JSON.stringify(fleet)})`);
  }
  return fleet === "skipped" ? "Automation passed. Fleet intentionally skipped; this is not fleet qualification."
    : "Automation passed, including full fleet qualification.";
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
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `fleet-required=${plan.fleetRequired}\n`);
      console.log(JSON.stringify(plan, null, 2));
      summary = `Fleet required: **${plan.fleetRequired}**. ${plan.reason}`;
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
