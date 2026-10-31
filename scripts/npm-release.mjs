import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkResources, probeCli } from "./cli-probe.mjs";
import { awaitsFirstPublication, isolatedEnvironment, readJson, run, sha256, stageSource, writeJson } from "./common.mjs";
import { prepareHost, resolveHostTargets, selectDevelopmentHost, verifyForkArtifact } from "./hosts.mjs";
import { identity as assertIdentity, markedSource, newer, registry, sourceMarker, versionParts } from "./npm-release-core.mjs";
import { history, versionCommit } from "./npm-version.mjs";

const identity = (manifest) => assertIdentity(entry, repository, manifest);
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: "string" }, repository: { type: "string" }, output: { type: "string" },
  fork: { type: "string" }, artifact: { type: "string" }, "source-ref": { type: "string" }, "release-source": { type: "string" },
  recovered: { type: "string" }, "recovered-sha256": { type: "string" }, "recovered-receipt-sha256": { type: "string" },
  qualification: { type: "string" },
  "official-version": { type: "string" }, "fork-ref": { type: "string" },
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

function visibilityRemaining(deadline) {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, "Published npm registry visibility timed out; retain the candidate and retry, never unpublish");
  return remaining;
}

function nativeStagingLatest(data) {
  const latest = data.versions?.["0.0.0-stage"];
  // npm can expose its repository-less stub before latest catches up with the verified publication.
  return data["dist-tags"]?.latest === "0.0.0-stage" && awaitsFirstPublication(entry, latest?.name ?? null)
    && latest.version === "0.0.0-stage" && latest.stub === true;
}

async function metadata(name, deadline) {
  const response = await fetch(`${registry}${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(
    deadline === undefined ? 30_000 : Math.min(30_000, visibilityRemaining(deadline))) });
  if (response.status === 404 && (deadline !== undefined || (name === entry?.npmPackage && name === `@fitchmultz/${entry.repo}`
    && ["automatic", "approval"].includes(entry.npmRelease)))) return null;
  assert.ok(response.ok, `Owned npm package metadata: HTTP ${response.status}`);
  const data = await response.json();
  assert.equal(data.name, name);
  assert.ok(data.maintainers?.some((maintainer) => maintainer.name === "fitchmultz"), "npm package is not maintained by fitchmultz");
  const latest = data.versions?.[data["dist-tags"]?.latest];
  if (deadline === undefined) assert.ok(latest, "npm latest metadata is missing");
  if (latest && !(deadline !== undefined && nativeStagingLatest(data))) identity(latest);
  return data;
}

async function verifyPublication(candidate) {
  // npm processing has taken over six minutes; leave three minutes of the ten-minute job for setup/publication/finalization.
  const deadline = Date.now() + 420_000;
  let exactVerified = false;
  while (true) {
    let pending = "exact version HTTP 404";
    if (!exactVerified) {
      const response = await fetch(`${registry}${encodeURIComponent(candidate.name)}/${candidate.version}`,
        { signal: AbortSignal.timeout(Math.min(30_000, visibilityRemaining(deadline))) });
      if (response.status !== 404) {
        assert.ok(response.ok, `Published exact-version verification: HTTP ${response.status}; retain the candidate and retry, never unpublish`);
        const published = await response.json();
        identity(published);
        assert.equal(published.version, candidate.version);
        assert.equal(published.dist.integrity, candidate.integrity, "Published bytes differ from the verified tarball");
        exactVerified = true;
      }
    }
    if (exactVerified) {
      const data = await metadata(candidate.name, deadline);
      pending = data ? "package version entry missing" : "package metadata HTTP 404";
      const published = data?.versions?.[candidate.version];
      if (published) {
        identity(published);
        assert.equal(published.version, candidate.version);
        assert.equal(published.dist.integrity, candidate.integrity, "Published bytes differ from the verified tarball");
        const latest = data["dist-tags"]?.latest;
        pending = `latest=${latest ?? "missing"}`;
        if (data.versions[latest] && !nativeStagingLatest(data) && (latest === candidate.version || newer(latest, candidate.version))) {
          visibilityRemaining(deadline);
          return;
        }
      }
    }
    console.log(`Waiting for npm registry visibility: ${candidate.name}@${candidate.version} (${pending})`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, visibilityRemaining(deadline))));
  }
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
  const existing = data?.versions[manifest.version];
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const github = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `GitHub ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const releases = [];
  for (let page = 1; ; page++) {
    const items = await github(`releases?per_page=100&page=${page}`);
    releases.push(...items);
    if (items.length < 100) break;
  }
  const draft = releases.find((item) => item.tag_name === `v${manifest.version}`);
  const draftMarker = /<!-- pi-npm-release: ([a-f0-9]{40}) (sha512-[^\s]+) -->/.exec(draft?.body ?? "");
  const matchingDraft = draft?.draft === true && draftMarker?.[1] === ref
    && (!existing || draftMarker[2] === existing.dist?.integrity);
  const automatic = existsSync(join(source, ".github/workflows/npm-version.yml"));
  const bump = automatic ? await versionCommit(history(source), repository, (sha) => github(`commits/${sha}/pulls?per_page=100`)) : null;
  const bumpVersion = bump && JSON.parse(run("git", ["show", `${bump.sha}:package.json`], { cwd: source, quiet: true })).version;
  const reviewedSource = !automatic || Boolean(bump && bump.sha === ref && bumpVersion === manifest.version);
  const release = reviewedSource && (matchingDraft || (!existing && !draft));
  let hosts;
  if (release) {
    if (!existing && data) assert.ok(newer(manifest.version, data["dist-tags"].latest), "Refusing to move latest backwards");
    releaseNotes(source, manifest.version);
    if (!automatic) {
      const pulls = await github(`commits/${ref}/pulls?per_page=100`);
      assert.ok(pulls.some((pull) => pull.merged_at && pull.base?.ref === "main" && pull.merge_commit_sha === ref),
        "Release candidate must come from a merged PR to main, not a direct push");
    }
    hosts = await resolveHostTargets();
  }
  output({ release: String(release), source: ref, version: manifest.version,
    ...(release ? { "release-source": bump?.source ?? ref, "official-version": hosts.officialVersion, "fork-ref": hosts.forkRef } : {}) });
  console.log(release ? `${manifest.name}@${manifest.version}: ${matchingDraft ? "unfinished GitHub release" : `${automatic ? "automatic" : "manual"} version candidate`} ${ref}`
    : `${manifest.name}@${manifest.version}: no release candidate at ${ref}`);
}

async function select() {
  assert.ok(values.source && values.output && values["source-ref"], "select requires --source, --source-ref and --output");
  const source = resolve(values.source);
  const { manifest, ref } = sourceIdentity(source);
  values["release-source"] ||= ref;
  assert.match(values["release-source"], /^[a-f0-9]{40}$/, "select requires an exact --release-source");
  run("git", ["merge-base", "--is-ancestor", values["release-source"], ref], { cwd: source, quiet: true });
  const notes = releaseNotes(source, manifest.version);
  assert.ok(process.env.GH_TOKEN, "Selecting a release candidate requires GitHub access to drafts");
  const root = mkdtempSync("/tmp/npm-select-");
  const env = isolatedEnvironment(root);
  try {
    const gh = (args, options = {}) => run("gh", args, { cwd: root, env: { ...env, GH_TOKEN: process.env.GH_TOKEN }, quiet: true, ...options });
    const releases = JSON.parse(gh(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"])).flat();
    const release = releases.find((item) => item.tag_name === `v${manifest.version}`);
    const data = await metadata(manifest.name);
    const existing = data?.versions[manifest.version];
    if (!release) {
      assert.ok(!existing, "This version is already published without a matching draft; do not rebuild or republish it");
      output({ recovered: "false" });
      console.log(`${manifest.name}@${manifest.version}: preparing a new candidate`);
      return;
    }
    const recovered = recoverDraft(release, { name: manifest.name, version: manifest.version, source: ref,
      releaseSource: values["release-source"] }, root, gh, env);
    assert.ok(recovered, "Existing GitHub release is not this exact automation candidate; leave it untouched");
    assert.equal(recovered.candidate.notes, notes, "Saved release notes differ from the exact source");
    if (existing) assert.equal(existing.dist?.integrity, recovered.candidate.integrity, "Published bytes differ from the saved draft");
    const destination = resolve(values.output);
    mkdirSync(destination, { recursive: true });
    for (const file of ["release.json", "release-notes.md", recovered.candidate.filename]) {
      cpSync(join(recovered.directory, file), join(destination, file));
    }
    output({ recovered: "true", sha256: recovered.candidate.sha256, "receipt-sha256": sha256(join(destination, "release.json")) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function prepare() {
  assert.ok(values.source && values.output && values.fork, "prepare requires --source, --output and --fork");
  const source = resolve(values.source);
  const destination = resolve(values.output);
  const { manifest, ref } = sourceIdentity(source);
  values["release-source"] ||= values["source-ref"] || ref;
  const releaseSource = values["release-source"];
  assert.match(releaseSource, /^[a-f0-9]{40}$/, "prepare requires an exact release source");
  run("git", ["merge-base", "--is-ancestor", releaseSource, ref], { cwd: source, quiet: true });
  const notes = releaseNotes(source, manifest.version);
  mkdirSync(destination, { recursive: true });
  const root = mkdtempSync("/tmp/npm-release-");
  const env = isolatedEnvironment(root);
  try {
    const official = await prepareHost(join(root, "official", "host"), "official", values["official-version"] || "latest", env);
    let filename, hash, integrity;
    if (values.recovered) {
      assert.match(values["recovered-sha256"] ?? "", /^[a-f0-9]{64}$/, "Missing selected draft tarball checksum");
      assert.match(values["recovered-receipt-sha256"] ?? "", /^[a-f0-9]{64}$/, "Missing selected draft receipt checksum");
      const recovered = resolve(values.recovered);
      assert.equal(sha256(join(recovered, "release.json")), values["recovered-receipt-sha256"], "Selected draft receipt changed");
      const saved = verifyArtifact(recovered, env, false, true);
      assert.equal(saved.sha256, values["recovered-sha256"], "Selected draft tarball changed");
      assert.equal(saved.notes, notes, "Saved release notes differ from the exact source");
      ({ filename, sha256: hash, integrity } = saved);
      cpSync(join(recovered, filename), join(destination, filename));
    } else {
      const development = join(root, "development");
      stageSource(source, development);
      if (existsSync(join(development, ".npmrc"))) {
        assert.ok(!/auth|password|username|token|otp|certfile|keyfile/i.test(readFileSync(join(development, ".npmrc"), "utf8")), "Project npm configuration must not contain credentials");
      }
      run("npm", ["ci", "--ignore-scripts", "--dry-run"], { cwd: development, env });
      selectDevelopmentHost(development, official, env);
      run("npm", ["run", "build", "--if-present"], { cwd: development, env });
      // Pack reviewed bundled dependencies, retaining the output compiled against the selected latest SDK.
      run("npm", ["ci", "--ignore-scripts"], { cwd: development, env });
      run("npm", ["run", "release:dry-run", "--if-present"], { cwd: development, env });
      run("git", ["diff", "--exit-code"], { cwd: development, env });
      const packedJson = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: development, env, quiet: true }));
      const packed = Array.isArray(packedJson) ? packedJson : Object.values(packedJson);
      assert.equal(packed.length, 1);
      assert.equal(packed[0].name, manifest.name);
      assert.equal(packed[0].version, manifest.version);
      filename = packed[0].filename;
      assert.equal(basename(filename), filename);
      for (const file of packed[0].files) {
        assert.ok(!/(^|\/)(\.git|\.pi|\.env[^/]*|\.npmrc|\.artifacts|\.debug|\.dogfood|\.DS_Store)(\/|$)/.test(file.path), `Private/repository state in tarball: ${file.path}`);
      }
      const packedTarball = join(destination, filename);
      hash = sha256(packedTarball);
      integrity = `sha512-${createHash("sha512").update(readFileSync(packedTarball)).digest("base64")}`;
      assert.equal(integrity, packed[0].integrity);
    }
    const tarball = join(destination, filename);
    identity(JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], { env, quiet: true })));
    const hosts = {};
    for (const flavor of ["official", "fork"]) {
      const host = flavor === "official" ? official : await prepareHost(join(root, "fork", "host"), "fork", resolve(values.fork), env);
      if (flavor === "fork" && values["fork-ref"]) assert.equal(host.provenance.ref, values["fork-ref"], "Fork artifact differs from this run's resolved host");
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
    writeJson(join(destination, "release.json"), { repository, source: ref, releaseSource, name: manifest.name, version: manifest.version,
      approval: entry.npmRelease === "approval", filename, sha256: hash, integrity, notes, hosts });
    writeFileSync(join(destination, "release-notes.md"), `${notes}\n`);
    output({ sha256: hash, "receipt-sha256": sha256(join(destination, "release.json")) });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## npm release candidate\n\n${manifest.name}@${manifest.version}\n\nCommit: \`${ref}\`\n\nTarball SHA-256: \`${hash}\`\n\nThe **same tarball** loaded through both official and fork bundled Pi CLIs. Package-specific release qualification and publication are separate steps.\n`);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 1000 });
  }
}

function verifyArtifact(directory, env, currentHosts = true, legacy = false) {
  const candidate = readJson(join(directory, "release.json"));
  assert.equal(candidate.repository, repository);
  assert.equal(candidate.name, entry?.npmPackage);
  versionParts(candidate.version);
  assert.match(candidate.source, /^[a-f0-9]{40}$/);
  assert.equal(candidate.source, values["source-ref"], "Artifact came from a different source commit");
  if (!legacy || candidate.releaseSource !== undefined) {
    assert.equal(candidate.releaseSource ?? candidate.source, values["release-source"] || values["source-ref"], "Artifact came from a different release source");
  }
  assert.equal(candidate.approval, entry.npmRelease === "approval", "Artifact approval policy changed");
  assert.equal(basename(candidate.filename), candidate.filename);
  const tarball = join(directory, candidate.filename);
  assert.equal(sha256(tarball), candidate.sha256, "Release tarball checksum changed");
  assert.equal(`sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`, candidate.integrity, "Release tarball integrity changed");
  const manifest = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], { env, quiet: true }));
  identity(manifest);
  assert.equal(manifest.version, candidate.version);
  assert.equal(readFileSync(join(directory, "release-notes.md"), "utf8").trim(), candidate.notes);
  for (const flavor of ["official", "fork"]) {
    const host = candidate.hosts?.[flavor];
    assert.equal(host?.flavor, flavor, `Missing ${flavor} artifact verification`);
    if (!legacy) {
      for (const key of ["indexSha256", "cliSha256", "runtimeLockSha256", "runtimeGraphSha256"]) {
        assert.match(host[key] ?? "", /^[a-f0-9]{64}$/, `Missing ${flavor} ${key}`);
      }
      assert.ok(Object.keys(host.cohort ?? {}).length && host.companions?.typebox && host.provenance, `Missing ${flavor} host identity`);
      for (const key of ["version", "indexSha256", "cliSha256"]) {
        assert.equal(host.observation?.[key], host[key], `${flavor} consumer used a different ${key}`);
      }
    }
  }
  assert.match(candidate.hosts.official.version ?? "", /^\d+\.\d+\.\d+$/, "Missing exact official host identity");
  assert.match(candidate.hosts.fork.provenance?.ref ?? "", /^[a-f0-9]{40}$/, "Missing exact fork host identity");
  if (!legacy) {
    assert.equal(candidate.hosts.official.provenance.version, candidate.hosts.official.version, "Official host provenance differs");
    assert.deepEqual(candidate.hosts.official.provenance.cohort, candidate.hosts.official.cohort, "Official host cohort differs");
  }
  if (currentHosts && values["official-version"]) assert.equal(candidate.hosts.official.version, values["official-version"], "Official artifact differs from this run's resolved host");
  if (currentHosts && values["fork-ref"]) assert.equal(candidate.hosts.fork.provenance.ref, values["fork-ref"], "Fork artifact differs from this run's resolved host");
  return candidate;
}

function verifyFork(directory, candidate) {
  const receipt = verifyForkArtifact(directory);
  assert.deepEqual(receipt, candidate.hosts.fork.provenance, "Fork artifact differs from the qualified host");
  return receipt;
}

function qualify() {
  assert.ok(values.artifact && values.fork && values.output && values["source-ref"] && values["release-source"],
    "qualify requires --artifact, --fork, --output, --source-ref and --release-source");
  assert.match(values["official-version"] ?? "", /^\d+\.\d+\.\d+$/, "qualify requires exact --official-version");
  assert.match(values["fork-ref"] ?? "", /^[a-f0-9]{40}$/, "qualify requires exact --fork-ref");
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^[1-9]\d*$/, "Missing GitHub run identity");
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9]\d*$/, "Missing GitHub run attempt");
  const directory = resolve(values.artifact);
  const candidate = verifyArtifact(directory);
  assert.equal(process.env.GITHUB_SHA, candidate.source, "Caller commit differs from the verified artifact");
  verifyFork(resolve(values.fork), candidate);
  const destination = resolve(values.output);
  mkdirSync(destination, { recursive: true });
  writeJson(join(destination, "qualification.json"), {
    schema: 1, head: candidate.source, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    sha256: candidate.sha256, release_sha256: sha256(join(directory, "release.json")),
  });
}

function verifyQualification(path, directory, candidate, gh) {
  const receipt = readJson(path);
  assert.equal(receipt.schema, 1, "Unexpected release qualification schema");
  assert.equal(receipt.head, candidate.source, "Qualification came from a different source commit");
  assert.equal(receipt.run_id, process.env.GITHUB_RUN_ID, "Qualification came from a different workflow run");
  assert.match(receipt.run_attempt ?? "", /^[1-9]\d*$/, "Qualification has no run attempt");
  assert.ok(BigInt(receipt.run_attempt) <= BigInt(process.env.GITHUB_RUN_ATTEMPT), "Qualification came from a later run attempt");
  assert.equal(receipt.sha256, candidate.sha256, "Qualification tested a different tarball");
  assert.equal(receipt.release_sha256, sha256(join(directory, "release.json")), "Qualification tested different host identities");

  function gate(attempt) {
    const pages = JSON.parse(gh(["api", `repos/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${attempt}/jobs?per_page=100`,
      "--paginate", "--slurp"]));
    const jobs = pages.flatMap((page) => page.jobs).filter((job) => job.name === "Release qualification");
    assert.equal(jobs.length, 1, "Expected one Release qualification job in the workflow run");
    const [job] = jobs;
    assert.equal(String(job.run_id), process.env.GITHUB_RUN_ID, "Qualification job came from a different run");
    assert.equal(String(job.run_attempt), attempt, "Qualification job came from a different attempt");
    assert.equal(job.head_sha, candidate.source, "Qualification job came from a different source commit");
    assert.equal(job.status, "completed", "Release qualification has not completed");
    assert.equal(job.conclusion, "success", "Release qualification did not succeed");
    assert.ok(job.started_at && job.completed_at, "Release qualification has no execution timestamps");
    return job;
  }
  const current = gate(process.env.GITHUB_RUN_ATTEMPT);
  if (receipt.run_attempt !== process.env.GITHUB_RUN_ATTEMPT) {
    const original = gate(receipt.run_attempt);
    assert.equal(current.started_at, original.started_at, "Current attempt did not reuse the qualified job");
    assert.equal(current.completed_at, original.completed_at, "Current attempt did not reuse the qualified job");
  }
}

function recoverDraft(release, prepared, root, gh, env) {
  if (!release?.draft) return null;
  const receipts = release.assets.filter((asset) => /^verification-\d+-\d+\.json$/.test(asset.name));
  for (const receipt of receipts) {
    const directory = join(root, `recovery-${receipt.id}`);
    mkdirSync(directory);
    gh(["release", "download", release.tag_name, "--repo", repository, "--pattern", receipt.name, "--dir", directory]);
    const receiptPath = join(directory, receipt.name);
    assert.equal(receipt.digest, `sha256:${sha256(receiptPath)}`, "Saved release receipt checksum differs from GitHub");
    const saved = readJson(receiptPath);
    if (saved.repository !== repository || saved.name !== prepared.name || saved.version !== prepared.version
      || saved.source !== prepared.source || (saved.releaseSource !== undefined && saved.releaseSource !== prepared.releaseSource)
      || !ownsRelease(release, saved.source, saved.integrity)) continue;
    assert.equal(basename(saved.filename), saved.filename);
    const tarball = release.assets.find((asset) => asset.name === saved.filename);
    assert.ok(tarball, "Saved release candidate tarball is missing");
    gh(["release", "download", release.tag_name, "--repo", repository, "--pattern", saved.filename, "--dir", directory]);
    assert.equal(tarball.digest, `sha256:${sha256(join(directory, saved.filename))}`, "Saved release tarball checksum differs from GitHub");
    cpSync(receiptPath, join(directory, "release.json"));
    writeFileSync(join(directory, "release-notes.md"), `${saved.notes}\n`);
    const candidate = verifyArtifact(directory, env, false, true);
    console.log(`Recovered the originally verified ${candidate.name}@${candidate.version} tarball from its draft release`);
    return { candidate, directory };
  }
  return null;
}

async function publish() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Publication only runs in GitHub Actions");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main", "Publication only runs from main");
  assert.equal(process.env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/npm-release.yml@refs/heads/main`, "Unexpected trusted publisher caller");
  assert.ok(!entry.releaseQualification || values.qualification, `${repository} requires its package-specific exact-candidate release qualification before automatic publication`);
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && process.env.ACTIONS_ID_TOKEN_REQUEST_URL, "OIDC permission is missing");
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/, "Missing GitHub run identity");
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/, "Missing GitHub run attempt");
  values["release-source"] ||= values["source-ref"];
  assert.ok(values.artifact && values.fork && values["source-ref"] && values["release-source"], "publish requires --artifact, --fork, --source-ref and --release-source");
  assert.match(values["official-version"] ?? "", /^\d+\.\d+\.\d+$/, "publish requires exact --official-version from this run's planner");
  assert.match(values["fork-ref"] ?? "", /^[a-f0-9]{40}$/, "publish requires exact --fork-ref from this run's planner");
  const directory = resolve(values.artifact);
  const root = mkdtempSync("/tmp/npm-publish-");
  const env = isolatedEnvironment(root);
  try {
    const candidate = verifyArtifact(directory, env);
    assert.equal(process.env.GITHUB_SHA, candidate.source, "Caller commit differs from the verified artifact");
    const forkDirectory = resolve(values.fork);
    const forkReceipt = verifyFork(forkDirectory, candidate);
    const runnerEnv = { ...env };
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith("GITHUB_") || name.startsWith("ACTIONS_ID_TOKEN_REQUEST_")) runnerEnv[name] = value;
    }
    const githubEnv = { ...runnerEnv, GH_TOKEN: process.env.GH_TOKEN };
    const gh = (args, options = {}) => run("gh", args, { cwd: root, env: githubEnv, quiet: true, ...options });
    const api = (path, body) => JSON.parse(gh(["api", `repos/${repository}/${path}`, ...(body ? ["--method", "POST", "--input", "-"] : [])], body ? { input: JSON.stringify(body) } : {}));
    if (values.qualification) verifyQualification(resolve(values.qualification), directory, candidate, gh);
    const environment = api("environments/npm");
    assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true, "npm environment must restrict publication to main");
    const branches = api("environments/npm/deployment-branch-policies").branch_policies;
    assert.deepEqual(branches.map(({ name, type }) => ({ name, type })), [{ name: "main", type: "branch" }], "npm environment permits an unexpected branch or tag");
    if (candidate.approval) {
      assert.ok(environment.protection_rules.some((rule) => rule.type === "required_reviewers" && rule.reviewers.some((reviewer) => reviewer.reviewer.login === "fitchmultz")), "Required maintainer release approval was removed");
    }
    const tag = `v${candidate.version}`;
    const releases = JSON.parse(gh(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"])).flat();
    let release = releases.find((item) => item.tag_name === tag);
    if (release) assert.ok(ownsRelease(release, candidate.source, candidate.integrity), "Existing GitHub release is not this exact automation candidate; leave it untouched");
    const data = await metadata(candidate.name);
    const existing = data?.versions[candidate.version];
    if (existing) assert.equal(existing.dist.integrity, candidate.integrity, "This version was published with different bytes; never overwrite it");
    else {
      const comparison = api(`compare/${candidate.source}...main`);
      assert.ok(["ahead", "identical"].includes(comparison.status), "Release source is no longer an ancestor of main");
      if (data) assert.ok(newer(candidate.version, data["dist-tags"].latest), "Refusing to move latest backwards");
    }
    const refs = api(`git/matching-refs/tags/${tag}`);
    const ref = refs.find((item) => item.ref === `refs/tags/${tag}`);
    if (ref) {
      let object = ref.object;
      while (object.type === "tag") object = api(`git/tags/${object.sha}`).object;
      assert.equal(object.type, "commit");
      assert.equal(object.sha, candidate.source, "Existing release tag points to a different commit");
    }
    const npmEnv = { ...runnerEnv };
    if (!data) {
      assert.ok(process.env.NPM_BOOTSTRAP_TOKEN?.trim(), "First owned scoped publication requires NPM_BOOTSTRAP_TOKEN before creating a tag or release");
      // ponytail: direct-token first publication is supported only until January 2027; recheck npm's native first-publish path then.
      npmEnv.npm_config_userconfig = join(root, "bootstrap.npmrc");
      writeFileSync(npmEnv.npm_config_userconfig, "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n", { mode: 0o600 });
      npmEnv.NODE_AUTH_TOKEN = process.env.NPM_BOOTSTRAP_TOKEN;
      assert.equal(run("npm", ["whoami", `--registry=${registry}`], { cwd: root, env: npmEnv, quiet: true }).trim(),
        "fitchmultz", "Bootstrap publication must authenticate as fitchmultz");
    }
    const forkArchive = join(root, "fork-host.tgz");
    run("tar", ["-czf", forkArchive, "-C", forkDirectory, "receipt.json", "manifest.json",
      ...Object.keys(forkReceipt.installFiles), ...forkReceipt.packages.map((pkg) => pkg.file)], { cwd: root, env, quiet: true });
    const forkAsset = `fork-host-${sha256(forkArchive)}.tgz`;
    cpSync(forkArchive, join(root, forkAsset));
    if (!ref) {
      const object = api("git/tags", { tag, message: `${candidate.name} ${candidate.version}`, object: candidate.source, type: "commit" });
      api("git/refs", { ref: `refs/tags/${tag}`, sha: object.sha });
    }
    if (!release) {
      release = api("releases", { tag_name: tag, name: `${candidate.name} ${candidate.version}`, draft: true,
        body: `${candidate.notes}\n\n${sourceMarker(candidate.releaseSource ?? candidate.source)}\n<!-- pi-npm-release: ${candidate.source} ${candidate.integrity} -->\n\n[Release verification](https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID})\n` });
    }
    const receipt = `verification-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`;
    cpSync(join(directory, "release.json"), join(root, receipt));
    const qualification = values.qualification && `qualification-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`;
    if (qualification) cpSync(resolve(values.qualification), join(root, qualification));
    for (const file of [candidate.filename, receipt, forkAsset, ...(qualification ? [qualification] : [])]) {
      const path = file === candidate.filename ? join(directory, file) : join(root, file);
      const asset = release.assets.find((item) => item.name === file);
      if (asset) {
        assert.equal(asset.digest, `sha256:${sha256(path)}`, `Existing GitHub release asset differs: ${file}`);
      } else {
        gh(["release", "upload", tag, path, "--repo", repository]);
      }
    }
    if (!existing) run("npm", ["publish", join(directory, candidate.filename), "--ignore-scripts", `--registry=${registry}`, "--access=public", "--tag=latest", "--provenance"], { cwd: root, env: { ...npmEnv, RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT } });
    await verifyPublication(candidate);
    if (release.draft) gh(["release", "edit", tag, "--repo", repository, "--draft=false"]);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Released\n\n[${candidate.name}@${candidate.version}](https://www.npmjs.com/package/${candidate.name}/v/${candidate.version}) — [GitHub release](https://github.com/${repository}/releases/tag/${tag})\n\nExact registry integrity matches the tested tarball.\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  if (values.help) {
    console.log(`Usage: node scripts/npm-release.mjs <plan|select|prepare|verify|qualify|publish> [options]

Options:
  --repository OWNER/REPO    Owned channel (defaults to GITHUB_REPOSITORY)
  --source PATH              Clean source checkout for plan/select/prepare
  --source-ref SHA           Exact caller commit
  --release-source SHA       Original main commit covered by the version (defaults to source-ref)
  --fork PATH                Verified fork host artifact directory
  --official-version X.Y.Z   Frozen official host identity
  --fork-ref SHA             Frozen fork host identity
  --output PATH              Output directory for select/prepare/qualify
  --artifact PATH            Candidate directory for verify/qualify/publish
  --recovered PATH           Draft candidate selected before preparation
  --recovered-sha256 HASH    Selected draft tarball checksum
  --recovered-receipt-sha256 HASH  Selected draft receipt checksum
  --qualification PATH       Same-run qualification.json for publish
  -h, --help                 Show this help

plan and select are read-only; select needs GitHub access to drafts. prepare builds or requalifies the selected tarball without publication credentials. qualify writes a run-bound receipt after package gates. publish runs only in GitHub Actions and creates npm/GitHub releases. Existing packages use OIDC only; an absent enabled @fitchmultz/REPO requires NPM_BOOTSTRAP_TOKEN for its first publication.
Exit codes: 0 = success, 1 = invalid input, failed gate, or release failure.`);
  } else {
    assert.equal(positionals.length, 1, "Choose plan, select, prepare, verify, qualify, or publish; use --help");
    assert.ok(entry?.npmRelease, "Repository has no enabled npm release channel");
    values["release-source"] ||= values["source-ref"];
    if (command === "plan") await plan();
    else if (command === "select") await select();
    else if (command === "prepare") await prepare();
    else if (command === "verify") { assert.ok(values.artifact && values["source-ref"], "verify requires --artifact and --source-ref"); verifyArtifact(resolve(values.artifact)); }
    else if (command === "qualify") qualify();
    else if (command === "publish") await publish();
    else throw new Error("Unknown command; use --help");
  }
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
