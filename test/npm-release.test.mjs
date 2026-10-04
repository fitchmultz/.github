import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { codingAgent, writeJson } from "../scripts/common.mjs";

let invocation = 0;
const repository = "fitchmultz/pi-copy-message";
const name = "pi-copy-message";
const repositoryUrl = `git+https://github.com/${repository}.git`;
const forkRef = "b".repeat(40);

function exec(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, version = "4.0.1", changelog = `## ${version} - 2026-10-04\n\nFix copying a selected message.\n\n## 4.0.0\n\nEarlier release.\n`) {
  const root = mkdtempSync("/tmp/npm-release-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  writeJson(join(source, "package.json"), { name, version, repository: { type: "git", url: repositoryUrl },
    scripts: { prepublishOnly: `node -e 'require("fs").writeFileSync("published", "unexpected")'` } });
  writeFileSync(join(source, "CHANGELOG.md"), changelog);
  exec("git", ["init", "--quiet", "--initial-branch=main"], source);
  exec("git", ["config", "user.name", "Release test"], source);
  exec("git", ["config", "user.email", "release-test@example.invalid"], source);
  exec("git", ["add", "."], source);
  exec("git", ["commit", "--quiet", "-m", "Release fixture"], source);
  const ref = exec("git", ["rev-parse", "HEAD"], source);
  return { root, source, ref, output: join(root, "output") };
}

function metadata(latest = "4.0.0") {
  return { name, maintainers: [{ name: "fitchmultz" }], "dist-tags": { latest },
    versions: { [latest]: { name, version: latest, repository: { type: "git", url: repositoryUrl } } } };
}

// Execute the real CLI entry point, including Git cleanliness, HTTP response handling and workflow outputs.
// HTTP and publication subprocess boundaries are replaced; this is not real host/OIDC qualification.
async function invoke(t, fixture, command, { data = metadata(), pulls, draft, releasePages, releaseStatus = 200, status = 200, args = [], environment = {}, published } = {}) {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const env = { GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: fixture.output, GH_TOKEN: undefined,
    GITHUB_ACTIONS: undefined, GITHUB_REF: undefined, GITHUB_WORKFLOW_REF: undefined,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined, ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
    GITHUB_RUN_ID: undefined, GITHUB_RUN_ATTEMPT: undefined, ...environment };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const requests = [];
  const errors = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    if (String(url) === `https://registry.npmjs.org/${name}/${published?.version}`) return Response.json(published);
    if (String(url) === `https://registry.npmjs.org/${name}`) return Response.json(typeof data === "function" ? data() : data, { status });
    if (String(url) === `https://registry.npmjs.org/${encodeURIComponent(codingAgent)}/latest`) {
      return Response.json({ name: codingAgent, version: "9.8.7", dist: { integrity: "sha512-host-fixture", tarball: "https://registry.npmjs.org/host-fixture.tgz" } });
    }
    if (String(url) === "https://api.github.com/repos/fitchmultz/pi/commits/main") return Response.json({ sha: forkRef });
    if (String(url) === `https://api.github.com/repos/${repository}/releases/tags/v${data["dist-tags"].latest}`) {
      return draft?.draft === false ? Response.json(draft) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (String(url).startsWith(`https://api.github.com/repos/${repository}/releases?per_page=100&page=`)) {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json(releasePages?.[page - 1] ?? (draft ? [{ ...draft, tag_name: `v${data["dist-tags"].latest}` }] : []), { status: releaseStatus });
    }
    assert.equal(String(url), `https://api.github.com/repos/${repository}/commits/${fixture.ref}/pulls`);
    return Response.json(pulls ?? [{ merged_at: "2026-10-04T12:00:00Z", base: { ref: "main" }, merge_commit_sha: fixture.ref }]);
  });
  const log = t.mock.method(console, "log", () => {});
  const error = t.mock.method(console, "error", (value) => errors.push(String(value)));
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = undefined;
    process.argv = [argv[0], "npm-release.mjs", command, "--source", fixture.source, ...args];
    await import(`../scripts/npm-release.mjs?fixture=${++invocation}`);
    const outputs = Object.fromEntries((existsSync(fixture.output) ? readFileSync(fixture.output, "utf8").trim().split("\n") : [])
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    return { errors: errors.join("\n"), failed: process.exitCode === 1, requests, outputs };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    fetch.mock.restore();
    log.mock.restore();
    error.mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const refused = (result, reason) => {
  assert.equal(result.failed, true);
  assert.match(result.errors, reason);
  assert.deepEqual(result.outputs, {});
};

test("an already-published version is a read-only no-op, even with unversioned notes", async (t) => {
  const f = fixture(t, "4.0.0", "## Unreleased\n\nChanges that still need a version bump.\n");
  const result = await invoke(t, f, "plan");
  assert.equal(result.failed, false, result.errors);
  assert.deepEqual(result.outputs, { release: "false", source: f.ref, version: "4.0.0" });
  assert.deepEqual(result.requests, [`https://registry.npmjs.org/${name}`, `https://api.github.com/repos/${repository}/releases?per_page=100&page=1`]);
  assert.equal(existsSync(join(f.source, "published")), false);
  assert.equal(exec("git", ["status", "--porcelain"], f.source), "");
});

test("a newer, owned version with versioned notes and a merged main PR becomes a candidate", async (t) => {
  const f = fixture(t);
  const result = await invoke(t, f, "plan", { args: ["--source-ref", f.ref] });
  assert.equal(result.failed, false, result.errors);
  assert.deepEqual(result.outputs, { release: "true", source: f.ref, version: "4.0.1", "official-version": "9.8.7", "fork-ref": forkRef });
  assert.equal(result.requests.filter((url) => url.endsWith("/latest")).length, 1);
  assert.equal(result.requests.filter((url) => url === "https://api.github.com/repos/fitchmultz/pi/commits/main").length, 1);
  assert.equal(existsSync(join(f.source, "published")), false);
});

test("only this automation's exact-commit draft is resumed after npm publication succeeds", async (t) => {
  for (const kind of ["matching", "later-page", "other-source", "unrecognized", "finished", "forbidden"]) {
    const f = fixture(t);
    const data = metadata("4.0.1");
    data.versions["4.0.1"].dist = { integrity: "sha512-published-candidate" };
    const draft = { draft: kind !== "finished", body: kind === "unrecognized" ? "A maintainer's unrelated draft."
      : `<!-- pi-npm-release: ${kind === "other-source" ? "a".repeat(40) : f.ref} sha512-published-candidate -->` };
    const releasePages = kind === "later-page" ? [Array.from({ length: 100 }, (_, index) => ({ tag_name: `v3.0.${index}`, draft: false })), [{ ...draft, tag_name: "v4.0.1" }]] : undefined;
    const result = await invoke(t, f, "plan", { data, draft, releasePages, releaseStatus: kind === "forbidden" ? 403 : 200 });
    if (kind === "forbidden") refused(result, /GitHub release lookup: HTTP 403/);
    else {
      assert.equal(result.failed, false, result.errors);
      assert.equal(result.outputs.release, String(kind === "matching" || kind === "later-page"));
      if (kind === "later-page") assert.ok(result.requests.includes(`https://api.github.com/repos/${repository}/releases?per_page=100&page=2`));
    }
  }
});

test("foreign npm ownership, source identity changes and registry failures never become release candidates", async (t) => {
  for (const kind of ["maintainer", "repository", "unavailable"]) {
    const f = fixture(t);
    const data = metadata();
    if (kind === "maintainer") data.maintainers = [{ name: "someone-else" }];
    if (kind === "repository") data.versions["4.0.0"].repository.url = "git+https://github.com/other/pi-copy-message.git";
    const result = await invoke(t, f, "plan", { data, status: kind === "unavailable" ? 503 : 200 });
    refused(result, kind === "maintainer" ? /not maintained/ : kind === "repository" ? /repository identity/ : /HTTP 503/);
  }
});

test("direct pushes, unmerged PRs and a different merged commit do not authorize publication", async (t) => {
  for (const pulls of [[], [{ merged_at: null, base: { ref: "main" } }],
    [{ merged_at: "2026-10-04", base: { ref: "other" } }],
    [{ merged_at: "2026-10-04", base: { ref: "main" }, merge_commit_sha: "a".repeat(40) }]]) {
    const f = fixture(t);
    refused(await invoke(t, f, "plan", { pulls }), /merged PR to main/);
  }
});

test("downgrades and prereleases cannot move the automated latest channel", async (t) => {
  for (const [version, latest, reason] of [["4.0.0", "4.0.1", /move latest backwards/], ["4.1.0-beta.1", "4.0.0", /stable x.y.z/]]) {
    const f = fixture(t, version);
    refused(await invoke(t, f, "plan", { data: metadata(latest) }), reason);
  }
});

test("missing, empty or duplicate versioned release notes block a new release", async (t) => {
  for (const changelog of ["## Unreleased\n\nPending changes.\n", "## 4.0.1\n\n## 4.0.0\n\nOlder.\n", "## 4.0.1\n\nOne.\n\n## [4.0.1]\n\nTwo.\n"]) {
    const f = fixture(t, "4.0.1", changelog);
    refused(await invoke(t, f, "plan"), /versioned section|notes are empty/);
  }
});

test("publication rejects local execution and unexpected OIDC callers before artifact access", async (t) => {
  for (const [environment, reason] of [[{}, /only runs in GitHub Actions/],
    [{ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/feature" }, /only runs from main/],
    [{ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@refs/heads/main` }, /Unexpected trusted publisher caller/]]) {
    const f = fixture(t);
    const result = await invoke(t, f, "publish", { environment, args: ["--artifact", "/does-not-exist", "--source-ref", f.ref] });
    refused(result, reason);
    assert.deepEqual(result.requests, []);
  }
});

test("publication requires exact frozen host identities before artifact access", async (t) => {
  const environment = { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/npm-release.yml@refs/heads/main`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
  for (const [args, reason] of [
    [["--fork-ref", forkRef], /publish requires exact --official-version/],
    [["--official-version", "9.8.7"], /publish requires exact --fork-ref/],
    [["--official-version", "", "--fork-ref", ""], /publish requires exact --official-version/],
    [["--official-version", "latest", "--fork-ref", forkRef], /publish requires exact --official-version/],
    [["--official-version", "9.8.7", "--fork-ref", "main"], /publish requires exact --fork-ref/],
  ]) {
    const f = fixture(t);
    const result = await invoke(t, f, "publish", { environment,
      args: ["--artifact", "/does-not-exist", "--source-ref", f.ref, ...args] });
    refused(result, reason);
    assert.deepEqual(result.requests, []);
  }
});

function artifact(f) {
  const directory = join(f.root, "artifact");
  mkdirSync(directory);
  const packedJson = JSON.parse(exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], f.source));
  const [packed] = Array.isArray(packedJson) ? packedJson : Object.values(packedJson);
  const tarball = join(directory, packed.filename);
  const candidate = { repository, source: f.ref, name, version: "4.0.1", approval: false, filename: packed.filename,
    sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), integrity: packed.integrity,
    notes: "Fix copying a selected message.", hosts: { official: { flavor: "official", version: "9.8.7" },
      fork: { flavor: "fork", provenance: { ref: forkRef } } } };
  return { directory, tarball, candidate };
}

test("downloaded artifact checksum, commit and manifest mismatches fail before credentials or publication", async (t) => {
  for (const kind of ["bytes", "commit", "version"]) {
    const f = fixture(t);
    const { directory, tarball, candidate } = artifact(f);
    // This transport receipt is never accepted as qualification proof.
    // Each corruption must fail at its own earlier transport/identity guard.
    if (kind === "bytes") appendFileSync(tarball, "corruption");
    if (kind === "commit") candidate.source = "a".repeat(40);
    if (kind === "version") candidate.version = "4.0.2";
    writeJson(join(directory, "release.json"), candidate);
    writeFileSync(join(directory, "release-notes.md"), `${candidate.notes}\n`);
    const result = await invoke(t, f, "verify", { args: ["--artifact", directory, "--source-ref", f.ref] });
    refused(result, kind === "bytes" ? /checksum changed/ : kind === "commit" ? /different source commit/ : /4\.0\.1.*4\.0\.2/s);
    assert.deepEqual(result.requests, []);
  }
});

test("npm publication receives runner provenance context but no inherited credentials", async (t) => {
  const f = fixture(t);
  const { directory, candidate } = artifact(f);
  writeJson(join(directory, "release.json"), candidate);
  writeFileSync(join(directory, "release-notes.md"), `${candidate.notes}\n`);
  const calls = [];
  let publishedAtBoundary = false;
  const nativeSpawnSync = childProcess.spawnSync;
  const mock = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command !== "gh" && command !== "npm") return nativeSpawnSync(command, args, options);
    calls.push({ command, args, cwd: options.cwd });
    for (const key of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_BOOTSTRAP_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
      assert.equal(options.env[key], undefined, `${key} must not reach publication subprocesses`);
    }
    assert.equal(readFileSync(options.env.npm_config_userconfig, "utf8"), "");
    let value;
    if (command === "npm") {
      assert.equal(options.env.RUNNER_ENVIRONMENT, "github-hosted");
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "oidc-fixture");
      assert.deepEqual(args, ["publish", join(directory, candidate.filename), "--ignore-scripts",
        "--registry=https://registry.npmjs.org/", "--access=public", "--tag=latest", "--provenance"]);
      publishedAtBoundary = true;
      value = "";
    } else {
      assert.equal(options.env.RUNNER_ENVIRONMENT, undefined, "runner context is only needed by npm");
      assert.equal(options.env.GH_TOKEN, "github-fixture");
      const path = args[1]?.replace(`repos/${repository}/`, "");
      if (path === "environments/npm") value = { deployment_branch_policy: { custom_branch_policies: true } };
      else if (path === "environments/npm/deployment-branch-policies") value = { branch_policies: [{ name: "main", type: "branch" }] };
      else if (path === "commits/main") value = { sha: f.ref };
      else if (path === "releases?per_page=100") value = [[]];
      else if (path === `git/matching-refs/tags/v${candidate.version}`) value = [];
      else if (path === "git/tags") value = { sha: "c".repeat(40) };
      else if (path === "git/refs") value = {};
      else if (path === "releases") value = { draft: true, assets: [] };
      else { assert.equal(args[0], "release"); value = ""; }
    }
    return { status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const data = metadata();
  const published = { ...data.versions["4.0.0"], version: candidate.version, dist: { integrity: candidate.integrity } };
  const result = await invoke(t, f, "publish", { data: () => publishedAtBoundary
    ? { ...metadata(candidate.version), versions: { [candidate.version]: published } } : data, published,
    args: ["--artifact", directory, "--source-ref", f.ref, "--official-version", "9.8.7", "--fork-ref", forkRef],
    environment: { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_SHA: f.ref,
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/npm-release.yml@refs/heads/main`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-fixture", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
      GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", RUNNER_ENVIRONMENT: "github-hosted",
      GH_TOKEN: "github-fixture", NODE_AUTH_TOKEN: "ambient-fixture", NPM_TOKEN: "ambient-fixture",
      NPM_BOOTSTRAP_TOKEN: "ambient-fixture", AWS_SECRET_ACCESS_KEY: "ambient-fixture" } });
  assert.equal(result.failed, false, result.errors);
  assert.equal(calls.filter(({ command }) => command === "npm").length, 1);
  assert.ok(calls.some(({ args }) => args.includes("--draft=false")));
  assert.equal(existsSync(join(f.source, "published")), false);
  for (const { cwd } of calls) assert.equal(existsSync(cwd), false, "publish scratch must be cleaned");
});
