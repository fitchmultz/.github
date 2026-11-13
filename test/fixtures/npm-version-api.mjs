import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const state = () => JSON.parse(readFileSync(process.env.FAKE_GITHUB_STATE, "utf8"));
const save = (data) => writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(data));
const remote = () => process.env.FAKE_GITHUB_REMOTE;
const git = (args, options = {}) =>
  execFileSync("git", ["--git-dir", remote(), ...args], { encoding: "utf8", ...options }).trim();
const json = (value, status = 200) => Response.json(value, { status });

if (process.env.FAKE_FAST_POLL) {
  const sleep = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) =>
    sleep(callback, ms === 30_000 || ms === 10_000 || ms === 2_000 ? 1 : ms, ...args);
}

function buildTree(baseTree, entries) {
  const dir = mkdtempSync("/tmp/fake-gh-tree-");
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  try {
    git(["read-tree", baseTree], { env });
    for (const entry of entries) {
      if (entry.sha === null) {
        git(["update-index", "--index-info"], { env, input: `0 0000000000000000000000000000000000000000\t${entry.path}\n` });
      } else {
        git(["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`], { env });
      }
    }
    return git(["write-tree"], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function advanceConcurrently(note) {
  const mainSha = git(["rev-parse", "refs/heads/main"]);
  const baseTree = git(["rev-parse", `${mainSha}^{tree}`]);
  const blobSha = git(["hash-object", "-w", "--stdin"], { input: `${note}\n` });
  const nextTree = buildTree(baseTree, [{ path: "concurrent.txt", mode: "100644", type: "blob", sha: blobSha }]);
  const commitSha = git(["commit-tree", nextTree, "-p", mainSha, "-m", note], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Concurrent merge",
      GIT_AUTHOR_EMAIL: "dev@example.invalid",
      GIT_COMMITTER_NAME: "Concurrent merge",
      GIT_COMMITTER_EMAIL: "dev@example.invalid",
    },
  });
  git(["update-ref", "refs/heads/main", commitSha]);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const data = state();
  const prefix = `/repos/${process.env.GITHUB_REPOSITORY}/`;
  if (url.hostname === "registry.npmjs.org") {
    if (url.pathname.endsWith(".tgz") && data.tarballPath) {
      return new Response(readFileSync(data.tarballPath));
    }
    if (url.pathname === "/@earendil-works%2Fpi-coding-agent/latest" && data.officialHost) {
      return Response.json(data.officialHost);
    }
    return json(data.registry);
  }
  if (url.hostname !== "api.github.com") throw new Error(`Unexpected host: ${url}`);
  if (options.method && options.method !== "GET") {
    appendFileSync(process.env.FAKE_GITHUB_LOG, `${options.method} ${url.pathname}\n`);
  }
  if (!url.pathname.startsWith(prefix)) throw new Error(`Unexpected GitHub path: ${url}`);
  const path = url.pathname.slice(prefix.length);

  if (/^commits\/[a-f0-9]{40}$/.test(path)) {
    const sha = path.split("/")[1];
    const isBot = data.botCommits?.includes(sha) === true;
    const verified = isBot && !data.unverifiedCommits?.includes(sha);
    return json({
      sha,
      author: isBot ? { login: "pi-durable[bot]", type: "Bot" } : { login: "fitchmultz", type: "User" },
      commit: { verification: { verified, reason: verified ? "valid" : "unsigned" } },
    });
  }
  if (/^git\/commits\/[a-f0-9]{40}$/.test(path) && (!options.method || options.method === "GET")) {
    const sha = path.split("/")[2];
    return json({ sha, tree: { sha: git(["rev-parse", `${sha}^{tree}`]) } });
  }
  if (path === "git/blobs" && options.method === "POST") {
    const body = JSON.parse(options.body);
    const sha = git(["hash-object", "-w", "--stdin"], { input: body.content });
    return json({ sha }, 201);
  }
  if (path === "git/trees" && options.method === "POST") {
    const body = JSON.parse(options.body);
    const sha = buildTree(body.base_tree, body.tree);
    return json({ sha }, 201);
  }
  if (path === "git/commits" && options.method === "POST") {
    const body = JSON.parse(options.body);
    const sha = git(
      ["commit-tree", body.tree, ...body.parents.flatMap((parent) => ["-p", parent]), "-m", body.message],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "pi-durable[bot]",
          GIT_AUTHOR_EMAIL: "pi-durable[bot]@users.noreply.github.com",
          GIT_COMMITTER_NAME: "GitHub",
          GIT_COMMITTER_EMAIL: "noreply@github.com",
        },
      },
    );
    data.botCommits ??= [];
    data.botCommits.push(sha);
    save(data);
    return json({ sha, verification: { verified: true, reason: "valid" } }, 201);
  }
  if (path === "git/refs/heads/main" && options.method === "PATCH") {
    const body = JSON.parse(options.body);
    if (data.concurrentAdvances?.length) {
      const note = data.concurrentAdvances.shift();
      save(data);
      advanceConcurrently(note);
    }
    const currentMain = git(["rev-parse", "refs/heads/main"]);
    const ancestor = spawnSync("git", ["--git-dir", remote(), "merge-base", "--is-ancestor", currentMain, body.sha]);
    if (!body.force && ancestor.status !== 0) {
      return json({ message: "Update is not a fast forward" }, 422);
    }
    git(["update-ref", "refs/heads/main", body.sha]);
    return json({ ref: "refs/heads/main", object: { sha: body.sha } });
  }
  if (path === "releases/generate-notes") {
    const { tag_name: tag, target_commitish: target, previous_tag_name: previous } = JSON.parse(options.body);
    appendFileSync(process.env.FAKE_GITHUB_LOG, `generate-notes previous=${previous}\n`);
    const changes = git(["log", "--first-parent", "--reverse", "--format=* %s", `${previous}..${target}`]);
    return json({
      body: `## What's Changed\n\n${changes}\n\n**Full Changelog**: https://github.com/${process.env.GITHUB_REPOSITORY}/compare/${previous}...${tag}`,
    });
  }
  if (path === "releases") return json(data.releases);
  if (path === "actions/workflows/npm-release.yml/runs") return json({ workflow_runs: data.runs });
  if (path === "actions/workflows/npm-release.yml/dispatches" && options.method === "POST") {
    return new Response(null, { status: 204 });
  }
  if (/^actions\/runs\/\d+\/artifacts$/.test(path)) return json({ artifacts: data.artifacts ?? [] });
  if (/^actions\/runs\/\d+\/rerun(?:-failed-jobs)?$/.test(path)) return new Response(null, { status: 201 });
  throw new Error(`Unexpected GitHub request: ${options.method ?? "GET"} ${url}`);
};
