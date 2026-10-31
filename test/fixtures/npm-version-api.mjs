import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const state = () => JSON.parse(readFileSync(process.env.FAKE_GITHUB_STATE, "utf8"));
const sha = (ref) => execFileSync("git", ["--git-dir", process.env.FAKE_GITHUB_REMOTE, "rev-parse", ref], { encoding: "utf8" }).trim();
const pull = (item) => ({ number: item.number, state: "open", base: { ref: "main", sha: sha("refs/heads/main") },
  head: { ref: item.branch, sha: sha(`refs/heads/${item.branch}`), repo: { full_name: process.env.GITHUB_REPOSITORY } },
  user: { login: "pi-durable[bot]" }, body: item.body });
const json = (value, status = 200) => Response.json(value, { status });
if (process.env.FAKE_FAST_POLL) {
  const sleep = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => sleep(callback, ms === 30_000 ? 1 : ms, ...args);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const data = state();
  const prefix = `/repos/${process.env.GITHUB_REPOSITORY}/`;
  if (url.hostname === "registry.npmjs.org") return json(data.registry);
  if (url.hostname !== "api.github.com") throw new Error(`Unexpected host: ${url}`);
  if (options.method && options.method !== "GET") appendFileSync(process.env.FAKE_GITHUB_LOG, `${options.method} ${url.pathname}\n`);
  if (url.pathname === "/users/pi-durable%5Bbot%5D") return json({ id: 123 });
  if (url.pathname === "/graphql") {
    const threads = structuredClone(data.threads);
    if (data.resolveOnFirstLookup) {
      data.threads.forEach((thread) => { thread.isResolved = true; });
      data.resolveOnFirstLookup = false;
      writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(data));
    }
    return json({ data: { repository: { pullRequest: {
      headRefOid: pull(data.open[0]).head.sha,
      reviewThreads: { nodes: threads, pageInfo: { hasNextPage: false, endCursor: null } },
    } } } });
  }
  if (!url.pathname.startsWith(prefix)) throw new Error(`Unexpected GitHub path: ${url}`);
  const path = url.pathname.slice(prefix.length);
  if (path === "pulls") return json(data.open.map(pull));
  if (/^pulls\/\d+$/.test(path)) {
    const item = data.open.find((value) => value.number === Number(path.split("/")[1]));
    return item ? json(pull(item)) : json({ message: "Not Found" }, 404);
  }
  if (/^commits\/[a-f0-9]{40}\/pulls$/.test(path)) {
    const commit = path.split("/")[1];
    return json(data.merged.filter((item) => item.sha === commit).map((item) => ({ merged_at: "2026-10-31T00:00:00Z",
      merge_commit_sha: item.sha, base: { ref: "main" }, head: { ref: item.branch, repo: { full_name: process.env.GITHUB_REPOSITORY } },
      user: { type: "Bot" } })));
  }
  if (/^commits\/[a-f0-9]{40}\/check-runs$/.test(path)) {
    const commit = path.split("/")[1];
    return json({ check_runs: data.checks.filter((check) => check.head_sha === commit) });
  }
  if (/^issues\/\d+\/comments$/.test(path)) return json(data.comments);
  if (/^pulls\/\d+\/reviews$/.test(path)) return json([]);
  if (path === "releases/generate-notes") return json({ body: "## What's Changed\n\n* Meaningful change" });
  if (path === "releases") return json(data.releases);
  if (path === "actions/workflows/npm-release.yml/runs") return json({ workflow_runs: data.runs });
  if (/^actions\/runs\/\d+\/artifacts$/.test(path)) return json({ artifacts: data.artifacts ?? [] });
  if (/^actions\/runs\/\d+\/rerun(?:-failed-jobs)?$/.test(path)) return new Response(null, { status: 201 });
  throw new Error(`Unexpected GitHub request: ${options.method ?? "GET"} ${url}`);
};
