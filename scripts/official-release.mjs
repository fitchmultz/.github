import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  codingAgent,
  githubHeaders,
  isRecord,
  readArray,
  readMatch,
  readRecord,
} from "./common.mjs";

/**
 * Registry metadata of one published package. Every registry field is retained as provenance.
 * @typedef {Record<string, unknown> & { dist: Record<string, unknown> & { integrity: string } }} PublishedPackage
 */

/**
 * @typedef {object} OfficialRelease
 * @property {string} version
 * @property {string} integrity
 * @property {string} tarball
 * @property {unknown} gitHead
 * @property {Record<string, string>} cohort
 * @property {Record<string, PublishedPackage>} packages
 */

/**
 * @param {Record<string, unknown>} metadata
 * @param {string} message
 * @returns {asserts metadata is PublishedPackage}
 */
function assertPublishedIntegrity(metadata, message) {
  const { dist } = metadata;
  assert.ok(isRecord(dist) && typeof dist.integrity === "string" && dist.integrity !== "", message);
}

/**
 * @param {string} name
 * @param {string} version
 * @returns {Promise<PublishedPackage>}
 */
async function cohortMember(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  assert.ok(
    response.ok,
    `Pi ${version} cohort is not fully published: ${name} (HTTP ${response.status})`,
  );
  const published = readRecord(await response.json(), `Invalid cohort metadata: ${name}`);
  assert.equal(published.name, name);
  assert.equal(published.version, version, `Unexpected cohort release: ${name}`);
  assertPublishedIntegrity(published, `Missing cohort integrity: ${name}`);
  return published;
}

/**
 * @param {string} [version]
 * @returns {Promise<OfficialRelease>}
 */
export async function officialRelease(version = "latest") {
  assert.match(version, /^(latest|\d+\.\d+\.\d+)$/, "Use an exact stable Pi version or latest");
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(codingAgent)}/${version}`,
  );
  if (!response.ok) {
    throw new Error(`Official Pi metadata: HTTP ${response.status}`);
  }
  const metadata = readRecord(await response.json(), "Invalid official Pi metadata");
  assert.equal(metadata.name, codingAgent);
  const release = readMatch(metadata.version, /^\d+\.\d+\.\d+$/);
  const { dist } = metadata;
  assert.ok(
    isRecord(dist) && typeof dist.tarball === "string" && dist.tarball !== "",
    "Missing npm provenance",
  );
  assertPublishedIntegrity(metadata, "Missing npm provenance");
  // Pi publishes its workspace cohort together. Check publication before scheduling consumers,
  // and pin the cohort so a later caret-compatible package cannot change this host's identity.
  /** @type {Record<string, string>} */
  const cohort = { [codingAgent]: release };
  /** @type {Record<string, PublishedPackage>} */
  const packages = { [codingAgent]: metadata };
  const pending = [metadata];
  for (const pkg of pending) {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (!name.startsWith("@earendil-works/") || cohort[name] !== undefined) {
        continue;
      }
      const published = await cohortMember(name, release);
      cohort[name] = release;
      packages[name] = published;
      pending.push(published);
    }
  }
  return {
    version: release,
    integrity: metadata.dist.integrity,
    tarball: dist.tarball,
    gitHead: metadata.gitHead,
    cohort,
    packages,
  };
}

/** @param {Buffer} bytes */
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * @param {Buffer} bytes
 * @returns {unknown}
 */
const parseJson = (bytes) => JSON.parse(bytes.toString("utf8"));

const piApi = "https://api.github.com/repos/earendil-works/pi";
const installerManifestAsset = "pi-coding-agent-install-package.json";
const installerLockAsset = "pi-coding-agent-install-package-lock.json";
const sourceCommitMessage = "Official release tag must identify a source commit";
const cohortDeclarations = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "engines",
  "bin",
];

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<Buffer>}
 */
async function installerInput(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Official installer input: ${url} (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/** @param {unknown} value */
const gitObject = (value) =>
  readRecord(readRecord(value, sourceCommitMessage).object, sourceCommitMessage);

/**
 * Confirms the stable GitHub release of `tag` and resolves the source commit it identifies.
 * @param {string} tag
 * @returns {Promise<{ publication: Record<string, unknown>, sourceRef: string }>}
 */
async function officialPublication(tag) {
  const headers = githubHeaders();
  const [release, ref] = await Promise.all([
    installerInput(`${piApi}/releases/tags/${tag}`, headers).then(parseJson),
    installerInput(`${piApi}/git/ref/tags/${tag}`, headers).then(parseJson),
  ]);
  const publication = readRecord(release, `Invalid official release: ${tag}`);
  assert.equal(publication.tag_name, tag);
  assert.equal(publication.draft, false);
  assert.equal(publication.prerelease, false);
  let object = gitObject(ref);
  if (object.type === "tag") {
    const { sha } = object;
    assert.ok(typeof sha === "string", sourceCommitMessage);
    object = gitObject(parseJson(await installerInput(`${piApi}/git/tags/${sha}`, headers)));
  }
  assert.equal(object.type, "commit", sourceCommitMessage);
  return { publication, sourceRef: readMatch(object.sha, /^[a-f0-9]{40}$/) };
}

/**
 * Downloads one official installer asset after checking its release URL and published digest.
 * @param {readonly Record<string, unknown>[]} assets
 * @param {string} tag
 * @param {string} name
 * @returns {Promise<Buffer>}
 */
async function installerAsset(assets, tag, name) {
  const [asset, ...others] = assets.filter((candidate) => candidate.name === name);
  assert.ok(
    asset !== undefined && others.length === 0,
    `Missing/ambiguous official installer asset: ${name}`,
  );
  const url = `https://github.com/earendil-works/pi/releases/download/${tag}/${name}`;
  assert.equal(asset.browser_download_url, url);
  const bytes = await installerInput(url, {});
  assert.equal(
    asset.digest,
    `sha256:${digest(bytes)}`,
    `Changed official installer asset: ${name}`,
  );
  return bytes;
}

/**
 * Checks one Pi package in the vendor lock against its registry publication and returns the
 * published integrity.
 * @param {Record<string, unknown>} entry
 * @param {string} name
 * @param {OfficialRelease} release
 * @returns {string}
 */
function publishedIntegrity(entry, name, release) {
  const published = release.packages[name];
  assert.ok(published, `Official lock contains an unpublished cohort member: ${name}`);
  assert.equal(entry.version, release.version, `Official lock version mismatch: ${name}`);
  assert.equal(entry.resolved, published.dist.tarball, `Official lock artifact mismatch: ${name}`);
  for (const key of cohortDeclarations) {
    assert.deepEqual(
      entry[key] ?? {},
      published[key] ?? {},
      `Official lock declaration mismatch: ${name}/${key}`,
    );
  }
  if (entry.integrity !== undefined) {
    assert.equal(
      entry.integrity,
      published.dist.integrity,
      `Official lock integrity mismatch: ${name}`,
    );
  }
  return published.dist.integrity;
}

/**
 * Completes the vendor lock with the published Pi integrities and returns its locked Pi cohort.
 * @param {Record<string, unknown>} packages
 * @param {OfficialRelease} release
 * @returns {Record<string, string>}
 */
function freezeOfficialLock(packages, release) {
  /** @type {Record<string, string>} */
  const cohort = {};
  for (const [path, value] of Object.entries(packages)) {
    if (path === "") {
      continue;
    }
    const entry = readRecord(value, `Unfrozen official runtime package: ${path}`);
    const name = path.replace(/^.*node_modules\//, "");
    if (name.startsWith("@earendil-works/")) {
      // The vendor generates its lock before publishing Pi. Fill only the now-published Pi SRIs.
      entry.integrity = publishedIntegrity(entry, name, release);
      cohort[name] = release.version;
    }
    const { integrity, resolved } = entry;
    assert.ok(
      typeof integrity === "string" &&
        integrity !== "" &&
        typeof resolved === "string" &&
        resolved.startsWith("https://registry.npmjs.org/"),
      `Unfrozen official runtime package: ${path}`,
    );
  }
  return cohort;
}

/**
 * Downloads the vendor installer of `release` and verifies its provenance before installation.
 * @param {OfficialRelease} release
 */
export async function officialInstaller(release) {
  const tag = `v${release.version}`;
  const { publication, sourceRef } = await officialPublication(tag);
  const assets = readArray(publication.assets, `Invalid official release: ${tag}`).map((asset) =>
    readRecord(asset, `Invalid official release asset: ${tag}`),
  );
  const [manifestBytes, lockBytes, sumsBytes] = await Promise.all([
    installerAsset(assets, tag, installerManifestAsset),
    installerAsset(assets, tag, installerLockAsset),
    installerAsset(assets, tag, "SHA256SUMS"),
  ]);
  const sums = sumsBytes.toString("utf8").trim().split("\n");
  for (const { asset, bytes, source } of [
    { asset: installerManifestAsset, bytes: manifestBytes, source: "package.json" },
    { asset: installerLockAsset, bytes: lockBytes, source: "package-lock.json" },
  ]) {
    assert.ok(
      sums.includes(`${digest(bytes)}  ${asset}`),
      `Official SHA256SUMS mismatch: ${asset}`,
    );
    const locked = await installerInput(
      `https://raw.githubusercontent.com/earendil-works/pi/${sourceRef}/packages/coding-agent/install-lock/${source}`,
      {},
    );
    assert.equal(
      digest(locked),
      digest(bytes),
      "Official installer differs from its release's source lock",
    );
  }
  const manifest = readRecord(parseJson(manifestBytes), "Invalid official installer manifest");
  const lock = readRecord(parseJson(lockBytes), "Invalid official installer lock");
  assert.equal(manifest.name, `${codingAgent}-install`);
  assert.equal(manifest.version, release.version);
  assert.deepEqual(manifest.dependencies, { [codingAgent]: release.version });
  assert.equal(lock.lockfileVersion, 3);
  const packages = readRecord(lock.packages, "Invalid official installer lock");
  const root = readRecord(packages[""], "Invalid official installer lock");
  assert.equal(root.version, release.version);
  assert.deepEqual(root.dependencies, manifest.dependencies);
  assert.deepEqual(
    freezeOfficialLock(packages, release),
    release.cohort,
    "Official installer cohort differs from the resolved release",
  );
  return {
    manifest,
    lock,
    provenance: {
      sourceRef,
      releaseUrl: publication.html_url,
      manifestSha256: digest(manifestBytes),
      lockSha256: digest(lockBytes),
      sumsSha256: digest(sumsBytes),
    },
  };
}
