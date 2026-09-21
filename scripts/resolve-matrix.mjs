import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { readJson } from "./common.mjs";
import { officialRelease } from "./hosts.mjs";

const fleet = readJson(new URL("../fleet.json", import.meta.url));
const targets = readJson(new URL("../host-targets.json", import.meta.url));
const requested = process.env.REPOSITORY;
const host = process.env.HOST ?? "both";
assert.ok(["both", "fork"].includes(host), "Host must be both or fork");
const selected = fleet.filter((entry) => (requested === "all" || `fitchmultz/${entry.repo}` === requested)
  && (host !== "fork" || entry.kind !== "cli"));
assert.ok(selected.length, `No applicable fleet repository: ${requested} (host: ${host})`);
const forkRef = process.env.FORK_REF || targets.forkRef;
assert.match(forkRef, /^[a-f0-9]{40}$/, "Fork host must be pinned to a full commit SHA");
const versions = new Map();
async function release(version) {
  if (!versions.has(version)) versions.set(version, await officialRelease(version));
  return versions.get(version).version;
}
async function github(path) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.json();
}
const needsOfficial = host === "both" && selected.some((entry) => entry.kind !== "cli");
const override = needsOfficial && process.env.OFFICIAL_VERSION ? await release(process.env.OFFICIAL_VERSION) : undefined;
const baseline = needsOfficial ? await release(targets.official) : undefined;
const include = [];
for (const entry of selected) {
  const repository = `fitchmultz/${entry.repo}`;
  const requestedRef = process.env.SOURCE_REF || "main";
  const commit = await github(`${repository}/commits/${encodeURIComponent(requestedRef)}`);
  const ref = commit.sha;
  assert.match(ref, /^[a-f0-9]{40}$/);
  // A shared host-target update qualifies that new target across the fleet before promotion.
  // Individual extension PRs instead qualify the version declared by their candidate manifest.
  let candidate = override ?? (requested === "all" ? baseline : undefined);
  if (needsOfficial && !candidate && entry.kind !== "cli") {
    const content = await github(`${repository}/contents/package.json?ref=${ref}`);
    const manifest = JSON.parse(Buffer.from(content.content, "base64").toString("utf8"));
    candidate = await release(manifest.devDependencies?.["@earendil-works/pi-coding-agent"] ?? targets.official);
  }
  const hosts = entry.kind === "cli" ? [{ host: "none", label: "cli", version: "" }] : [
    ...(needsOfficial ? [{ host: "official", label: "official", version: candidate }] : []),
    { host: "fork", label: "fork", version: "" },
    ...(needsOfficial && candidate !== baseline ? [{ host: "official", label: "baseline", version: baseline }] : []),
  ];
  const platforms = [
    ...(entry.nodes ?? ["22.19.0", "24"]).map((node) => ({ node, os: entry.os ?? "ubuntu-latest" })),
    ...(entry.extraPlatforms ?? []).map((os) => ({ node: "24", os })),
  ];
  for (const platform of platforms) {
    for (const host of hosts) include.push({ repository, repo: entry.repo, ref, ...platform, ...host });
  }
}
const outputs = { matrix: JSON.stringify({ include }), forkRef, needsFork: String(include.some((lane) => lane.host === "fork")) };
for (const [name, value] of Object.entries(outputs)) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
console.log(JSON.stringify({ targets: outputs, lanes: include.length }, null, 2));
