import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function fixture(t, version = "4.0.1", changelog = `## ${version} - 2026-10-04\n\nFix copying a selected message.\n\n## 4.0.0\n\nEarlier release.\n`, repo = repository, packageName = name) {
  const root = mkdtempSync("/tmp/npm-release-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  writeJson(join(source, "package.json"), { name: packageName, version, repository: { type: "git", url: `git+https://github.com/${repo}.git` },
    scripts: { prepublishOnly: `node -e 'require("fs").writeFileSync("published", "unexpected")'` } });
  writeFileSync(join(source, "CHANGELOG.md"), changelog);
  exec("git", ["init", "--quiet", "--initial-branch=main"], source);
  exec("git", ["config", "user.name", "Release test"], source);
  exec("git", ["config", "user.email", "release-test@example.invalid"], source);
  exec("git", ["add", "."], source);
  exec("git", ["commit", "--quiet", "-m", "Release fixture"], source);
  const ref = exec("git", ["rev-parse", "HEAD"], source);
  return { root, source, ref, repository: repo, name: packageName, version, output: join(root, "output") };
}

function metadata(latest = "4.0.0") {
  return { name, maintainers: [{ name: "fitchmultz" }], "dist-tags": { latest },
    versions: { [latest]: { name, version: latest, repository: { type: "git", url: repositoryUrl } } } };
}

// Execute the real CLI entry point, including Git cleanliness, HTTP response handling and workflow outputs.
// HTTP and publication subprocess boundaries are replaced; this is not real host/OIDC qualification.
async function invoke(t, fixture, command, { data = metadata(), pulls, draft, releasePages, releaseStatus = 200, status = 200, args = [], environment = {}, published, publishedStatus = 200 } = {}) {
  const { repository, name } = fixture;
  const argv = process.argv;
  const exitCode = process.exitCode;
  const env = { GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: fixture.output, GH_TOKEN: undefined,
    GITHUB_ACTIONS: undefined, GITHUB_REF: undefined, GITHUB_WORKFLOW_REF: undefined,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined, ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
    GITHUB_RUN_ID: undefined, GITHUB_RUN_ATTEMPT: undefined, NPM_BOOTSTRAP_TOKEN: undefined,
    NODE_AUTH_TOKEN: undefined, NPM_TOKEN: undefined, ...environment };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const requests = [];
  const errors = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    if (String(url) === `https://registry.npmjs.org/${encodeURIComponent(name)}`) return Response.json(typeof data === "function" ? data() : data, { status: typeof status === "function" ? status() : status });
    if (String(url) === `https://registry.npmjs.org/${encodeURIComponent(name)}/${fixture.version}`) return Response.json(typeof published === "function" ? published() : published, { status: typeof publishedStatus === "function" ? publishedStatus() : publishedStatus });
    if (String(url) === `https://registry.npmjs.org/${encodeURIComponent(codingAgent)}/latest`) {
      return Response.json({ name: codingAgent, version: "9.8.7", dist: { integrity: "sha512-host-fixture", tarball: "https://registry.npmjs.org/host-fixture.tgz" } });
    }
    if (String(url) === "https://api.github.com/repos/fitchmultz/pi/commits/main") return Response.json({ sha: forkRef });
    if (String(url) === `https://api.github.com/repos/${repository}/releases/tags/v${data?.["dist-tags"]?.latest}`) {
      return draft?.draft === false ? Response.json(draft) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (String(url).startsWith(`https://api.github.com/repos/${repository}/releases?per_page=100&page=`)) {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json(releasePages?.[page - 1] ?? (draft ? [{ ...draft, tag_name: `v${data["dist-tags"].latest}` }] : []), { status: releaseStatus });
    }
    assert.equal(String(url), `https://api.github.com/repos/${repository}/commits/${fixture.ref}/pulls`);
    return Response.json(pulls ?? [{ merged_at: "2026-10-04T12:00:00Z", base: { ref: "main" }, merge_commit_sha: fixture.ref }]);
  });
  const logs = [];
  const log = t.mock.method(console, "log", (value) => logs.push(String(value)));
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
    return { errors: errors.join("\n"), failed: process.exitCode === 1, requests, outputs, logs };
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
  const candidate = { repository: f.repository, source: f.ref, name: f.name, version: f.version, approval: false, filename: packed.filename,
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

test("each enabled owned scoped channel can plan its real first patch without inventing a previous latest", async (t) => {
  for (const [repo, version] of [["pi-subagents", "0.44.4"], ["pi-calculator", "4.1.1"],
    ["pi-ask-question", "0.5.1"], ["pi-workflows", "0.2.1"], ["pi-verbosity-control", "0.6.1"]]) {
    const f = fixture(t, version, undefined, `fitchmultz/${repo}`, `@fitchmultz/${repo}`);
    const result = await invoke(t, f, "plan", { status: 404, data: null, args: ["--source-ref", f.ref] });
    assert.equal(result.failed, false, result.errors);
    assert.deepEqual(result.outputs, { release: "true", source: f.ref, version,
      "official-version": "9.8.7", "fork-ref": forkRef });
    assert.equal(existsSync(join(f.source, "published")), false);
    assert.equal(exec("git", ["status", "--porcelain"], f.source), "");
  }
});

test("first-publication absence never relaxes namespace, registry, merged-source or notes guards", async (t) => {
  for (const kind of ["unscoped", "namespace", "repository", "private", "prerelease", "direct", "notes", 401, 403, 429, 503]) {
    const repo = kind === "unscoped" ? repository : "fitchmultz/pi-calculator";
    const packageName = kind === "unscoped" ? name : kind === "namespace" ? "@someone-else/pi-calculator" : "@fitchmultz/pi-calculator";
    const f = fixture(t, kind === "prerelease" ? "4.1.1-beta.1" : "4.1.1",
      kind === "notes" ? "## Unreleased\n\nPending.\n" : undefined, repo, packageName);
    if (kind === "repository" || kind === "private") {
      const manifest = JSON.parse(readFileSync(join(f.source, "package.json")));
      if (kind === "private") manifest.private = true;
      else manifest.repository.url = "git+https://github.com/other/pi-calculator.git";
      writeJson(join(f.source, "package.json"), manifest);
      exec("git", ["add", "."], f.source);
      exec("git", ["commit", "--quiet", "-m", "Invalid identity"], f.source);
      f.ref = exec("git", ["rev-parse", "HEAD"], f.source);
    }
    const result = await invoke(t, f, "plan", { status: typeof kind === "number" ? kind : 404, data: null,
      pulls: kind === "direct" ? [] : undefined });
    const reasons = { unscoped: /HTTP 404/, namespace: /Package name differs/, repository: /repository identity/,
      private: /Private packages/, prerelease: /stable x.y.z/, direct: /merged PR to main/, notes: /versioned section/ };
    refused(result, typeof kind === "number" ? new RegExp(`HTTP ${kind}`) : reasons[kind]);
  }
});

function publicationFixture(t, existing = false) {
  const f = existing ? fixture(t) : fixture(t, "4.1.1", undefined, "fitchmultz/pi-calculator", "@fitchmultz/pi-calculator");
  const { directory, candidate } = artifact(f);
  f.directory = directory;
  f.candidate = candidate;
  // This transport receipt exercises publish admission, not real host qualification or registry/OIDC success.
  writeJson(join(f.directory, "release.json"), f.candidate);
  writeFileSync(join(f.directory, "release-notes.md"), `${f.candidate.notes}\n`);
  f.environment = { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${f.repository}/.github/workflows/npm-release.yml@refs/heads/main`,
    GITHUB_SHA: f.ref, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", RUNNER_ENVIRONMENT: "github-hosted",
    GH_TOKEN: "github-fixture", AWS_SECRET_ACCESS_KEY: "ambient-fixture" };
  f.args = ["--artifact", f.directory, "--source-ref", f.ref, "--official-version", "9.8.7", "--fork-ref", forkRef];
  f.published = { name: f.name, version: f.version, repository: { url: `git+https://github.com/${f.repository}.git` },
    dist: { integrity: f.candidate.integrity } };
  f.metadata = (latest = f.version) => ({ name: f.name, maintainers: [{ name: "fitchmultz" }],
    "dist-tags": { latest }, versions: { [latest]: { ...f.published, version: latest } } });
  return f;
}

function publicationBoundary(t, f, { guard, bootstrap = false, recovery = false } = {}) {
  const calls = [];
  let published = recovery;
  const nativeSpawnSync = childProcess.spawnSync;
  const mock = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    if (command === "tar") {
      const env = options.env ?? process.env;
      assert.equal(env.NPM_BOOTSTRAP_TOKEN, undefined, "artifact inspection must not inherit bootstrap credentials");
      assert.equal(env.NODE_AUTH_TOKEN, undefined);
      assert.equal(env.NPM_TOKEN, undefined);
      assert.equal(env.RUNNER_ENVIRONMENT, undefined, "runner context must not reach artifact inspection");
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    }
    if (command !== "gh" && command !== "npm") return nativeSpawnSync(command, args, options);
    calls.push({ command, args, cwd: options.cwd });
    assert.equal(options.env.NPM_BOOTSTRAP_TOKEN, undefined, "bootstrap parent variable must never be inherited");
    assert.equal(options.env.NPM_TOKEN, undefined, "ambient credentials must never be inherited");
    assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(readFileSync(options.env.npm_config_globalconfig, "utf8"), "");
    let value;
    if (command === "npm") {
      const config = readFileSync(options.env.npm_config_userconfig, "utf8");
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.NODE_AUTH_TOKEN, bootstrap ? "bootstrap-fixture" : undefined);
      assert.equal(config, bootstrap ? "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n" : "");
      if (bootstrap) assert.equal(statSync(options.env.npm_config_userconfig).mode & 0o777, 0o600);
      assert.equal(args.join(" ").includes("bootstrap-fixture"), false);
      assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "fixture");
      if (args[0] === "whoami") {
        assert.equal(options.env.RUNNER_ENVIRONMENT, undefined, "runner context is only needed by final publish");
        assert.deepEqual(args, ["whoami", "--registry=https://registry.npmjs.org/"]);
        value = guard === "account" ? "other-user\n" : "fitchmultz\n";
      } else {
        assert.equal(options.env.RUNNER_ENVIRONMENT, "github-hosted");
        assert.deepEqual(args, ["publish", join(f.directory, f.candidate.filename), "--ignore-scripts",
          "--registry=https://registry.npmjs.org/", "--access=public", "--tag=latest", "--provenance"]);
        published = true;
        value = "";
      }
    } else {
      assert.equal(options.env.NODE_AUTH_TOKEN, undefined, "GitHub subprocess must never receive npm credentials");
      assert.equal(options.env.RUNNER_ENVIRONMENT, undefined, "runner context must not reach GitHub subprocesses");
      assert.equal(options.env.GH_TOKEN, "github-fixture");
      assert.equal(readFileSync(options.env.npm_config_userconfig, "utf8"), "");
      const path = args[1]?.replace(`repos/${f.repository}/`, "");
      if (path === "environments/npm") value = { deployment_branch_policy: { custom_branch_policies: guard !== "environment" } };
      else if (path === "environments/npm/deployment-branch-policies") value = { branch_policies: [{ name: "main", type: "branch" }] };
      else if (path === "commits/main") value = { sha: guard === "main" ? "a".repeat(40) : f.ref };
      else if (path === "releases?per_page=100") value = recovery || guard === "release"
        ? [[{ tag_name: `v${f.version}`, draft: true, assets: [],
          body: guard === "release" ? "Unrelated" : `<!-- pi-npm-release: ${f.ref} ${f.candidate.integrity} -->` }]] : [[]];
      else if (path === `git/matching-refs/tags/v${f.version}`) value = guard === "tag" || recovery
        ? [{ ref: `refs/tags/v${f.version}`, object: { type: "commit", sha: guard === "tag" ? "a".repeat(40) : f.ref } }] : [];
      else if (path === "git/tags") value = { sha: "c".repeat(40) };
      else if (path === "git/refs") value = {};
      else if (path === "releases") value = { draft: true, assets: [] };
      else { assert.equal(args[0], "release"); value = ""; }
    }
    return { status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return { calls, get published() { return published; } };
}

test("bootstrap auth is admitted only after all guards and before any GitHub release writes", async (t) => {
  for (const guard of ["missing-token", "environment", "main", "release", "tag", "account"]) {
    await t.test(guard, async (t) => {
      const f = publicationFixture(t);
      const boundary = publicationBoundary(t, f, { guard, bootstrap: true });
      const result = await invoke(t, f, "publish", { status: 404, data: null, args: f.args,
        environment: { ...f.environment, ...(guard === "missing-token" ? {} : { NPM_BOOTSTRAP_TOKEN: "bootstrap-fixture" }) } });
      const reasons = { "missing-token": /NPM_BOOTSTRAP_TOKEN/, environment: /restrict publication/,
        main: /Main advanced/, release: /Existing GitHub release/, tag: /different commit/, account: /bootstrap.*fitchmultz/i };
      refused(result, reasons[guard]);
      assert.equal(boundary.calls.some(({ command, args }) => command === "gh" && (args.includes("POST") || args[0] === "release")), false);
      assert.equal(boundary.calls.some(({ command, args }) => command === "npm" && args[0] === "publish"), false);
      for (const { cwd } of boundary.calls) assert.equal(existsSync(cwd), false, "private publish root must be cleaned");
    });
  }
});

test("first-publication npm child alone gets bootstrap auth; a package appearing since plan uses OIDC only", async (t) => {
  for (const mode of ["existing", "bootstrap", "later", "recovery", "foreign", "integrity"]) {
    await t.test(mode, async (t) => {
      const f = publicationFixture(t, mode === "existing");
      if (mode === "later") {
        const plan = await invoke(t, f, "plan", { status: 404, data: null });
        assert.equal(plan.failed, false, plan.errors);
        assert.equal(plan.outputs.release, "true");
        rmSync(f.output);
      }
      const boundary = publicationBoundary(t, f, { bootstrap: mode === "bootstrap", recovery: mode === "recovery" });
      const initial = f.metadata(mode === "existing" ? "4.0.0" : mode === "later" ? "4.1.0" : f.version);
      if (mode === "foreign") initial.maintainers = [{ name: "someone-else" }];
      if (mode === "integrity") initial.versions[f.version].dist = { integrity: "sha512-other" };
      const result = await invoke(t, f, "publish", { args: f.args,
        environment: { ...f.environment, NPM_BOOTSTRAP_TOKEN: "bootstrap-fixture",
          NODE_AUTH_TOKEN: "ambient-untrusted", NPM_TOKEN: "ambient-untrusted" },
        status: () => mode === "bootstrap" && !boundary.published ? 404 : 200,
        data: () => boundary.published ? f.metadata() : initial, published: f.published });
      if (mode === "foreign" || mode === "integrity") {
        refused(result, mode === "foreign" ? /not maintained/ : /different bytes/);
        assert.equal(boundary.calls.some(({ command, args }) => command === "gh" && (args.includes("POST") || args[0] === "release")), false);
      } else {
        assert.equal(result.failed, false, result.errors);
        assert.equal(boundary.calls.filter(({ command, args }) => command === "npm" && args[0] === "whoami").length, mode === "bootstrap" ? 1 : 0);
        assert.equal(boundary.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish").length, mode === "recovery" ? 0 : 1);
        assert.ok(boundary.calls.some(({ command, args }) => command === "gh" && args.includes("--draft=false")));
      }
      assert.equal(existsSync(join(f.source, "published")), false, "lifecycle hooks remain disabled");
      for (const { cwd } of boundary.calls) assert.equal(existsSync(cwd), false);
    });
  }
});

test("successful publication and exact-source recovery wait for several-minute registry propagation without republishing", async (t) => {
  for (const mode of ["bootstrap", "existing", "recovery", "metadata-only"]) {
    await t.test(mode, async (t) => {
      const f = publicationFixture(t, mode !== "bootstrap");
      const boundary = publicationBoundary(t, f, { bootstrap: mode === "bootstrap", recovery: mode === "recovery" });
      let elapsed = 0;
      t.mock.method(Date, "now", () => elapsed);
      t.mock.method(globalThis, "setTimeout", (callback, delay) => { elapsed += delay; callback(); });
      const initial = f.metadata(mode === "recovery" ? f.version : "4.0.0");
      let packageRequests = 0;
      const result = await invoke(t, f, "publish", { args: f.args,
        environment: { ...f.environment, NPM_BOOTSTRAP_TOKEN: "bootstrap-fixture" },
        published: f.published, publishedStatus: () => mode !== "metadata-only" && elapsed < 370_000 ? 404 : 200,
        status: () => mode === "bootstrap" && (!boundary.published || elapsed < 380_000) ? 404 : 200,
        data: () => ++packageRequests === 1 ? initial : elapsed < 380_000 ? f.metadata("4.0.0")
          : elapsed < 390_000 ? { ...f.metadata("4.0.0"), "dist-tags": {} }
          : elapsed < 400_000 ? { ...f.metadata("4.0.0"), versions: { ...f.metadata("4.0.0").versions, [f.version]: f.published } }
            : f.metadata() });
      assert.equal(result.failed, false, result.errors);
      assert.ok(elapsed >= 400_000 && elapsed <= 420_000, `registry became visible after ${elapsed}ms`);
      if (mode === "metadata-only") assert.ok(result.logs.some((line) => line.includes("latest=4.0.0")), "wait logs identify a stale latest tag");
      assert.equal(boundary.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish").length, mode === "recovery" ? 0 : 1);
      assert.equal(boundary.calls.filter(({ command, args }) => command === "gh" && args.includes("--draft=false")).length, 1);
      assert.equal(existsSync(join(f.source, "published")), false);
      for (const { cwd } of boundary.calls) assert.equal(existsSync(cwd), false);
    });
  }
});

test("post-publication verification fails closed on HTTP, identity, integrity and shared visibility expiry", async (t) => {
  for (const kind of ["exact-403", "metadata-503", "network", "identity", "maintainer", "exact-integrity", "metadata-integrity", "exact-expiry", "metadata-expiry"]) {
    await t.test(kind, async (t) => {
      const f = publicationFixture(t, true);
      const boundary = publicationBoundary(t, f);
      let elapsed = 0;
      t.mock.method(Date, "now", () => elapsed);
      t.mock.method(globalThis, "setTimeout", (callback, delay) => { elapsed += delay; callback(); });
      let exactRequests = 0;
      let packageRequests = 0;
      const result = await invoke(t, f, "publish", { args: f.args, environment: f.environment,
        published: () => {
          exactRequests++;
          if (kind === "network") throw new TypeError("fixture network failure");
          if (kind === "identity") return { ...f.published, repository: { url: "https://github.com/other/package" } };
          if (kind === "exact-integrity") return { ...f.published, dist: { integrity: "sha512-other" } };
          return f.published;
        },
        publishedStatus: () => kind === "exact-403" ? 403
          : kind === "exact-expiry" || kind === "metadata-expiry" && elapsed < 370_000 ? 404 : 200,
        status: () => boundary.published && kind === "metadata-503" ? 503 : 200,
        data: () => {
          packageRequests++;
          if (!boundary.published || kind === "metadata-expiry") return f.metadata("4.0.0");
          const data = f.metadata();
          if (kind === "maintainer") data.maintainers = [{ name: "someone-else" }];
          if (kind === "metadata-integrity") data.versions[f.version].dist = { integrity: "sha512-other" };
          return data;
        } });
      const reasons = { "exact-403": /HTTP 403/, "metadata-503": /HTTP 503/, network: /fixture network failure/,
        identity: /repository identity/, maintainer: /not maintained/, "exact-integrity": /Published bytes differ/,
        "metadata-integrity": /Published bytes differ/, "exact-expiry": /visibility timed out/,
        "metadata-expiry": /visibility timed out/ };
      refused(result, reasons[kind]);
      if (kind.endsWith("expiry")) {
        assert.ok(elapsed >= 400_000 && elapsed <= 420_000, `one shared deadline expired at ${elapsed}ms`);
        assert.match(result.logs.at(-1), kind === "exact-expiry" ? /exact version HTTP 404/ : /package version entry missing/);
      } else {
        assert.equal(elapsed, 0, "permanent failures must not be retried");
        assert.equal(exactRequests, 1);
        assert.equal(packageRequests, ["metadata-503", "maintainer", "metadata-integrity"].includes(kind) ? 2 : 1);
      }
      assert.equal(boundary.calls.filter(({ command, args }) => command === "npm" && args[0] === "publish").length, 1);
      assert.equal(boundary.calls.some(({ args }) => args.includes("--draft=false")), false);
      for (const { cwd } of boundary.calls) assert.equal(existsSync(cwd), false);
    });
  }
});
