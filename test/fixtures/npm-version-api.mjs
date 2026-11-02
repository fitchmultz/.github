import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const state = () => JSON.parse(readFileSync(process.env.FAKE_GITHUB_STATE, "utf8"));
const sha = (ref) => execFileSync("git", ["--git-dir", process.env.FAKE_GITHUB_REMOTE, "rev-parse", ref], { encoding: "utf8" }).trim();
const pull = (item) => ({ number: item.number, state: "open", base: { ref: "main", sha: sha("refs/heads/main") },
  head: { ref: item.branch, sha: sha(`refs/heads/${item.branch}`), repo: { full_name: process.env.GITHUB_REPOSITORY } },
  user: { login: item.author ?? "pi-durable[bot]" }, body: item.body });
const json = (value, status = 200) => Response.json(value, { status });
if (process.env.FAKE_FAST_POLL) {
  const sleep = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => sleep(callback, ms === 30_000 || ms === 10_000 ? 1 : ms, ...args);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const data = state();
  const prefix = `/repos/${process.env.GITHUB_REPOSITORY}/`;
  if (url.hostname === "registry.npmjs.org") return json(data.registry);
  if (url.hostname === "api.cursor.com") {
    const match = /^\/v1\/agents\/(bc-[a-f0-9-]+)(\/runs)?(?:\/(run-[a-f0-9-]+))?$/.exec(url.pathname);
    if (!match) throw new Error(`Unexpected Cursor path: ${url}`);
    const item = data.cursorReports[match[1]];
    if (!item) return json({ message: "Not Found" }, 404);
    const run = { id: `run-${match[1].slice(3)}`, agentId: match[1], status: "FINISHED" };
    return json(match[3] ? { ...run, result: item } : match[2] ? { items: [run] } : { id: match[1], latestRunId: run.id });
  }
  if (url.hostname === "durable.example.invalid") {
    const path = url.pathname;
    const review = /^\/api\/reviewer\/runs\/([^/]+)$/.exec(path);
    if (review) return data.piRuns?.[review[1]] ? json(data.piRuns[review[1]]) : json({ error: "Not found" }, 404);
    if (path === "/api/reviewer/reconcile" && options.method === "POST") {
      const body = JSON.parse(options.body);
      data.recoveries ??= [];
      data.recoveries.push(body);
      const check = data.checks.find((item) => item.app.slug === "pi-durable");
      check.status = "completed"; check.conclusion = "success";
      writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(data));
      return json({ delivery: "44444444-4444-4444-8444-444444444444", accepted: true }, 202);
    }
    if (path === "/api/chats" && options.method === "POST") {
      const id = JSON.parse(options.body).id;
      data.chatMetadata ??= {};
      data.chatMetadata[id] ??= { id, title: "New chat", createdAt: 1, updatedAt: 1 };
      writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(data));
      return json(data.chatMetadata[id]);
    }
    const metadata = /^\/api\/chats\/([^/]+)\/metadata$/.exec(path);
    if (metadata && options.method === "POST") {
      Object.assign(data.chatMetadata[metadata[1]], JSON.parse(options.body), { updatedAt: 2 });
      writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(data));
      return json(data.chatMetadata[metadata[1]]);
    }
    const model = /^\/api\/chats\/([^/]+)\/model$/.exec(path);
    if (model && options.method === "POST") {
      const body = JSON.parse(options.body);
      if (body.expectedVersion !== "fixture-configuration-version") return json({ error: "Stale configuration" }, 409);
      data.modelSelections ??= [];
      data.modelSelections.push({ chat: model[1], ...body });
      const { expectedVersion, ...configuration } = body;
      data.chatConfigurations ??= {};
      data.chatConfigurations[model[1]] = configuration;
      writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(data));
      return json({ connectionReady: true, configuration, configurationVersion: "fixture-configuration-version" });
    }
    const upload = /^\/api\/chats\/([^/]+)\/files\/upload$/.exec(path);
    if (upload) {
      const uploadId = url.searchParams.get("uploadId"), name = url.searchParams.get("name");
      const existing = data.uploads?.find((item) => item.uploadId === uploadId);
      if (options.method !== "POST") return existing ? json(existing) : json({ error: "Not found" }, 404);
      if (existing) return json({ error: "Already admitted" }, 409);
      const bytes = Buffer.from(options.body);
      if (options.headers["Content-Type"] !== "application/octet-stream"
        || Number(options.headers["Content-Length"]) !== bytes.length) return json({ error: "Invalid upload" }, 400);
      const receipt = { uploadId, name, path: `uploads/${uploadId}/${name}`, status: "completed", bytes: bytes.length };
      data.uploads ??= [];
      data.uploads.push(receipt);
      writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(data));
      return json(receipt);
    }
    const match = /^\/api\/chats\/([^/]+)(?:\/operations\/([^/]+))?$/.exec(path);
    if (!match) throw new Error(`Unexpected Pi Durable path: ${url}`);
    if (match[2]) return data.operations?.[match[2]] ? json(data.operations[match[2]]) : json({ error: "Not found" }, 404);
    if (options.method !== "POST") return json({ connectionReady: true,
      configuration: data.chatConfigurations?.[match[1]] ?? data.chatConfiguration ?? { provider: "cloudflare-ai-gateway" },
      configurationVersion: "fixture-configuration-version" });
    const body = JSON.parse(options.body);
    data.operations ??= {};
    data.submissions ??= [];
    data.submissions.push({ operationId: body.operationId, prompt: body.prompt });
    data.operations[body.operationId] = data.durableOutcome ?? { status: "done", text: JSON.stringify({ status: "no_findings", reason: "No finding in this report" }) };
    writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(data));
    return json({ operationId: body.operationId, accepted: true }, 202);
  }
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
