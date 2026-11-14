import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { isolatedEnvironment, readJson, run, stageSource } from "./common.mjs";
import { prepareHost } from "./hosts.mjs";
import { buildPackage, changelogFragment, packageDifference, packPackage, publishedTarball } from "./npm-package.mjs";
import { identity, markedSource, newer, registry, sourceMarker, versionParts } from "./npm-release-core.mjs";
import { releaseFetch } from "./release-fetch.mjs";

const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const releaseSubject = /^chore\(release\): \S+(?: \(#\d+\))?(?:\r?\n|$)/;
const pendingStart = "<!-- npm-release:unreleased:start -->";
const pendingEnd = "<!-- npm-release:unreleased:end -->";
const carriedStart = "<!-- npm-release:carried:start -->";
const carriedEnd = "<!-- npm-release:carried:end -->";
const supersessionMarker = ({ version, source }) => `<!-- pi-npm-supersedes: ${version} ${source} -->`;
const versionFiles = ["package.json", "package-lock.json", "CHANGELOG.md"];

function nextVersion(manifestVersion, publishedVersions, tags) {
  const versions = [manifestVersion, ...publishedVersions, ...tags.map((tag) => tag.replace(/^v/, ""))].filter((version) => stable.test(version));
  assert.ok(versions.length, "No stable version available");
  const latest = versions.reduce((a, b) => newer(b, a) ? b : a);
  const [major, minor, patch] = versionParts(latest);
  assert.ok(Number.isSafeInteger(patch + 1), "Version components exceed the safe integer range");
  return `${major}.${minor}.${patch + 1}`;
}

// Note content nests under its version heading; a level-2 heading would end the version section.
function nestHeading(text) {
  return text.trim().replace(/^##[ \t]+/gm, "### ");
}

function nestNotes(generated) {
  const notes = nestHeading(generated);
  assert.ok(notes, "Generated release notes are empty");
  return notes;
}

function sortPaths(paths) {
  return [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function treeFragments(source, ref) {
  const listed = spawnSync("git", ["ls-tree", "-z", ref, "--", "changelog.d/"], { cwd: source, encoding: "utf8" });
  if (listed.error) throw listed.error;
  assert.equal(listed.status, 0, `Could not inspect changelog.d at ${ref}`);
  const paths = sortPaths(listed.stdout.split("\0").filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf("\t");
    if (tab < 0) return [];
    const [mode, type] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    return type === "blob" && mode !== "120000" && changelogFragment(path) ? [path] : [];
  }));
  const notes = paths.map((path) => nestHeading(git(source, ["show", `${ref}:${path}`]))).filter(Boolean);
  return { paths, notes };
}

function changelogSection(text, heading) {
  const matches = [...text.matchAll(heading)];
  assert.ok(matches.length <= 1, "Expected at most one matching changelog section");
  if (!matches.length) return null;
  const start = matches[0].index;
  const headerEnd = start + matches[0][0].length;
  const next = /^##[ \t]+/m.exec(text.slice(headerEnd));
  const end = next ? headerEnd + next.index : text.length;
  return { start, end, heading: matches[0][0], body: text.slice(headerEnd, end).trim() };
}

function versionHeadingPattern(version) {
  return new RegExp(`^##[ \\t]+\\[?v?${version.replaceAll(".", "\\.")}\\]?(?:[ \\t].*)?\\r?$`, "gm");
}

function noteBlock(release, startMarker = pendingStart, endMarker = pendingEnd) {
  const start = release.indexOf(startMarker);
  const end = release.indexOf(endMarker);
  assert.ok(start >= 0 && end > start && release.indexOf(startMarker, start + startMarker.length) < 0
    && release.indexOf(endMarker, end + endMarker.length) < 0, "The reviewed version's note markers are missing or ambiguous");
  return { start, end, body: release.slice(start + startMarker.length, end).trim() };
}

function versionChangelog(changelog, version, generated, date, supersededVersion, fragmentNotes = []) {
  versionParts(version);
  const notes = nestNotes(generated);
  let carried = "";
  if (supersededVersion) {
    const section = changelogSection(changelog, versionHeadingPattern(supersededVersion));
    assert.ok(section, "The superseded version changelog section is missing");
    const previous = section.body.includes(carriedStart) || section.body.includes(carriedEnd)
      ? noteBlock(section.body, carriedStart, carriedEnd).body : "";
    carried = [previous, noteBlock(section.body).body].filter(Boolean).join("\n\n");
  }
  const releaseNotes = [carried ? `${carriedStart}\n${carried}\n${carriedEnd}` : "", notes].filter(Boolean).join("\n\n");
  const unreleased = /^##[ \t]+\[?Unreleased\]?(?:[ \t].*)?\r?$/im.exec(changelog);
  if (unreleased) {
    const start = unreleased.index + unreleased[0].length;
    const next = /^##[ \t]+/m.exec(changelog.slice(start));
    const end = next ? start + next.index : changelog.length;
    const pending = [changelog.slice(start, end).trim(), ...fragmentNotes].filter(Boolean).join("\n\n");
    const body = `${pendingStart}\n${pending ? `${pending}\n` : ""}${pendingEnd}\n\n${releaseNotes}`;
    return `${changelog.slice(0, start)}\n\n## ${version} - ${date}\n\n${body}\n\n${changelog.slice(end)}`;
  }
  const pending = fragmentNotes.filter(Boolean).join("\n\n");
  const heading = /^##[ \t]+/m.exec(changelog);
  const position = heading?.index ?? changelog.length;
  const prefix = changelog.slice(0, position).trimEnd();
  return `${prefix}\n\n## ${version} - ${date}\n\n${pendingStart}\n${pending ? `${pending}\n` : ""}${pendingEnd}\n\n${releaseNotes}\n\n${changelog.slice(position)}`;
}

function setVersion(source, version) {
  const root = mkdtempSync(join(tmpdir(), "npm-version-"));
  try {
    const env = isolatedEnvironment(root);
    run("npm", ["version", version, "--no-git-tag-version", "--ignore-scripts", "--allow-same-version"], { cwd: source, env });
    const manifest = readJson(join(source, "package.json"));
    assert.equal(manifest.version, version);
    const lock = readJson(join(source, "package-lock.json"));
    assert.equal(lock.version, version, "npm did not update the lockfile version");
    assert.equal(lock.packages?.[""]?.version, version, "npm did not update the lockfile root version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stageVersion(source, version, notes, date, supersededVersion, fragmentNotes = []) {
  setVersion(source, version);
  const path = join(source, "CHANGELOG.md");
  writeFileSync(path, versionChangelog(readFileSync(path, "utf8"), version, notes, date, supersededVersion, fragmentNotes));
}

function formatVersion(source) {
  if (!readJson(join(source, "package.json")).scripts?.format) return;
  const root = mkdtempSync(join(tmpdir(), "npm-version-format-"));
  try {
    const env = isolatedEnvironment(root);
    const staged = join(root, "source");
    stageSource(source, staged);
    run("npm", ["ci", "--ignore-scripts"], { cwd: staged, env });
    run("npm", ["run", "format"], { cwd: staged, env });
    for (const file of versionFiles) {
      copyFileSync(join(staged, file), join(source, file));
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 1000 });
  }
}

export function history(source, ref = "HEAD") {
  const fields = run("git", ["log", "--first-parent", "--format=%H%x00%B%x00", ref], { cwd: source, quiet: true }).split("\0");
  const commits = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = fields[index].trim();
    if (sha) commits.push({ sha, message: fields[index + 1] });
  }
  return commits;
}

async function isVersionCommit(commit, parent, inspectCommit, source) {
  const marked = markedSource(commit.message);
  if (!marked || !releaseSubject.test(commit.message)) return null;
  if (source && parent && !versionOnly(source, parent, commit.sha)) return null;
  const details = await inspectCommit(commit.sha);
  if (details?.sha === commit.sha && details.author?.type === "Bot" && details.commit?.verification?.verified === true) {
    return { ...commit, source: marked };
  }
  return null;
}

export async function versionCommit(commits, inspectCommit, source) {
  for (let index = 0; index < commits.length; index++) {
    const found = await isVersionCommit(commits[index], commits[index + 1]?.sha, inspectCommit, source);
    if (found) return found;
  }
  return null;
}

function git(source, args, options = {}) {
  return run("git", args, { cwd: source, quiet: true, ...options }).trim();
}

function isAncestor(source, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: source, stdio: "ignore" });
  if (result.error) throw result.error;
  assert.ok(result.status === 0 || result.status === 1, "Could not compare source ancestry");
  return result.status === 0;
}

// True when two commits differ only in the version metadata a release commit writes, so a release would change nothing.
function versionOnly(source, from, to) {
  return git(source, ["diff", "--name-only", from, to]).split("\n").filter(Boolean).every((file) => {
    if (file === "CHANGELOG.md" || changelogFragment(file)) return true;
    if (file !== "package.json" && file !== "package-lock.json") return false;
    const unversioned = (commit) => {
      const exists = spawnSync("git", ["cat-file", "-e", `${commit}:${file}`], { cwd: source, stdio: "ignore" });
      if (exists.status !== 0) return null;
      const manifest = JSON.parse(git(source, ["show", `${commit}:${file}`]));
      delete manifest.version;
      if (manifest.packages?.[""]) delete manifest.packages[""].version;
      return manifest;
    };
    const before = unversioned(from);
    return before !== null && isDeepStrictEqual(before, unversioned(to));
  });
}

// True when release preparation would build from `main` the package already published as `published`, one
// version's registry metadata. Only that proof skips a release: a build or comparison that cannot finish is
// reported and counts as a change.
async function buildsPublishedPackage(source, main, published) {
  const root = mkdtempSync(join(tmpdir(), "npm-version-package-"));
  try {
    const env = isolatedEnvironment(root);
    const tarball = await publishedTarball(published, root);
    git(source, ["switch", "--force", "--detach", main]);
    assert.equal(git(source, ["status", "--porcelain"]), "", "The main checkout has uncommitted files");
    const development = join(root, "development");
    buildPackage(source, development, await prepareHost(join(root, "host"), "official", "latest", env), env);
    const candidate = join(root, packPackage(development, root, env).filename);
    const difference = packageDifference(candidate, tarball, join(root, "packed"), env);
    if (difference) console.log(`Main changes the published ${published.name}@${published.version}: ${difference}`);
    return !difference;
  } catch (error) {
    console.log(`Could not compare main with the published package, so it is released as a change: ${error.stack ?? error}`);
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 1000 });
  }
}

export async function request(path, { method = "GET", body, token = process.env.RELEASE_GH_TOKEN, paginate = false } = {}) {
  assert.ok(token, "GitHub token is missing");
  let url = path.startsWith("https://") ? path : `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`;
  const pages = [];
  do {
    const response = await releaseFetch("GitHub", url, { method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `GitHub ${method} ${new URL(url).origin}${new URL(url).pathname}: HTTP ${response.status}`);
    const text = await response.text();
    if (text) pages.push(JSON.parse(text));
    url = paginate ? /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] : undefined;
  } while (url);
  return paginate ? pages.flat() : pages[0];
}

async function fastForwardMain(sha, token = process.env.RELEASE_GH_TOKEN) {
  assert.ok(token, "GitHub token is missing");
  const url = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/git/refs/heads/main`;
  const response = await releaseFetch("GitHub", url, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sha, force: false }),
  });
  if (response.status === 422) return false;
  assert.ok(response.ok, `GitHub PATCH ${new URL(url).origin}${new URL(url).pathname}: HTTP ${response.status}`);
  return true;
}

async function npmMetadata(entry, repository) {
  const response = await releaseFetch("npm", `${registry}${encodeURIComponent(entry.npmPackage)}`);
  assert.ok(response.ok, `Owned npm package metadata: HTTP ${response.status}`);
  const data = await response.json();
  assert.equal(data.name, entry.npmPackage);
  assert.ok(data.maintainers?.some((maintainer) => maintainer.name === "fitchmultz"), "npm package is not maintained by fitchmultz");
  const latest = data.versions?.[data["dist-tags"]?.latest];
  assert.ok(latest, "npm latest metadata is missing");
  identity(entry, repository, latest);
  return data;
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function rerunRelease(sha, main, draft) {
  if (!["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME)) return;
  const token = process.env.GH_TOKEN;
  const runs = await request(`actions/workflows/npm-release.yml/runs?head_sha=${sha}&per_page=1`, { token });
  const run = runs.workflow_runs.find((item) => item.head_sha === sha);
  if (!run) {
    assert.ok(!draft || sha === main, `No original release run remains for draft ${sha}; a main dispatch cannot reproduce its provenance`);
    await request("actions/workflows/npm-release.yml/dispatches", { method: "POST", body: { ref: "main" }, token });
    console.log(`Dispatched npm release on main; no run exists for ${sha}`);
  } else if (run.status === "completed") {
    const pages = await request(`actions/runs/${run.id}/artifacts?per_page=100`, { token, paginate: true });
    const candidate = pages.flatMap((page) => page.artifacts).some((artifact) => artifact.name === `npm-candidate-${sha}` && !artifact.expired);
    const retry = run.conclusion === "failure" && candidate ? "rerun-failed-jobs" : "rerun";
    await request(`actions/runs/${run.id}/${retry}`, { method: "POST", token });
    console.log(`Requested ${retry} for npm release run ${run.id}`);
  } else {
    console.log(`npm release run ${run.id} is ${run.status}`);
  }
}

function versionReviewer(source, entry, enabled) {
  if (!entry.versionQualification) return null;
  assert.ok(enabled, "This package requires its exact-diff pre-commit and pre-push review");
  assert.ok(process.env.ZAI_API_KEY && process.env.PI_RELEASE_REVIEW_SKILL && process.env.RUNNER_TEMP,
    "Version review needs Z.ai, the reviewed skill, and a runner evidence directory");
  const directory = join(process.env.RUNNER_TEMP, "npm-version-review");
  const home = join(process.env.RUNNER_TEMP, "npm-version-review-work", "home");
  const temp = join(process.env.RUNNER_TEMP, "npm-version-review-work", "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, ZAI_API_KEY: process.env.ZAI_API_KEY,
    PI_RELEASE_REVIEW_SKILL: process.env.PI_RELEASE_REVIEW_SKILL,
    PI_RELEASE_REVIEW_AUTOMATION_VERSIONER: fileURLToPath(import.meta.url) };
  let installed = false;
  return (phase, base) => {
    if (!installed) {
      run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: source, env: { PATH: env.PATH, HOME: home, TMPDIR: temp }, timeout: 0 });
      installed = true;
    }
    run(process.execPath, [join(source, "scripts/release-review.mjs"), phase,
      ...(base ? ["--base", base] : []), "--receipt", join(directory, `${phase}.json`)], { cwd: source, env, timeout: 0 });
  };
}

async function publishSignedCommit(source, main, message, deletedPaths, localTree) {
  const baseCommit = await request(`git/commits/${main}`);
  assert.match(baseCommit?.tree?.sha ?? "", /^[a-f0-9]{40}$/, "Could not inspect main tree SHA");
  const tree = [];
  for (const file of versionFiles) {
    const blob = await request("git/blobs", {
      method: "POST",
      body: { content: readFileSync(join(source, file), "utf8"), encoding: "utf-8" },
    });
    assert.match(blob?.sha ?? "", /^[a-f0-9]{40}$/, `Could not upload ${file} blob`);
    tree.push({ path: file, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const path of deletedPaths) {
    tree.push({ path, mode: "100644", type: "blob", sha: null });
  }
  const createdTree = await request("git/trees", {
    method: "POST",
    body: { base_tree: baseCommit.tree.sha, tree },
  });
  assert.equal(createdTree.sha, localTree, "Remote release tree differs from reviewed local tree");
  const createdCommit = await request("git/commits", {
    method: "POST",
    body: { message, tree: createdTree.sha, parents: [main] },
  });
  assert.equal(createdCommit.verification?.verified, true, "GitHub did not sign the automatic version commit");
  const updated = await fastForwardMain(createdCommit.sha);
  return { updated, sha: createdCommit.sha };
}

async function reconcile(source, entry, repository, appSlug, versionReviewEnabled, recovery) {
  const root = mkdtempSync(join(tmpdir(), "npm-version-git-"));
  const appEnv = { ...process.env, GH_TOKEN: process.env.RELEASE_GH_TOKEN, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  delete appEnv.ZAI_API_KEY;
  const scopedGit = (args, options = {}) => git(source, args, { env: appEnv, ...options });
  const inspectCommit = (sha) => request(`commits/${sha}`, { token: process.env.GH_TOKEN });
  try {
    const review = versionReviewer(source, entry, versionReviewEnabled);
    scopedGit(["config", "user.name", `${appSlug}[bot]`]);
    scopedGit(["config", "user.email", `${appSlug}[bot]@users.noreply.github.com`]);

    for (let attempt = 1; attempt <= 3; attempt++) {
      git(source, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "--tags"]);
      const main = git(source, ["rev-parse", "refs/remotes/origin/main"]);
      const commits = history(source, "refs/remotes/origin/main");
      const latestBump = await versionCommit(commits, inspectCommit, source);
      const data = await npmMetadata(entry, repository);
      const releases = await request("releases?per_page=100", { token: process.env.GH_TOKEN, paginate: true });

      if (recovery) {
        assert.equal(latestBump?.sha, recovery.source, "Supersession source does not match the latest automatic version");
        const manifest = JSON.parse(git(source, ["show", `${latestBump.sha}:package.json`]));
        identity(entry, repository, manifest);
        assert.equal(manifest.version, recovery.version, "Supersession version does not match the latest automatic version");
        assert.ok(!data.versions[recovery.version], "Supersession version is already published on npm; reconcile its original release");
        assert.ok(!releases.some((release) => release.tag_name === `v${recovery.version}` && !release.draft),
          "Supersession version is already published on GitHub");
        const runs = await request(`actions/workflows/npm-release.yml/runs?head_sha=${recovery.source}&per_page=1`, { token: process.env.GH_TOKEN });
        const run = runs.workflow_runs[0];
        assert.ok(run?.head_sha === recovery.source && run.head_branch === "main"
          && ["push", "schedule", "workflow_dispatch"].includes(run.event) && run.status === "completed" && run.conclusion === "failure",
        "Supersession requires a failed original main release run");
        assert.notEqual(main, recovery.source, "Supersession requires fixed main after the failed automatic version");
        console.log(`Superseding unpublished ${entry.npmPackage}@${recovery.version} from ${recovery.source}; preserving its release records`);
      }

      let released;
      let releasedVersion;
      if (latestBump && !recovery) {
        const bumpManifest = JSON.parse(git(source, ["show", `${latestBump.sha}:package.json`]));
        identity(entry, repository, bumpManifest);
        const release = releases.find((item) => item.tag_name === `v${bumpManifest.version}`);
        const published = data.versions[bumpManifest.version];
        const match = /<!-- pi-npm-release: ([a-f0-9]{40}) (sha512-[^\s]+) -->/.exec(release?.body ?? "");
        const complete = release && !release.draft && published && match && match[2] === published.dist?.integrity
          && markedSource(release.body) === latestBump.source && isAncestor(source, latestBump.sha, match[1])
          && isAncestor(source, match[1], main) && git(source, ["rev-parse", `refs/tags/v${bumpManifest.version}^{commit}`]) === match[1];
        if (!complete) {
          console.log(`Waiting for ${entry.npmPackage}@${bumpManifest.version} to complete on npm and GitHub`);
          await rerunRelease(match?.[1] ?? latestBump.sha, main, Boolean(release?.draft));
          return;
        }
        released = match[1];
        releasedVersion = bumpManifest.version;
      } else {
        releasedVersion = data["dist-tags"].latest;
        const tag = `v${releasedVersion}`;
        assert.ok(releases.some((release) => release.tag_name === tag && !release.draft && !release.prerelease),
          `Latest npm version ${releasedVersion} has no published GitHub release`);
        released = git(source, ["rev-parse", `refs/tags/${tag}^{commit}`]);
        const tagged = JSON.parse(git(source, ["show", `${released}:package.json`]));
        identity(entry, repository, tagged);
        assert.equal(tagged.version, releasedVersion, "Latest npm version and GitHub tag manifest differ");
      }

      if (!recovery && versionOnly(source, released, main)) {
        console.log(`Main has nothing to release since v${releasedVersion}`);
        return;
      }

      const cursor = commits.findIndex((commit) => commit.sha === released);
      assert.ok(cursor >= 0, "The latest release is not on main's first-parent history");
      let selected;
      if (recovery) {
        selected = main;
      } else if (!latestBump && cursor > 0) {
        const installed = git(source, ["log", "--first-parent", "--diff-filter=A", "-1", "--format=%H", main,
          "--", ".github/workflows/npm-version.yml"]);
        const installation = commits.findIndex((commit) => commit.sha === installed);
        assert.ok(installation >= 0 && installation < cursor, "The version workflow was not installed after the latest published release");
        selected = installed;
      } else {
        for (let index = cursor - 1; index >= 0; index--) {
          if (!(await isVersionCommit(commits[index], commits[index + 1]?.sha, inspectCommit, source))) {
            selected = commits[index].sha;
            break;
          }
        }
      }
      if (!selected) {
        console.log("Main has no unreleased source commits");
        return;
      }
      assert.ok(isAncestor(source, selected, main), "Release source is not an ancestor of main");

      if (!recovery && await buildsPublishedPackage(source, main, data.versions[releasedVersion])) {
        console.log(`Main builds the package published as v${releasedVersion}; nothing to release`);
        return;
      }

      scopedGit(["switch", "--force", "--detach", main]);
      const manifest = readJson(join(source, "package.json"));
      identity(entry, repository, manifest);
      const tags = scopedGit(["tag", "--list"]).split("\n").filter(Boolean);
      const version = nextVersion(manifest.version, Object.keys(data.versions), tags);
      const previous = releases.find((item) => !item.draft && item.tag_name === `v${data["dist-tags"].latest}`)?.tag_name;
      const generated = await request("releases/generate-notes", {
        method: "POST",
        body: { tag_name: `v${version}`, target_commitish: main, ...(previous ? { previous_tag_name: previous } : {}) },
      });
      const subject = git(source, ["show", "-s", "--format=%s", selected]);
      const replacement = recovery
        ? `- Supersedes unpublished ${recovery.version} from ${recovery.source}. Includes all changes since v${releasedVersion}; the original release records remain unchanged.\n\n`
        : "";
      const notes = `${replacement}- ${subject} ([${selected.slice(0, 7)}](https://github.com/${repository}/commit/${selected}))\n\n${generated.body ?? ""}`;

      const fragments = treeFragments(source, "HEAD");
      stageVersion(source, version, notes, new Date().toISOString().slice(0, 10), recovery?.version, fragments.notes);
      if (fragments.paths.length) scopedGit(["rm", "-q", "--", ...fragments.paths]);
      formatVersion(source);
      scopedGit(["add", ...versionFiles]);
      review?.("pre-commit");
      const message = `chore(release): ${version}\n\n${sourceMarker(selected)}${recovery ? `\n\n${supersessionMarker(recovery)}` : ""}`;
      scopedGit(["commit", "-m", message]);
      assert.ok(versionOnly(source, main, "HEAD"), "Automatic version commit changed non-version files");
      review?.("pre-push", main);
      const localTree = scopedGit(["rev-parse", "HEAD^{tree}"]);
      const published = await publishSignedCommit(source, main, message, fragments.paths, localTree);
      if (published.updated) {
        git(source, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
        output({ commit: published.sha, version, source: selected });
        console.log(`Committed ${entry.npmPackage}@${version} (${published.sha}) on main for ${selected}`);
        return;
      }
      console.log(`Main advanced past ${main} before fast-forward (attempt ${attempt}/3); retrying`);
    }
    throw new Error("Main advanced concurrently across 3 version commit attempts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: "string" }, "app-slug": { type: "string" },
    "package-qualified": { type: "boolean", default: false },
    "version-reviewed": { type: "boolean", default: false },
    "supersede-version": { type: "string" }, "supersede-source": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log(`Usage:
  npm-version.mjs reconcile --source PATH --app-slug APP [--package-qualified] [--version-reviewed]
    [--supersede-version X.Y.Z --supersede-source FAILED_VERSION_COMMIT_SHA]

Version automation runs only in GitHub Actions on main. It compares main against the
published npm tarball and commits a GitHub-signed version, lockfile, and changelog update
directly onto main when installable package contents changed. Supersession requires an
operator workflow_dispatch of the trusted npm-version.yml caller to advance past a failed,
npm-unpublished automatic version while preserving existing release records.`);
    return;
  }
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Version automation only runs in GitHub Actions");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Version automation only runs from main");
  const repository = process.env.GITHUB_REPOSITORY;
  let recovery;
  if (values["supersede-version"] !== undefined || values["supersede-source"] !== undefined) {
    assert.ok(values["supersede-version"] && values["supersede-source"], "Supersession requires both --supersede-version and --supersede-source");
    versionParts(values["supersede-version"]);
    assert.match(values["supersede-source"], /^[a-f0-9]{40}$/, "Supersession requires an exact failed version commit SHA");
    assert.equal(positionals[0], "reconcile", "Supersession inputs apply only to reconcile");
    assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch", "Supersession requires an operator workflow_dispatch");
    assert.equal(process.env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/npm-version.yml@refs/heads/main`,
      "Supersession requires the trusted npm-version.yml caller on main");
    recovery = { version: values["supersede-version"], source: values["supersede-source"] };
  }
  const entry = readJson(new URL("../fleet.json", import.meta.url)).find((item) => `fitchmultz/${item.repo}` === repository);
  assert.ok(entry?.npmRelease === "automatic", "Repository has no automatic npm release channel");
  assert.ok(!entry.versionQualification || values["version-reviewed"],
    `${repository} requires its exact-diff pre-commit and pre-push review before automatic versioning`);
  assert.ok(!entry.releaseQualification || values["package-qualified"],
    `${repository} requires its package-specific release qualification before automatic versioning`);
  assert.equal(positionals[0], "reconcile", "Choose reconcile");
  assert.ok(values.source && values["app-slug"], "reconcile requires --source and --app-slug");
  await reconcile(resolve(values.source), entry, repository, values["app-slug"], values["version-reviewed"], recovery);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
