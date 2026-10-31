import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isolatedEnvironment, readJson, run } from "./common.mjs";
import { identity, markedSource, newer, registry, sourceMarker, versionParts } from "./npm-release-core.mjs";

const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const branchFor = (source) => `npm-version/${source}`;
const pendingStart = "<!-- npm-release:unreleased:start -->";
const pendingEnd = "<!-- npm-release:unreleased:end -->";

function nextVersion(manifestVersion, publishedVersions, tags) {
  const versions = [manifestVersion, ...publishedVersions, ...tags.map((tag) => tag.replace(/^v/, ""))].filter((version) => stable.test(version));
  assert.ok(versions.length, "No stable version available");
  const latest = versions.reduce((a, b) => newer(b, a) ? b : a);
  const [major, minor, patch] = versionParts(latest);
  assert.ok(Number.isSafeInteger(patch + 1), "Version components exceed the safe integer range");
  return `${major}.${minor}.${patch + 1}`;
}

function versionChangelog(changelog, version, generated, date) {
  versionParts(version);
  const notes = generated.trim().replace(/^##\s+/gm, "### ");
  assert.ok(notes, "Generated release notes are empty");
  const unreleased = /^##\s+\[?Unreleased\]?(?:\s.*)?$/im.exec(changelog);
  if (unreleased) {
    const start = unreleased.index + unreleased[0].length;
    const next = /^##\s+/m.exec(changelog.slice(start));
    const end = next ? start + next.index : changelog.length;
    const pending = changelog.slice(start, end).trim();
    const body = `${pendingStart}\n${pending ? `${pending}\n` : ""}${pendingEnd}\n\n${notes}`;
    return `${changelog.slice(0, start)}\n\n## ${version} - ${date}\n\n${body}\n\n${changelog.slice(end)}`;
  }
  const heading = /^##\s+/m.exec(changelog);
  const position = heading?.index ?? changelog.length;
  const prefix = changelog.slice(0, position).trimEnd();
  return `${prefix}\n\n## ${version} - ${date}\n\n${pendingStart}\n${pendingEnd}\n\n${notes}\n\n${changelog.slice(position)}`;
}

function setVersion(source, version) {
  const root = mkdtempSync("/tmp/npm-version-");
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

function stageVersion(source, version, notes, date) {
  setVersion(source, version);
  const path = join(source, "CHANGELOG.md");
  writeFileSync(path, versionChangelog(readFileSync(path, "utf8"), version, notes, date));
}

function retargetVersion(source, previous, version) {
  const path = join(source, "CHANGELOG.md");
  const changelog = readFileSync(path, "utf8");
  const heading = new RegExp(`^(##\\s+\\[?v?)${previous.replaceAll(".", "\\.")}(\\]?(?:\\s.*)?)$`, "gm");
  assert.equal([...changelog.matchAll(heading)].length, 1, `Expected one ${previous} changelog heading`);
  setVersion(source, version);
  writeFileSync(path, changelog.replace(heading, (_, prefix, suffix) => `${prefix}${version}${suffix}`));
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

export async function versionCommit(commits, repository, pulls) {
  for (const commit of commits) {
    const source = markedSource(commit.message);
    if (!source) continue;
    const associated = await pulls(commit.sha);
    if (associated.some((pull) => pull.merged_at && pull.merge_commit_sha === commit.sha && pull.base?.ref === "main"
      && pull.head?.ref === branchFor(source) && pull.head?.repo?.full_name === repository && pull.user?.type === "Bot")) {
      return { ...commit, source };
    }
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

function changelogSection(text, heading) {
  const matches = [...text.matchAll(heading)];
  assert.ok(matches.length <= 1, "Expected at most one matching changelog section");
  if (!matches.length) return null;
  const start = matches[0].index;
  const headerEnd = start + matches[0][0].length;
  const next = /^##\s+/m.exec(text.slice(headerEnd));
  const end = next ? headerEnd + next.index : text.length;
  return { start, end, heading: matches[0][0], body: text.slice(headerEnd, end).trim() };
}

function mergeLines(source, env, root, name, base, ours, theirs) {
  const separator = "<!-- npm-release:merge-line -->";
  assert.ok([base, ours, theirs].every((value) => !value.includes(separator)), `${name} contains the merge separator`);
  // Separate adjacent lines so Git can merge independent edits without changing their formatting.
  const encode = (value) => value ? value.replace(/\n$/, "").split("\n").map((line) => `${line}\n${separator}\n`).join("") : "";
  const paths = ["ours", "base", "theirs"].map((side) => join(root, `${name}-${side}`));
  [ours, base, theirs].forEach((value, index) => writeFileSync(paths[index], encode(value)));
  const merged = spawnSync("git", ["merge-file", "--stdout", "--diff3",
    "-L", "ours", "-L", "base", "-L", "theirs", ...paths], { cwd: source, env, encoding: "utf8" });
  if (merged.error) throw merged.error;
  assert.ok(merged.status === 0 || (merged.status > 0 && merged.status < 128), `Could not merge ${name}`);
  const conflict = /^<<<<<<< ours\n([\s\S]*?)^\|\|\|\|\|\|\| base\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> theirs\n/gm;
  const unique = (text, part) => part && text.indexOf(part) >= 0 && text.indexOf(part) === text.lastIndexOf(part);
  const result = merged.stdout.replace(conflict, (_, ourPart, basePart, theirPart) => {
    if (unique(theirPart, basePart)) return theirPart.replace(basePart, () => ourPart);
    if (unique(ourPart, basePart)) return ourPart.replace(basePart, () => theirPart);
    throw new Error(`Concurrent ${name} edits need review`);
  });
  assert.ok(!/^<<<<<<< ours$/m.test(result), `Concurrent ${name} edits need review`);
  const lines = result.split("\n");
  assert.equal(lines.pop(), "");
  const decoded = [];
  for (let index = 0; index < lines.length; index += 2) {
    assert.equal(lines[index + 1], separator, `Could not preserve ${name} formatting`);
    decoded.push(lines[index]);
  }
  return decoded.join("\n");
}

function resolveChangelog(source, version, scopedGit, env, root) {
  const unreleased = /^##\s+\[?Unreleased\]?(?:\s.*)?$/gim;
  const versionHeading = new RegExp(`^##\\s+\\[?v?${version.replaceAll(".", "\\.")}\\]?(?:\\s.*)?$`, "gm");
  const [base, ours, theirs] = [1, 2, 3].map((stage) => scopedGit(["show", `:${stage}:CHANGELOG.md`]));
  const sections = [base, ours, theirs].map((text) => changelogSection(text, unreleased));
  const versionSection = changelogSection(ours, versionHeading);
  assert.ok(versionSection, "The reviewed version changelog section is missing");
  assert.ok(!versionHeading.test(base) && !versionHeading.test(theirs), "Concurrent version headings require review");
  const release = ours.slice(versionSection.start, versionSection.end).trimEnd();
  const start = release.indexOf(pendingStart);
  const end = release.indexOf(pendingEnd);
  assert.ok(start >= 0 && end > start && release.indexOf(pendingStart, start + pendingStart.length) < 0
    && release.indexOf(pendingEnd, end + pendingEnd.length) < 0, "The reviewed version's Unreleased markers are missing or ambiguous");
  const reviewedPending = release.slice(start + pendingStart.length, end).trim();
  const incoming = mergeLines(source, env, root, "Unreleased", sections[0]?.body ?? "", reviewedPending, sections[2]?.body ?? "");
  const pending = [incoming, sections[1]?.body].filter(Boolean).join("\n\n");
  const reviewedRelease = `${release.slice(0, start + pendingStart.length)}\n${pending ? `${pending}\n` : ""}${release.slice(end)}`;
  const anchor = "<!-- npm-release:merge-anchor -->";
  assert.ok([base, ours, theirs].every((text) => !text.includes(anchor)), "Changelog contains the merge anchor");
  const normalize = (original, removeVersion = false) => {
    let text = original;
    if (removeVersion) text = text.slice(0, versionSection.start) + text.slice(versionSection.end);
    const section = changelogSection(text, unreleased);
    if (section) return `${text.slice(0, section.start)}${anchor}\n\n${text.slice(section.end)}`;
    const first = /^##\s+/m.exec(text);
    const position = first?.index ?? text.length;
    const prefix = text.slice(0, position);
    return `${prefix}${prefix && !prefix.endsWith("\n") ? "\n\n" : ""}${anchor}\n\n${text.slice(position)}`;
  };
  const paths = ["ours", "base", "theirs"].map((name) => join(root, `changelog-${name}`));
  [normalize(ours, true), normalize(base), normalize(theirs)]
    .forEach((text, index) => writeFileSync(paths[index], text));
  const merged = spawnSync("git", ["merge-file", "--stdout", ...paths], { cwd: source, env, encoding: "utf8" });
  if (merged.error) throw merged.error;
  assert.equal(merged.status, 0, "Concurrent changelog changes need review");
  assert.equal(merged.stdout.split(anchor).length, 2, "Merged changelog lost its release position");
  const heading = sections[2]?.heading ?? sections[1]?.heading;
  const insertion = [heading, reviewedRelease].filter(Boolean).join("\n\n");
  writeFileSync(join(source, "CHANGELOG.md"), merged.stdout.replace(anchor, () => insertion));
  scopedGit(["add", "CHANGELOG.md"]);
}

function resolveVersionFiles(source, main, conflicts, scopedGit, env, root) {
  const files = ["package.json", "package-lock.json"];
  const base = scopedGit(["merge-base", "HEAD", main]);
  const versions = [base, "HEAD", main].map((ref) => JSON.parse(scopedGit(["show", `${ref}:package.json`])).version);
  const directory = join(root, "version-merge");
  mkdirSync(directory);
  for (const file of files) writeFileSync(join(directory, file), `${scopedGit(["show", `HEAD:${file}`])}\n`);
  const original = files.map((file) => readJson(join(directory, file)));
  run("npm", ["version", versions[0], "--no-git-tag-version", "--ignore-scripts", "--allow-same-version"],
    { cwd: directory, env: isolatedEnvironment(root), quiet: true });
  files.forEach((file, index) => {
    const normalized = readJson(join(directory, file));
    assert.equal(normalized.version, versions[0], `Could not normalize ${file}`);
    delete original[index].version;
    delete normalized.version;
    if (file === "package-lock.json") {
      assert.equal(normalized.packages?.[""]?.version, versions[0], "Could not normalize the lockfile root version");
      delete original[index].packages[""].version;
      delete normalized.packages[""].version;
    }
    assert.deepEqual(normalized, original[index], `npm changed non-version fields in ${file}`);
  });
  const merged = new Map();
  for (const file of files.filter((name) => conflicts.includes(name))) {
    const result = mergeLines(source, env, root, file, scopedGit(["show", `:1:${file}`]),
      readFileSync(join(directory, file), "utf8"), scopedGit(["show", `:3:${file}`]));
    merged.set(file, `${result}\n`);
  }
  for (const [file, text] of merged) writeFileSync(join(source, file), text);
  setVersion(source, versions[1]);
  scopedGit(["add", ...files]);
}

async function request(path, { method = "GET", body, token = process.env.RELEASE_GH_TOKEN, paginate = false } = {}) {
  assert.ok(token, "GitHub token is missing");
  let url = path.startsWith("https://") ? path : `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`;
  const pages = [];
  do {
    const response = await fetch(url, { method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `GitHub ${method} ${path}: HTTP ${response.status}`);
    const text = await response.text();
    if (text) pages.push(JSON.parse(text));
    url = paginate ? /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] : undefined;
  } while (url);
  return paginate ? pages.flat() : pages[0];
}

async function npmMetadata(entry, repository) {
  const response = await fetch(`${registry}${encodeURIComponent(entry.npmPackage)}`);
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

async function reconcile(source, entry, repository, appSlug) {
  const appEnv = { ...process.env, GH_TOKEN: process.env.RELEASE_GH_TOKEN };
  const pulls = (sha) => request(`commits/${sha}/pulls?per_page=100`, { paginate: true });
  const open = await request("pulls?state=open&base=main&per_page=100", { paginate: true });
  const ours = open.filter((pull) => pull.head?.repo?.full_name === repository && pull.head.ref.startsWith("npm-version/")
    && pull.user?.login === `${appSlug}[bot]`);
  assert.ok(ours.length <= 1, "More than one automatic version PR is open");

  git(source, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "--tags"]);
  const main = git(source, ["rev-parse", "refs/remotes/origin/main"]);
  const commits = history(source, "refs/remotes/origin/main");
  const latestBump = await versionCommit(commits, repository, pulls);
  const data = await npmMetadata(entry, repository);
  const releases = await request("releases?per_page=100", { paginate: true });

  if (latestBump) {
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
  }

  let selected = ours[0] && /^npm-version\/([a-f0-9]{40})$/.exec(ours[0].head.ref)?.[1];
  if (!selected) {
    let releasedSource = latestBump?.source;
    if (!releasedSource) {
      const latest = data["dist-tags"].latest;
      const tag = `v${latest}`;
      assert.ok(releases.some((release) => release.tag_name === tag && !release.draft && !release.prerelease),
        `Latest npm version ${latest} has no published GitHub release`);
      releasedSource = git(source, ["rev-parse", `refs/tags/${tag}^{commit}`]);
      const tagged = JSON.parse(git(source, ["show", `${releasedSource}:package.json`]));
      identity(entry, repository, tagged);
      assert.equal(tagged.version, latest, "Latest npm version and GitHub tag manifest differ");
    }
    const cursor = commits.findIndex((commit) => commit.sha === releasedSource);
    assert.ok(cursor >= 0, "Last released source is not on main's first-parent history");
    if (!latestBump && cursor > 0) {
      const installed = git(source, ["log", "--first-parent", "--diff-filter=A", "-1", "--format=%H", main,
        "--", ".github/workflows/npm-version.yml"]);
      const installation = commits.findIndex((commit) => commit.sha === installed);
      assert.ok(installation >= 0 && installation < cursor, "The version workflow was not installed after the latest published release");
      selected = installed;
    } else {
      for (const commit of commits.slice(0, cursor).reverse()) {
        if (!(await versionCommit([commit], repository, pulls))) { selected = commit.sha; break; }
      }
    }
    if (!selected) { console.log("Main has no unreleased source commits"); return; }
  }
  assert.ok(isAncestor(source, selected, main), "Release source is not an ancestor of main");
  const branch = branchFor(selected);
  const pull = ours[0];
  if (pull) {
    assert.equal(pull.head.ref, branch, "Automatic version PR source changed");
    assert.equal(markedSource(pull.body), selected, "Version PR does not identify its source");
  }

  const root = mkdtempSync("/tmp/npm-version-git-");
  const env = { ...appEnv, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const scopedGit = (args, options = {}) => git(source, args, { env, ...options });
  try {
    run("gh", ["auth", "setup-git"], { cwd: source, env, quiet: true });
    const bot = await request(`https://api.github.com/users/${encodeURIComponent(`${appSlug}[bot]`)}`);
    scopedGit(["config", "user.name", `${appSlug}[bot]`]);
    scopedGit(["config", "user.email", `${bot.id}+${appSlug}[bot]@users.noreply.github.com`]);
    const remote = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { cwd: source, env, encoding: "utf8" });
    if (remote.error) throw remote.error;
    assert.ok(remote.status === 0 || remote.status === 2, "Could not inspect the version branch");
    const exists = remote.status === 0;
    if (exists) {
      scopedGit(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      scopedGit(["switch", "--detach", `refs/remotes/origin/${branch}`]);
      if (!pull) assert.ok(scopedGit(["log", "--format=%B", `${main}..HEAD`]).includes(sourceMarker(selected)),
        "Version branch does not identify its source");
    } else scopedGit(["switch", "--detach", "refs/remotes/origin/main"]);

    if (!exists) {
      const manifest = readJson(join(source, "package.json"));
      identity(entry, repository, manifest);
      const tags = scopedGit(["tag", "--list"]).split("\n").filter(Boolean);
      const version = nextVersion(manifest.version, Object.keys(data.versions), tags);
      const previous = releases.find((item) => !item.draft && item.tag_name === `v${data["dist-tags"].latest}`)?.tag_name;
      const generated = await request("releases/generate-notes", { method: "POST", body: { tag_name: `v${version}`,
        target_commitish: main, ...(previous ? { previous_tag_name: previous } : {}) } });
      const subject = git(source, ["show", "-s", "--format=%s", selected]);
      const notes = `- ${subject} ([${selected.slice(0, 7)}](https://github.com/${repository}/commit/${selected}))\n\n${generated.body ?? ""}`;
      stageVersion(source, version, notes, new Date().toISOString().slice(0, 10));
      scopedGit(["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
      scopedGit(["commit", "-m", `chore(release): ${version}`, "-m", sourceMarker(selected)]);
      scopedGit(["push", "origin", `HEAD:refs/heads/${branch}`]);
    } else if (!isAncestor(source, main, "HEAD")) {
      const merged = spawnSync("git", ["merge", "--no-commit", "--no-ff", main], { cwd: source, env, encoding: "utf8" });
      if (merged.error) throw merged.error;
      let conflicts = scopedGit(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
      let resolved = false;
      if (conflicts.length && conflicts.every((file) => ["CHANGELOG.md", "package.json", "package-lock.json"].includes(file))) {
        try {
          if (conflicts.some((file) => file === "package.json" || file === "package-lock.json")) {
            resolveVersionFiles(source, main, conflicts, scopedGit, env, root);
          }
          if (conflicts.includes("CHANGELOG.md")) resolveChangelog(source, readJson(join(source, "package.json")).version, scopedGit, env, root);
          conflicts = scopedGit(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
          resolved = true;
        } catch (error) {
          scopedGit(["merge", "--abort"]);
          throw error;
        }
      }
      if (conflicts.length) {
        scopedGit(["merge", "--abort"]);
        throw new Error(`Version PR needs its actual merge conflicts resolved: ${conflicts.join(", ")}`);
      }
      assert.ok(merged.status === 0 || resolved, `Could not update the version PR: ${merged.stderr}`);
      const mainManifest = JSON.parse(git(source, ["show", `${main}:package.json`]));
      identity(entry, repository, mainManifest);
      const tags = scopedGit(["tag", "--list"]).split("\n").filter(Boolean);
      const next = nextVersion(mainManifest.version, Object.keys(data.versions), tags);
      const current = readJson(join(source, "package.json")).version;
      if (newer(next, current)) retargetVersion(source, current, next);
      scopedGit(["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
      scopedGit(["commit", "-m", "chore(release): update from main", "-m", sourceMarker(selected)]);
      scopedGit(["push", "origin", `HEAD:refs/heads/${branch}`]);
    }

    let number = pull?.number;
    if (!number) {
      const url = run("gh", ["pr", "create", "--repo", repository, "--base", "main", "--head", branch,
        "--title", `chore(release): ${readJson(join(source, "package.json")).version}`,
        "--body", `Automatic version, lockfile and changelog update for ${selected}.\n\n${sourceMarker(selected)}`], { cwd: source, env, quiet: true }).trim();
      number = Number(new URL(url).pathname.split("/").at(-1));
    }
    assert.ok(Number.isSafeInteger(number) && number > 0, "Could not identify the version PR");
    // Pi retains a finding-bearing failure after its threads are resolved on the same head.
    // A new, empty head lets both native reviewers reassess the disposition without changing the release.
    if (pull && pull.head.sha === scopedGit(["rev-parse", "HEAD"])) {
      const pi = (await checkRuns(pull.head.sha)).find((check) => check.app?.slug === "pi-durable" && check.name === "Pi Durable Review");
      if (pi?.status === "completed" && pi.conclusion === "failure") {
        const count = reportedFindings(pi, pull.base.sha, pull.head.sha);
        const { resolvedPi } = await reviewThreads(number, pull.head.sha);
        assert.ok(resolvedPi >= count, `Pi reported ${count} findings but only ${resolvedPi} resolved current-head Pi threads were found`);
        scopedGit(["commit", "--allow-empty", "-m", "chore(release): recheck reviewed disposition", "-m", sourceMarker(selected)]);
        scopedGit(["push", "origin", `HEAD:refs/heads/${branch}`]);
      }
    }
    const current = await request(`pulls/${number}`);
    assert.equal(current.head.ref, branch);
    assert.equal(current.head.sha, scopedGit(["rev-parse", "HEAD"]), "Version PR head changed during reconciliation");
    output({ pull: String(number), head: current.head.sha, source: selected });
    console.log(`Version PR #${number} covers ${selected}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function checkRuns(head) {
  const pages = await request(`commits/${head}/check-runs?per_page=100`, { token: process.env.GH_TOKEN, paginate: true });
  return pages.flatMap((page) => page.check_runs);
}

function reviewedPair(check, base, head) {
  const pair = /\*\*Reviewed pair:\*\* base `([a-f0-9]{40})` → head `([a-f0-9]{40})`/.exec(check.output?.summary ?? "");
  assert.ok(pair?.[1] === base && pair[2] === head && check.head_sha === head, "Pi did not review the current base and head");
}

function reportedFindings(check, base, head) {
  const title = /^(?:Review completed|Completed review reused) — ([1-9]\d*) findings? reported$/.exec(check.output?.title ?? "");
  assert.ok(title, "Pi finding check does not identify a completed review");
  reviewedPair(check, base, head);
  const count = Number(title[1]);
  assert.ok(Number.isSafeInteger(count), "Invalid Pi finding count");
  return count;
}

async function reviewState(number, head, entry, allowPiFindings = false) {
  const token = process.env.GH_TOKEN;
  const pull = await request(`pulls/${number}`, { token });
  assert.equal(pull.state, "open", "Version PR is no longer open");
  assert.equal(pull.head.sha, head, "Version PR head changed while checks were running");
  const checks = await checkRuns(head);
  const expected = [["pi-durable", "Pi Durable Review"], ["cursor", "Cursor Automation: PR Bug Review - Maintained Repos"],
    ...(entry.releaseChecks ?? ["compatibility / compatibility"]).map((name) => ["github-actions", name])];
  const required = expected.map(([app, name]) => checks.find((check) => check.app?.slug === app && check.name === name && check.head_sha === head));
  const pi = required[0];
  const piFailure = allowPiFindings && pi?.status === "completed" && pi.conclusion === "failure"
    ? reportedFindings(pi, pull.base.sha, head) : 0;
  for (const check of checks) {
    if (check === pi && piFailure) continue;
    if (check.status === "completed" && ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(check.conclusion)) {
      throw new Error(`${check.name} did not pass: ${check.html_url ?? check.details_url ?? ""}`);
    }
  }
  for (const check of required.filter(Boolean)) {
    if (check.status === "completed" && check !== pi) assert.equal(check.conclusion, "success", `${check.name} did not pass`);
    if (check === pi && check.status === "completed" && !piFailure) assert.equal(check.conclusion, "success", `${check.name} did not pass`);
  }
  if (pi?.status === "completed" && pi.conclusion === "success") reviewedPair(pi, pull.base.sha, head);
  const passed = (check) => check?.status === "completed" && check.conclusion === "success";
  return { ready: required.every(passed), otherReady: required.slice(1).every(passed), piFailure };
}

async function reviewThreads(number, head, allowUnresolved = false) {
  const [owner, name] = process.env.GITHUB_REPOSITORY.split("/");
  let cursor = null;
  let resolvedPi = 0;
  let unresolved = 0;
  do {
    const result = await request("https://api.github.com/graphql", { method: "POST", token: process.env.GH_TOKEN, body: {
      query: `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$name) { pullRequest(number:$number) { headRefOid
          reviewThreads(first:100,after:$cursor) {
            nodes { isResolved comments(first:1) { nodes { author { login } body originalCommit { oid } } } }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }`, variables: { owner, name, number, cursor },
    } });
    assert.ok(!result.errors?.length, `GitHub review thread lookup failed: ${JSON.stringify(result.errors)}`);
    const pull = result.data.repository.pullRequest;
    assert.equal(pull.headRefOid, head, "Version PR head changed while checking review threads");
    for (const thread of pull.reviewThreads.nodes) {
      if (!thread.isResolved) unresolved++;
      const comment = thread.comments.nodes[0];
      if (thread.isResolved && comment?.author?.login === "pi-durable" && comment.originalCommit?.oid === head
        && /<!-- pi-durable-review:/.test(comment.body ?? "")) resolvedPi++;
    }
    cursor = pull.reviewThreads.pageInfo.hasNextPage ? pull.reviewThreads.pageInfo.endCursor : null;
  } while (cursor);
  const comments = await request(`issues/${number}/comments?per_page=100`, { token: process.env.GH_TOKEN, paginate: true });
  const standalone = comments.find((comment) => /<!-- pi-durable-review:/.test(comment.body ?? ""));
  assert.ok(!standalone, `Version PR has a standalone Pi Durable finding requiring disposition: ${standalone?.html_url ?? ""}`);
  const reviews = await request(`pulls/${number}/reviews?per_page=100`, { token: process.env.GH_TOKEN, paginate: true });
  for (const review of reviews.filter((item) => item.user?.login === "cursor[bot]" && item.body?.includes("CURSOR_AUTOMATION_ID"))) {
    const comments = await request(`pulls/${number}/reviews/${review.id}/comments?per_page=100`, { token: process.env.GH_TOKEN, paginate: true });
    assert.ok(comments.length, "Version PR has a standalone Cursor finding requiring disposition");
  }
  if (!allowUnresolved) assert.equal(unresolved, 0, "Version PR has unresolved review threads");
  return { resolvedPi, unresolved };
}

async function waitForChecks(number, head, entry) {
  while (true) {
    const state = await reviewState(number, head, entry, true);
    if (state.piFailure || state.ready) {
      const { resolvedPi, unresolved } = await reviewThreads(number, head, true);
      if (unresolved === 0 && state.piFailure && state.otherReady) {
        assert.ok(resolvedPi >= state.piFailure,
          `Pi reported ${state.piFailure} findings but only ${resolvedPi} resolved current-head Pi threads were found`);
        output({ refresh: "true" });
        console.log("Resolved Pi findings require a fresh review on a new version PR head");
        return;
      }
      if (unresolved === 0 && state.ready) {
        const result = spawnSync("gh", ["pr", "checks", String(number), "--repo", process.env.GITHUB_REPOSITORY, "--watch", "--fail-fast"],
          { env: process.env, stdio: "inherit" });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, "Version PR checks did not pass");
        const current = await reviewState(number, head, entry);
        const threads = await reviewThreads(number, head, true);
        if (current.ready && threads.unresolved === 0) {
          output({ ready: "true" });
          return;
        }
      }
      console.log("Waiting for review findings to be addressed and threads resolved");
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    } else {
      console.log("Waiting for current-head compatibility and reviews");
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

async function mergeVersion(source, number, head, entry) {
  assert.ok((await reviewState(number, head, entry)).ready, "Version PR checks are not complete");
  await reviewThreads(number, head);
  const pull = await request(`pulls/${number}`);
  git(source, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const main = git(source, ["rev-parse", "refs/remotes/origin/main"]);
  assert.equal(pull.base.sha, main, "Main advanced while the version PR was being reviewed");
  assert.ok(isAncestor(source, main, head), "Version PR must be updated to current main before merging");
  const original = markedSource(pull.body);
  assert.ok(original && pull.head.ref === branchFor(original), "Version PR source marker differs from its branch");
  assert.equal(git(source, ["rev-parse", "HEAD"]), head, "Checked-out version PR head changed");
  const version = readJson(join(source, "package.json")).version;
  versionParts(version);
  run("gh", ["pr", "merge", String(number), "--repo", process.env.GITHUB_REPOSITORY, "--squash",
    "--match-head-commit", head, "--subject", `chore(release): ${version}`, "--body", sourceMarker(original)],
  { cwd: source, env: { ...process.env, GH_TOKEN: process.env.RELEASE_GH_TOKEN } });
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: "string" }, "app-slug": { type: "string" }, pull: { type: "string" }, head: { type: "string" },
  } });
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Version automation only runs in GitHub Actions");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Version automation only runs from main");
  const repository = process.env.GITHUB_REPOSITORY;
  const entry = readJson(new URL("../fleet.json", import.meta.url)).find((item) => `fitchmultz/${item.repo}` === repository);
  assert.ok(entry?.npmRelease === "automatic", "Repository has no automatic npm release channel");
  assert.ok(!entry.versionQualification, `${repository} requires its exact-diff pre-commit and pre-push review before automatic versioning`);
  assert.ok(!entry.releaseQualification, `${repository} requires its package-specific release qualification before automatic versioning`);
  if (positionals[0] === "reconcile") {
    assert.ok(values.source && values["app-slug"], "reconcile requires --source and --app-slug");
    await reconcile(resolve(values.source), entry, repository, values["app-slug"]);
  } else if (["wait", "merge"].includes(positionals[0])) {
    const number = Number(values.pull);
    assert.ok(Number.isSafeInteger(number) && number > 0 && /^[a-f0-9]{40}$/.test(values.head ?? ""), "wait/merge require --pull and --head");
    if (positionals[0] === "wait") await waitForChecks(number, values.head, entry);
    else { assert.ok(values.source, "merge requires --source"); await mergeVersion(resolve(values.source), number, values.head, entry); }
  } else throw new Error("Choose reconcile, wait or merge");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
