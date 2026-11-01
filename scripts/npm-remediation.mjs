import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readJson, run } from "./common.mjs";
import { markedSource } from "./npm-release-core.mjs";
import { remediationPrompt } from "./npm-remediation-prompt.mjs";
import { checkRuns, findingCheck, request, reviewThreads } from "./npm-version.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = () => process.env.GH_TOKEN;
const trustedAuthors = new Set(["pi-durable[bot]", "fitchmultz"]);
const automation = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const promptVersions = new Map();

function uuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function durable(path, { method = "GET", body, missing = false } = {}) {
  const origin = new URL(process.env.PI_DURABLE_ORIGIN);
  assert.equal(origin.protocol, "https:", "Pi Durable requires an HTTPS installation origin");
  assert.ok(process.env.PI_DURABLE_ACCESS_TOKEN, "Pi Durable owner token is missing");
  const response = await fetch(new URL(path, origin), { method, headers: {
    Authorization: `Bearer ${process.env.PI_DURABLE_ACCESS_TOKEN}`,
    ...(body ? { "Content-Type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (missing && response.status === 404) return null;
  assert.ok(response.ok, `Pi Durable ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

async function savedPrompt(repository, number, source) {
  const revision = run("git", ["rev-parse", "HEAD"], { cwd: automation, quiet: true }).trim();
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const ledger = uuid(`npm-release-input:${repository}#${number}:${source.key}`);
  let metadata = await durable("/api/chats", { method: "POST", body: { id: ledger } });
  if (metadata.title === "New chat" && metadata.createdAt === metadata.updatedAt) {
    const title = `npm-input:${revision}:${digest(remediationPrompt(repository, number, source))}`;
    metadata = await durable(`/api/chats/${ledger}/metadata`, { method: "POST", body: { title, archived: true } });
    assert.equal(metadata.title, title, "Pi Durable did not retain the original prompt identity");
  }
  const match = /^npm-input:([a-f0-9]{40}):([a-f0-9]{64})$/.exec(metadata.title ?? "");
  assert.ok(match, "The original remediation prompt identity is unavailable");
  let makePrompt = remediationPrompt;
  if (match[1] !== revision) {
    if (!promptVersions.has(match[1])) {
      const shallow = run("git", ["rev-parse", "--is-shallow-repository"], { cwd: automation, quiet: true }).trim() === "true";
      run("git", ["fetch", "--no-tags", ...(shallow ? ["--unshallow"] : []),
        "origin", "+refs/heads/main:refs/remotes/origin/main"], { cwd: automation, quiet: true });
      run("git", ["merge-base", "--is-ancestor", match[1], "refs/remotes/origin/main"], { cwd: automation, quiet: true });
      const old = run("git", ["show", `${match[1]}:scripts/npm-remediation-prompt.mjs`], { cwd: automation, quiet: true });
      const module = await import(`data:text/javascript;base64,${Buffer.from(old).toString("base64")}`);
      assert.equal(typeof module.remediationPrompt, "function", "Original prompt generator is unavailable");
      promptVersions.set(match[1], module.remediationPrompt);
    }
    makePrompt = promptVersions.get(match[1]);
  }
  const text = makePrompt(repository, number, source);
  assert.equal(digest(text), match[2], "Remediation source differs from its original prompt");
  assert.ok(Buffer.byteLength(text) <= 128 * 1024, "Pi Durable prompt exceeds its 128 KiB protocol limit");
  return text;
}

async function task(repository, number, source) {
  const chat = uuid(`npm-release-chat:${repository}#${number}`);
  const operation = uuid(`npm-release-source:${repository}#${number}:${source.key}`);
  const path = `/api/chats/${chat}/operations/${operation}`;
  await durable("/api/chats", { method: "POST", body: { id: chat } });
  const text = await savedPrompt(repository, number, source);
  let receipt = await durable(path, { missing: true });
  if (!receipt) {
    const state = await durable(`/api/chats/${chat}`);
    assert.equal(state.connectionReady, true, "Pi Durable chat connection is not ready");
    await durable(`/api/chats/${chat}`, { method: "POST", body: { prompt: text, operationId: operation, whenBusy: "followUp" } });
    receipt = await durable(path);
  }
  while (["queued", "running", "reconciling"].includes(receipt.status)) {
    await pause(10_000);
    receipt = await durable(path);
  }
  assert.equal(receipt.status, "done", `Pi Durable operation ${operation} is ${receipt.status}: ${receipt.reason ?? ""}; it will not be replayed`);
  let result;
  try { result = JSON.parse(receipt.text); } catch { throw new Error(`Pi Durable operation ${operation} did not return the required JSON disposition`); }
  assert.ok(["no_findings", "addressed", "blocked"].includes(result.status) && typeof result.reason === "string" && result.reason.trim(),
    `Pi Durable operation ${operation} returned an invalid disposition`);
  assert.notEqual(result.status, "blocked", `Pi Durable could not resolve ${source.url}: ${result.reason}`);
  console.log(`Reviewed ${source.url}: ${result.status} — ${result.reason}`);
  return result;
}

async function cursorReports(check, cache) {
  assert.ok(process.env.CURSOR_API_KEY, "Cursor API key is missing");
  const url = new URL(check.details_url);
  const match = /^\/agents\/(bc-[a-f0-9-]+)$/.exec(url.pathname);
  assert.ok(url.origin === "https://cursor.com" && match, "Cursor check does not identify its agent");
  const get = async (path) => {
    const response = await fetch(`https://api.cursor.com/v1${path}`, { headers: { Authorization: `Bearer ${process.env.CURSOR_API_KEY}` } });
    assert.ok(response.ok, `Cursor ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const agent = await get(`/agents/${match[1]}`);
  assert.equal(agent.id, match[1], "Cursor returned a different agent");
  const runs = [];
  let next;
  do {
    const page = await get(`/agents/${match[1]}/runs?limit=100${next ? `&cursor=${encodeURIComponent(next)}` : ""}`);
    assert.ok(Array.isArray(page.items), "Cursor did not return a run list");
    runs.push(...page.items);
    next = page.nextCursor;
  } while (next);
  const reports = [];
  for (const run of runs.reverse().filter((item) => item.status === "FINISHED")) {
    assert.match(run.id ?? "", /^run-[a-f0-9-]+$/, "Cursor run has no stable identity");
    if (!cache.has(run.id)) cache.set(run.id, await get(`/agents/${match[1]}/runs/${run.id}`));
    const report = cache.get(run.id);
    assert.equal(report.id, run.id, "Cursor returned a different run");
    assert.equal(report.agentId, agent.id, "Cursor returned a different agent's run");
    assert.equal(report.status, "FINISHED", "Cursor review report is not finished");
    assert.ok(typeof report.result === "string" && report.result.trim(), "Cursor review report is empty");
    reports.push({ key: `cursor:${agent.id}:${report.id}`, kind: "cursor", url: url.href, runId: report.id, report: report.result });
  }
  assert.ok(reports.length, "Cursor check has no completed report");
  return { reports, pending: runs.some((run) => ["CREATING", "RUNNING", "WAITING_FOR_BACKGROUND_WORK"].includes(run.status)) };
}

async function recoverIncompleteReview(repository, number, pull, check) {
  const url = new URL(check.details_url);
  assert.equal(url.origin, new URL(process.env.PI_DURABLE_ORIGIN).origin, "Pi review points to another installation");
  const delivery = url.hash.slice(1);
  assert.match(delivery, /^[a-f0-9-]{36}$/, "Pi review has no delivery identity");
  const original = await durable(`/api/reviewer/runs/${delivery}`);
  assert.equal(original.status, "incomplete", "Pi review is not terminal-incomplete");
  assert.equal(original.taskState?.status, "terminal", "Pi review work has not settled");
  assert.equal(original.pair?.base, pull.base.sha, "Incomplete Pi review used a different base");
  assert.equal(original.pair?.head, pull.head.sha, "Incomplete Pi review used a different head");
  assert.ok(Object.values(original.posts ?? {}).every((post) => !["intent", "uncertain"].includes(post.status)),
    "Pi review has an uncertain comment; inspect it before recovery");
  const operationId = uuid(`npm-review-reconcile:${repository}#${number}:${check.id}`);
  const admission = await durable("/api/reviewer/reconcile", { method: "POST", body: { operationId, repository, pull: number } });
  assert.match(admission.delivery ?? "", /^[a-f0-9-]{36}$/, "Pi reviewer did not return a recovery delivery");
  if (!admission.accepted) {
    const previous = await durable(`/api/reviewer/runs/${admission.delivery}`);
    assert.notEqual(previous.status, "incomplete", `The native Pi review recovery also ended incomplete: ${previous.reason ?? ""}`);
  }
  console.log(`Requested native recovery of incomplete Pi review ${delivery}`);
  await pause(10_000);
}

async function conversation(number) {
  return request(`issues/${number}/comments?per_page=100`, { token: token(), paginate: true });
}

async function verifyConversation(number, source, result) {
  assert.equal(result.status, "addressed", `${source.url} was not addressed`);
  assert.ok(typeof result.evidenceUrl === "string", `${source.url} has no PR reply URL`);
  const comments = await conversation(number);
  const reply = comments.find((comment) => comment.html_url === result.evidenceUrl);
  assert.ok(reply && trustedAuthors.has(reply.user?.login) && reply.body?.includes(source.url)
    && (!source.runId || reply.body.includes(source.runId))
    && reply.body.replace(source.url, "").trim(), `No attributable PR reply addresses ${source.url}`);
}

async function threads(number, head) {
  const [owner, name] = process.env.GITHUB_REPOSITORY.split("/");
  const found = [];
  let cursor = null;
  do {
    const result = await request("https://api.github.com/graphql", { method: "POST", token: token(), body: {
      query: `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$name) { pullRequest(number:$number) { headRefOid
          reviewThreads(first:100,after:$cursor) { nodes { id isResolved comments(first:1) { nodes { databaseId url } } }
            pageInfo { hasNextPage endCursor } }
        } }
      }`, variables: { owner, name, number, cursor },
    } });
    assert.ok(!result.errors?.length, `GitHub review thread lookup failed: ${JSON.stringify(result.errors)}`);
    const pull = result.data.repository.pullRequest;
    assert.equal(pull.headRefOid, head, "Version PR head changed while checking review threads");
    found.push(...pull.reviewThreads.nodes);
    cursor = pull.reviewThreads.pageInfo.hasNextPage ? pull.reviewThreads.pageInfo.endCursor : null;
  } while (cursor);
  return found;
}

async function verifyThread(number, head, source) {
  const thread = (await threads(number, head)).find((item) => item.id === source.threadId);
  assert.ok(thread?.isResolved, `Review thread remains unresolved: ${source.url}`);
  const comments = await request(`pulls/${number}/comments?per_page=100`, { token: token(), paginate: true });
  assert.ok(comments.some((comment) => comment.in_reply_to_id === source.commentId && trustedAuthors.has(comment.user?.login)
    && comment.body?.trim()), `Review thread has no attributable reply: ${source.url}`);
}

async function pull(number) {
  const result = await request(`pulls/${number}`, { token: token() });
  assert.equal(result.state, "open", "Version PR is no longer open");
  return result;
}

function output(key) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=true\n`);
}

function outputCursor(check) {
  assert.ok(Number.isSafeInteger(check.id) && check.id > 0, "Cursor check has no stable GitHub identity");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `cursor=${check.id}\n`);
}

async function remediate(source, number, head, releaseSource, appSlug, packageQualified) {
  const repository = process.env.GITHUB_REPOSITORY;
  const entry = readJson(new URL("../fleet.json", import.meta.url)).find((item) => `fitchmultz/${item.repo}` === repository);
  assert.ok(entry?.npmRelease === "automatic" && (!entry.releaseQualification || packageQualified) && !entry.versionQualification,
    "Repository is not enabled for automatic version remediation");
  const reports = new Map();
  const commits = run("git", ["rev-list", "--reverse", "^refs/remotes/origin/main", head], { cwd: source, quiet: true })
    .trim().split("\n").filter(Boolean);
  while (true) {
    const current = await pull(number);
    assert.equal(current.user?.login, `${appSlug}[bot]`, "Version PR is not owned by the release App");
    assert.equal(current.base?.ref, "main", "Version PR does not target main");
    assert.equal(current.head?.repo?.full_name, repository, "Version PR is not from the source repository");
    assert.equal(current.head?.ref, `npm-version/${releaseSource}`, "Version PR branch does not match its release source");
    assert.equal(markedSource(current.body), releaseSource, "Version PR source marker changed");
    if (current.head.sha !== head) { output("refresh"); return; }
    const checks = await checkRuns(head);
    const pi = checks.find((check) => check.app?.slug === "pi-durable" && check.name === "Pi Durable Review");
    const cursor = checks.find((check) => check.app?.slug === "cursor" && check.name === "Cursor Automation: PR Bug Review - Maintained Repos");
    const failed = checks.find((check) => check.status === "completed" && ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(check.conclusion)
      && !(check === pi && findingCheck(check)));
    if (failed) {
      if (failed === pi && failed.conclusion === "action_required") {
        await recoverIncompleteReview(repository, number, current, failed);
        continue;
      }
      const item = { key: `check:${failed.id}`, kind: "check", url: failed.html_url ?? failed.details_url, head: failed.head_sha };
      const result = await task(repository, number, item);
      assert.equal(result.status, "addressed", `Failed check was not addressed: ${item.url}`);
      if ((await pull(number)).head.sha !== head) { output("refresh"); return; }
      const after = await checkRuns(head);
      assert.ok(!after.some((check) => check.id === failed.id && check.status === "completed" && check.conclusion === failed.conclusion),
        `The failed check has not been rerun or replaced: ${item.url}`);
      continue;
    }
    const pending = (await threads(number, head)).find((thread) => !thread.isResolved);
    if (pending) {
      const comment = pending.comments.nodes[0];
      assert.ok(comment?.url && comment.databaseId, "Unresolved thread has no review comment");
      const item = { key: `thread:${pending.id}`, kind: "thread", url: comment.url, threadId: pending.id, commentId: comment.databaseId };
      const result = await task(repository, number, item);
      assert.equal(result.status, "addressed", `Review thread was not addressed: ${item.url}`);
      const after = await pull(number);
      await verifyThread(number, after.head.sha, item);
      if (after.head.sha !== head) { output("refresh"); return; }
      continue;
    }
    const state = await reviewThreads(number, head, true, pi);
    if (state.unanswered.length) {
      const finding = state.unanswered[0];
      const item = { key: `${finding.kind}:${finding.id}`, ...finding };
      const result = await task(repository, number, item);
      await verifyConversation(number, item, result);
      if ((await pull(number)).head.sha !== head) { output("refresh"); return; }
      continue;
    }
    let pendingReview = false;
    for (const commit of commits) {
      const historical = commit === head ? checks : await checkRuns(commit);
      for (const check of historical.filter((item) => item.app?.slug === "cursor" && item.name === "Cursor Automation: PR Bug Review - Maintained Repos")) {
        if (check.status !== "completed") { pendingReview = true; continue; }
        if (check.conclusion !== "success") continue;
        const result = await cursorReports(check, reports);
        pendingReview ||= result.pending;
        for (const item of result.reports) {
          const disposition = await task(repository, number, item);
          if (disposition.status === "addressed") await verifyConversation(number, item, disposition);
          if ((await pull(number)).head.sha !== head) { output("refresh"); return; }
        }
      }
    }
    const required = (entry.releaseChecks ?? ["compatibility / compatibility"]).map((name) =>
      checks.find((check) => check.app?.slug === "github-actions" && check.name === name && check.head_sha === head));
    const checksReady = required.every((check) => check?.status === "completed" && check.conclusion === "success")
      && checks.every((check) => check.status === "completed");
    if (!pendingReview && checksReady && pi?.status === "completed" && cursor?.status === "completed" && cursor.conclusion === "success") {
      outputCursor(cursor);
      output("ready");
      return;
    }
    console.log("Waiting for current-head reviews; completed feedback has been handled");
    await pause(10_000);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: "string" }, pull: { type: "string" }, head: { type: "string" },
    "release-source": { type: "string" }, "app-slug": { type: "string" },
    "package-qualified": { type: "boolean", default: false },
  } });
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Remediation only runs in GitHub Actions");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Remediation only runs from main");
  const number = Number(values.pull);
  assert.ok(values.source && values["app-slug"] && Number.isSafeInteger(number) && number > 0
    && /^[a-f0-9]{40}$/.test(values.head ?? "") && /^[a-f0-9]{40}$/.test(values["release-source"] ?? ""),
  "source, pull, head, release-source and app-slug are required");
  await remediate(resolve(values.source), number, values.head, values["release-source"], values["app-slug"], values["package-qualified"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
