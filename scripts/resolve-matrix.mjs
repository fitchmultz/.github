import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { fleetPlatforms, readJson } from "./common.mjs";
import { resolveHostTargets } from "./hosts.mjs";

const fleet = readJson(new URL("../fleet.json", import.meta.url));
const requested = process.env.REPOSITORY;
const host = process.env.HOST ?? "both";
assert.ok(["both", "fork"].includes(host), "Host must be both or fork");
const selected = fleet.filter((entry) => (requested === "all" || `fitchmultz/${entry.repo}` === requested)
  && (host !== "fork" || entry.kind !== "cli"));
assert.ok(selected.length, `No applicable fleet repository: ${requested} (host: ${host})`);
const needsFork = selected.some((entry) => entry.kind !== "cli");
const targets = needsFork ? await resolveHostTargets({ host, officialVersion: process.env.OFFICIAL_VERSION, forkRef: process.env.FORK_REF })
  : { officialVersion: "", forkRef: process.env.FORK_REF ?? "" };
const { forkRef } = targets;
if (forkRef) assert.match(forkRef, /^[a-f0-9]{40}$/, "Fork host must be pinned to a full commit SHA");
async function github(path) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.json();
}
const needsOfficial = host === "both" && needsFork;
const include = [];
for (const entry of selected) {
  const repository = `fitchmultz/${entry.repo}`;
  const requestedRef = process.env.SOURCE_REF || "main";
  const commit = await github(`${repository}/commits/${encodeURIComponent(requestedRef)}`);
  const ref = commit.sha;
  assert.match(ref, /^[a-f0-9]{40}$/);
  const hosts = entry.kind === "cli" ? [{ host: "none", label: "cli", version: "" }] : [
    ...(needsOfficial ? [{ host: "official", label: "official", version: targets.officialVersion }] : []),
    { host: "fork", label: "fork", version: "" },
  ];
  for (const platform of fleetPlatforms(entry)) {
    for (const host of hosts) include.push({ repository, repo: entry.repo, ref, ...platform, ...host });
  }
}
const outputs = { matrix: JSON.stringify({ include }), forkRef, needsFork: String(include.some((lane) => lane.host === "fork")) };
for (const [name, value] of Object.entries(outputs)) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
console.log(JSON.stringify({ targets: outputs, lanes: include.length }, null, 2));
