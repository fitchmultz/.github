import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkResources, probeCli } from "./cli-probe.mjs";
import { isolatedEnvironment, readJson, run, sha256, stageSource, writeJson } from "./common.mjs";
import { prepareHost } from "./hosts.mjs";

const registry = "https://registry.npmjs.org/";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: "string" }, repository: { type: "string" }, output: { type: "string" },
  fork: { type: "string" }, artifact: { type: "string" }, "source-ref": { type: "string" },
  help: { type: "boolean", short: "h" },
} });
const [command] = positionals;
const repository = values.repository ?? process.env.GITHUB_REPOSITORY;
const entry = readJson(new URL("../fleet.json", import.meta.url)).find((item) => `fitchmultz/${item.repo}` === repository);

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function versionParts(version) {
  // ponytail: only stable releases go to latest. Add an explicit prerelease/dist-tag policy before supporting prereleases.
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Automatic releases require a stable x.y.z version");
  const parts = version.split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Version components exceed the safe integer range");
  return parts;
}

function newer(candidate, latest) {
  const left = versionParts(candidate);
  const right = versionParts(latest);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function identity(manifest) {
  assert.ok(entry?.npmPackage && ["automatic", "approval"].includes(entry.npmRelease), "Repository has no enabled, owned npm release channel");
  assert.equal(manifest.name, entry.npmPackage, "Package name differs from the owned npm channel");
  assert.notEqual(manifest.private, true, "Private packages cannot be released");
  versionParts(manifest.version);
  const url = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  assert.equal(url?.replace(/^git\+/, "").replace(/\.git\/?$/, "").replace(/\/$/, ""), `https://github.com/${repository}`, "Package repository identity differs from its caller");
  const config = manifest.publishConfig ?? {};
  function inspect(object) {
    for (const [key, value] of Object.entries(object)) {
      assert.ok(!/auth|password|username|token|otp|certfile|keyfile/i.test(key), "Credential-shaped publishConfig is forbidden");
      if (value && typeof value === "object") inspect(value);
      if (/registry$/i.test(key)) assert.equal(value?.replace(/\/$/, ""), registry.replace(/\/$/, ""), "Only the public npm registry is allowed");
    }
  }
  inspect(config);
  assert.equal(config.tag ?? "latest", "latest", "Only the latest channel is automated");
  assert.ok(config.access === undefined || config.access === "public", "Only public publishing is allowed");
  assert.notEqual(config.provenance, false, "Automatic releases require npm provenance");
}

async function metadata(name) {
  const response = await fetch(`${registry}${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Owned npm package metadata: HTTP ${response.status}; new package creation is not automated`);
  const data = await response.json();
  assert.equal(data.name, name);
  assert.ok(data.maintainers?.some((maintainer) => maintainer.name === "fitchmultz"), "npm package is not maintained by fitchmultz");
  const latest = data.versions?.[data["dist-tags"]?.latest];
  assert.ok(latest, "npm latest metadata is missing");
  identity(latest);
  return data;
}

function sourceIdentity(source) {
  const manifest = readJson(join(source, "package.json"));
  identity(manifest);
  const ref = run("git", ["rev-parse", "HEAD"], { cwd: source, quiet: true }).trim();
  assert.match(ref, /^[a-f0-9]{40}$/);
  assert.equal(run("git", ["status", "--porcelain"], { cwd: source, quiet: true }).trim(), "", "Release source must be a clean commit");
  if (values["source-ref"]) assert.equal(ref, values["source-ref"], "Release source changed");
  return { manifest, ref };
}

function releaseNotes(source, version) {
  const lines = readFileSync(join(source, "CHANGELOG.md"), "utf8").split("\n");
  const heading = new RegExp(`^##\\s+\\[?v?${version.replaceAll(".", "\\.")}\\]?(?:\\s|$)`);
  const starts = lines.flatMap((line, index) => heading.test(line) ? [index] : []);
  assert.equal(starts.length, 1, `CHANGELOG.md needs one versioned section for ${version}, not just Unreleased`);
  const end = lines.findIndex((line, index) => index > starts[0] && /^##\s/.test(line));
  const notes = lines.slice(starts[0] + 1, end === -1 ? undefined : end).join("\n").trim();
  assert.ok(notes, "Release notes are empty");
  return notes;
}

function ownsRelease(release, ref, integrity) {
  return release.body?.includes(`<!-- pi-npm-release: ${ref} ${integrity} -->`) === true;
}

async function plan() {
  const source = resolve(values.source ?? ".");
  const { manifest, ref } = sourceIdentity(source);
  const data = await metadata(manifest.name);
  const existing = data.versions[manifest.version];
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  let release = !existing;
  if (existing) {
    // Drafts are visible through the list API only with push access, not releases/tags/TAG.
    for (let page = 1; ; page++) {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(30_000) });
      assert.ok(response.ok, `GitHub release lookup: HTTP ${response.status}`);
      const releases = await response.json();
      const draft = releases.find((item) => item.tag_name === `v${manifest.version}`);
      if (draft) {
        release = draft.draft === true && ownsRelease(draft, ref, existing.dist?.integrity);
        break;
      }
      if (releases.length < 100) break;
    }
  }
  if (release) {
    if (!existing) assert.ok(newer(manifest.version, data["dist-tags"].latest), "Refusing to move latest backwards; bump to a newer version");
    releaseNotes(source, manifest.version);
    const response = await fetch(`https://api.github.com/repos/${repository}/commits/${ref}/pulls`, { headers, signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `Merged release PR lookup: HTTP ${response.status}`);
    const pulls = await response.json();
    assert.ok(pulls.some((pull) => pull.merged_at && pull.base?.ref === "main" && pull.merge_commit_sha === ref), "Release candidate must come from a merged PR to main, not a direct push");
  }
  output({ release: String(release), source: ref, version: manifest.version });
  console.log(release ? `${manifest.name}@${manifest.version}: ${existing ? "unfinished GitHub release" : "unpublished candidate"} ${ref}`
    : `${manifest.name}@${manifest.version}: already published; source changes require a new version`);
}

async function prepare() {
  assert.ok(values.source && values.output && values.fork, "prepare requires --source, --output and --fork");
  const source = resolve(values.source);
  const destination = resolve(values.output);
  const { manifest, ref } = sourceIdentity(source);
  const notes = releaseNotes(source, manifest.version);
  mkdirSync(destination, { recursive: true });
  const root = mkdtempSync("/tmp/npm-release-");
  const env = isolatedEnvironment(root);
  try {
    const development = join(root, "development");
    stageSource(source, development);
    if (existsSync(join(development, ".npmrc"))) {
      assert.ok(!/auth|password|username|token|otp|certfile|keyfile/i.test(readFileSync(join(development, ".npmrc"), "utf8")), "Project npm configuration must not contain credentials");
    }
    run("npm", ["ci", "--ignore-scripts"], { cwd: development, env });
    run("npm", ["run", "build", "--if-present"], { cwd: development, env });
    run("git", ["diff", "--exit-code"], { cwd: development, env });
    const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: development, env, quiet: true }));
    assert.equal(packed.length, 1);
    assert.equal(packed[0].name, manifest.name);
    assert.equal(packed[0].version, manifest.version);
    const filename = packed[0].filename;
    assert.equal(basename(filename), filename);
    for (const file of packed[0].files) {
      assert.ok(!/(^|\/)(\.git|\.pi|\.env[^/]*|\.npmrc|\.artifacts|\.debug|\.dogfood|\.DS_Store)(\/|$)/.test(file.path), `Private/repository state in tarball: ${file.path}`);
    }
    const tarball = join(destination, filename);
    const hash = sha256(tarball);
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    assert.equal(integrity, packed[0].integrity);
    identity(JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], { env, quiet: true })));
    const hosts = {};
    for (const flavor of ["official", "fork"]) {
      const target = flavor === "official" ? manifest.devDependencies?.["@earendil-works/pi-coding-agent"] : resolve(values.fork);
      assert.ok(target, "Release must declare an exact official development baseline");
      const host = await prepareHost(join(root, flavor, "host"), flavor, target, env);
      const consumer = join(root, flavor, "consumer");
      mkdirSync(consumer, { recursive: true });
      writeJson(join(consumer, "package.json"), { private: true, dependencies: { [manifest.name]: `file:${tarball}` } });
      run("npm", ["install", "--omit=dev"], { cwd: consumer, env });
      const installed = join(consumer, "node_modules", manifest.name);
      identity(readJson(join(installed, "package.json")));
      assert.equal(readJson(join(installed, "package.json")).version, manifest.version);
      checkResources(installed);
      hosts[flavor] = { ...host, observation: probeCli(host, installed, join(root, flavor, "probe"), env) };
    }
    assert.equal(sha256(tarball), hash, "Release tarball changed during consumer verification");
    writeJson(join(destination, "release.json"), { repository, source: ref, name: manifest.name, version: manifest.version,
      approval: entry.npmRelease === "approval", filename, sha256: hash, integrity, notes, hosts });
    writeFileSync(join(destination, "release-notes.md"), `${notes}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## npm release candidate\n\n${manifest.name}@${manifest.version}\n\nCommit: \`${ref}\`\n\nTarball SHA-256: \`${hash}\`\n\nThe **same tarball** loaded through both official and fork bundled Pi CLIs.\n\n${entry.npmRelease === "approval" ? "Before approving the npm environment, download this candidate and satisfy the package's existing exact-commit/tarball release requirements. CI did not run authenticated/paid live checks or perform the maintainer release review.\n" : "This package publishes unattended after its offline checks and artifact verification pass.\n"}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function verifyArtifact(directory) {
  const candidate = readJson(join(directory, "release.json"));
  assert.equal(candidate.repository, repository);
  assert.equal(candidate.name, entry?.npmPackage);
  versionParts(candidate.version);
  assert.match(candidate.source, /^[a-f0-9]{40}$/);
  assert.equal(candidate.source, values["source-ref"], "Artifact came from a different source commit");
  assert.equal(candidate.approval, entry.npmRelease === "approval", "Artifact approval policy changed");
  assert.equal(basename(candidate.filename), candidate.filename);
  const tarball = join(directory, candidate.filename);
  assert.equal(sha256(tarball), candidate.sha256, "Release tarball checksum changed");
  assert.equal(`sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`, candidate.integrity, "Release tarball integrity changed");
  const manifest = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], { quiet: true }));
  identity(manifest);
  assert.equal(manifest.version, candidate.version);
  assert.equal(readFileSync(join(directory, "release-notes.md"), "utf8").trim(), candidate.notes);
  for (const flavor of ["official", "fork"]) assert.equal(candidate.hosts?.[flavor]?.flavor, flavor, `Missing ${flavor} artifact verification`);
  return candidate;
}

async function publish() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Publication only runs in GitHub Actions through OIDC");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Publication only runs from main");
  assert.equal(process.env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/npm-release.yml@refs/heads/main`, "Unexpected trusted publisher caller");
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && process.env.ACTIONS_ID_TOKEN_REQUEST_URL, "OIDC permission is missing");
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/, "Missing GitHub run identity");
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/, "Missing GitHub run attempt");
  assert.ok(values.artifact && values["source-ref"], "publish requires --artifact and --source-ref");
  const directory = resolve(values.artifact);
  const candidate = verifyArtifact(directory);
  assert.equal(process.env.GITHUB_SHA, candidate.source, "Caller commit differs from the verified artifact");
  const root = mkdtempSync("/tmp/npm-publish-");
  const env = isolatedEnvironment(root);
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("GITHUB_") || name.startsWith("ACTIONS_ID_TOKEN_REQUEST_")) env[name] = value;
  }
  const githubEnv = { ...env, GH_TOKEN: process.env.GH_TOKEN };
  const gh = (args, options = {}) => run("gh", args, { cwd: root, env: githubEnv, quiet: true, ...options });
  const api = (path, body) => JSON.parse(gh(["api", `repos/${repository}/${path}`, ...(body ? ["--method", "POST", "--input", "-"] : [])], body ? { input: JSON.stringify(body) } : {}));
  try {
    const environment = api("environments/npm");
    assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true, "npm environment must restrict publication to main");
    const branches = api("environments/npm/deployment-branch-policies").branch_policies;
    assert.deepEqual(branches.map(({ name, type }) => ({ name, type })), [{ name: "main", type: "branch" }], "npm environment permits an unexpected branch or tag");
    if (candidate.approval) {
      assert.ok(environment.protection_rules.some((rule) => rule.type === "required_reviewers" && rule.reviewers.some((reviewer) => reviewer.reviewer.login === "fitchmultz")), "Required maintainer release approval was removed");
    }
    const data = await metadata(candidate.name);
    const existing = data.versions[candidate.version];
    if (existing) assert.equal(existing.dist.integrity, candidate.integrity, "This version was published with different bytes; never overwrite it");
    else {
      assert.equal(api("commits/main").sha, candidate.source, "Main advanced while release checks/approval were pending; rerun on the current main commit");
      assert.ok(newer(candidate.version, data["dist-tags"].latest), "Refusing to move latest backwards");
    }
    const tag = `v${candidate.version}`;
    const releases = JSON.parse(gh(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"])).flat();
    let release = releases.find((item) => item.tag_name === tag);
    if (release) assert.ok(ownsRelease(release, candidate.source, candidate.integrity), "Existing GitHub release is not this exact automation candidate; leave it untouched");
    const refs = api(`git/matching-refs/tags/${tag}`);
    const ref = refs.find((item) => item.ref === `refs/tags/${tag}`);
    if (ref) {
      let object = ref.object;
      while (object.type === "tag") object = api(`git/tags/${object.sha}`).object;
      assert.equal(object.type, "commit");
      assert.equal(object.sha, candidate.source, "Existing release tag points to a different commit");
    } else {
      const object = api("git/tags", { tag, message: `${candidate.name} ${candidate.version}`, object: candidate.source, type: "commit" });
      api("git/refs", { ref: `refs/tags/${tag}`, sha: object.sha });
    }
    if (!release) {
      release = api("releases", { tag_name: tag, name: `${candidate.name} ${candidate.version}`, draft: true,
        body: `${candidate.notes}\n\n<!-- pi-npm-release: ${candidate.source} ${candidate.integrity} -->\n\n[Release verification](https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID})\n` });
    }
    const receipt = `verification-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`;
    cpSync(join(directory, "release.json"), join(root, receipt));
    for (const file of [candidate.filename, receipt]) {
      const path = file === receipt ? join(root, file) : join(directory, file);
      const asset = release.assets.find((item) => item.name === file);
      if (asset) {
        assert.equal(asset.digest, `sha256:${sha256(path)}`, `Existing GitHub release asset differs: ${file}`);
      } else {
        gh(["release", "upload", tag, path, "--repo", repository]);
      }
    }
    if (!existing) run("npm", ["publish", join(directory, candidate.filename), "--ignore-scripts", `--registry=${registry}`, "--access=public", "--tag=latest", "--provenance"], { cwd: root, env });
    const response = await fetch(`${registry}${encodeURIComponent(candidate.name)}/${candidate.version}`, { signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `Published exact-version verification: HTTP ${response.status}; retain the candidate and retry, never unpublish`);
    const published = await response.json();
    identity(published);
    assert.equal(published.version, candidate.version);
    assert.equal(published.dist.integrity, candidate.integrity, "Published bytes differ from the verified tarball");
    const latest = await metadata(candidate.name);
    assert.ok(latest["dist-tags"].latest === candidate.version || newer(latest["dist-tags"].latest, candidate.version), "npm latest did not advance to the release");
    if (release.draft) gh(["release", "edit", tag, "--repo", repository, "--draft=false"]);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Released\n\n[${candidate.name}@${candidate.version}](https://www.npmjs.com/package/${candidate.name}/v/${candidate.version}) — [GitHub release](https://github.com/${repository}/releases/tag/${tag})\n\nExact registry integrity matches the tested tarball.\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  if (values.help) {
    console.log(`Usage: node scripts/npm-release.mjs <plan|prepare|verify|publish> [options]\n\nOptions:\n  --repository OWNER/REPO  Owned channel (defaults to GITHUB_REPOSITORY)\n  --source PATH            Clean source checkout for plan/prepare\n  --source-ref SHA          Expected immutable commit; required by verify/publish\n  --fork PATH               Verified fork host artifact directory for prepare\n  --output PATH             Candidate artifact directory for prepare\n  --artifact PATH           Candidate artifact directory for verify/publish\n  -h, --help                Show this help\n\nExamples:\n  node scripts/npm-release.mjs plan --repository fitchmultz/pi-copy-message --source ../extension\n  node scripts/npm-release.mjs prepare --repository fitchmultz/pi-copy-message --source ../extension --source-ref COMMIT --fork /tmp/fork-package --output /tmp/candidate\n  node scripts/npm-release.mjs verify --repository fitchmultz/pi-copy-message --source-ref COMMIT --artifact /tmp/candidate\n\nplan is read-only; prepare builds/tests without credentials. publish is GitHub/OIDC-only and creates npm/GitHub releases.\nExit codes: 0 = success (including already-published plan), 1 = invalid input, failed gate, or release failure.`);
  } else {
    assert.equal(positionals.length, 1, "Choose plan, prepare, verify, or publish; use --help");
    assert.ok(entry?.npmRelease, "Repository has no enabled npm release channel");
    if (command === "plan") await plan();
    else if (command === "prepare") await prepare();
    else if (command === "verify") { assert.ok(values.artifact && values["source-ref"], "verify requires --artifact and --source-ref"); verifyArtifact(resolve(values.artifact)); }
    else if (command === "publish") await publish();
    else throw new Error("Unknown command; use --help");
  }
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
