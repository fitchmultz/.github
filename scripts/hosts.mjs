import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as modules from "node:module";
import { pathToFileURL } from "node:url";
import { codingAgent, readJson, run, sha256, writeJson } from "./common.mjs";

export async function officialRelease(version = "latest") {
  assert.match(version, /^(latest|\d+\.\d+\.\d+)$/, "Use an exact stable Pi version or latest");
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(codingAgent)}/${version}`);
  if (!response.ok) throw new Error(`Official Pi metadata: HTTP ${response.status}`);
  const metadata = await response.json();
  assert.equal(metadata.name, codingAgent);
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  assert.ok(metadata.dist?.integrity && metadata.dist?.tarball, "Missing npm provenance");
  // Pi publishes its workspace cohort together. Check publication before scheduling consumers,
  // and pin the cohort so a later caret-compatible package cannot change this host's identity.
  const cohort = { [codingAgent]: metadata.version };
  const packages = { [codingAgent]: metadata };
  const pending = [metadata];
  for (const pkg of pending) {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (!name.startsWith("@earendil-works/") || cohort[name]) continue;
      const dependency = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${metadata.version}`);
      assert.ok(dependency.ok, `Pi ${metadata.version} cohort is not fully published: ${name} (HTTP ${dependency.status})`);
      const published = await dependency.json();
      assert.equal(published.name, name);
      assert.equal(published.version, metadata.version, `Unexpected cohort release: ${name}`);
      assert.ok(published.dist?.integrity, `Missing cohort integrity: ${name}`);
      cohort[name] = published.version;
      packages[name] = published;
      pending.push(published);
    }
  }
  return { version: metadata.version, integrity: metadata.dist.integrity, tarball: metadata.dist.tarball, gitHead: metadata.gitHead, cohort, packages };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function officialInstaller(release) {
  const api = "https://api.github.com/repos/earendil-works/pi";
  const tag = `v${release.version}`;
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  async function get(url, authenticated = false) {
    const response = await fetch(url, { headers: authenticated ? headers : {}, signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `Official installer input: ${url} (HTTP ${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  const [publication, ref] = await Promise.all([
    get(`${api}/releases/tags/${tag}`, true).then((bytes) => JSON.parse(bytes)),
    get(`${api}/git/ref/tags/${tag}`, true).then((bytes) => JSON.parse(bytes)),
  ]);
  assert.equal(publication.tag_name, tag);
  assert.equal(publication.draft, false);
  assert.equal(publication.prerelease, false);
  let object = ref.object;
  if (object.type === "tag") object = JSON.parse(await get(`${api}/git/tags/${object.sha}`, true)).object;
  assert.equal(object.type, "commit", "Official release tag must identify a source commit");
  assert.match(object.sha, /^[a-f0-9]{40}$/);
  const names = ["pi-coding-agent-install-package.json", "pi-coding-agent-install-package-lock.json", "SHA256SUMS"];
  const assets = await Promise.all(names.map(async (name) => {
    const matches = publication.assets.filter((asset) => asset.name === name);
    assert.equal(matches.length, 1, `Missing/ambiguous official installer asset: ${name}`);
    const asset = matches[0];
    assert.equal(asset.browser_download_url, `https://github.com/earendil-works/pi/releases/download/${tag}/${name}`);
    const bytes = await get(asset.browser_download_url);
    assert.equal(asset.digest, `sha256:${digest(bytes)}`, `Changed official installer asset: ${name}`);
    return bytes;
  }));
  const sums = assets[2].toString("utf8").trim().split("\n");
  for (let index = 0; index < 2; index++) {
    assert.ok(sums.includes(`${digest(assets[index])}  ${names[index]}`), `Official SHA256SUMS mismatch: ${names[index]}`);
    const source = await get(`https://raw.githubusercontent.com/earendil-works/pi/${object.sha}/packages/coding-agent/install-lock/${index ? "package-lock.json" : "package.json"}`);
    assert.equal(digest(source), digest(assets[index]), "Official installer differs from its release's source lock");
  }
  const manifest = JSON.parse(assets[0]);
  const lock = JSON.parse(assets[1]);
  assert.equal(manifest.name, `${codingAgent}-install`);
  assert.equal(manifest.version, release.version);
  assert.deepEqual(manifest.dependencies, { [codingAgent]: release.version });
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[""].version, release.version);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  const cohort = {};
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    const name = path.split("node_modules/").at(-1);
    const published = release.packages[name];
    if (name.startsWith("@earendil-works/")) {
      assert.ok(published, `Official lock contains an unpublished cohort member: ${name}`);
      assert.equal(entry.version, release.version, `Official lock version mismatch: ${name}`);
      assert.equal(entry.resolved, published.dist.tarball, `Official lock artifact mismatch: ${name}`);
      for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "bin"]) {
        assert.deepEqual(entry[key] ?? {}, published[key] ?? {}, `Official lock declaration mismatch: ${name}/${key}`);
      }
      if (entry.integrity) assert.equal(entry.integrity, published.dist.integrity, `Official lock integrity mismatch: ${name}`);
      // The vendor generates its lock before publishing Pi. Fill only the now-published Pi SRIs.
      entry.integrity = published.dist.integrity;
      cohort[name] = entry.version;
    }
    assert.ok(entry.integrity && entry.resolved?.startsWith("https://registry.npmjs.org/"), `Unfrozen official runtime package: ${path}`);
  }
  assert.deepEqual(cohort, release.cohort, "Official installer cohort differs from the resolved release");
  return { manifest, lock, provenance: {
    sourceRef: object.sha, releaseUrl: publication.html_url,
    manifestSha256: digest(assets[0]), lockSha256: digest(assets[1]), sumsSha256: digest(assets[2]),
  } };
}

export async function resolveHostTargets({ host = "both", officialVersion = "latest", forkRef } = {}) {
  assert.ok(["both", "fork"].includes(host), "Host must be both or fork");
  if (forkRef) assert.match(forkRef, /^[a-f0-9]{40}$/, "Fork host must be pinned to a full commit SHA");
  else {
    const headers = { Accept: "application/vnd.github+json" };
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    const response = await fetch("https://api.github.com/repos/fitchmultz/pi/commits/main", { headers, signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `GitHub maintained fork: HTTP ${response.status}`);
    forkRef = (await response.json()).sha;
    assert.match(forkRef, /^[a-f0-9]{40}$/, "Fork host must be pinned to a full commit SHA");
  }
  return { officialVersion: host === "both" ? (await officialRelease(officialVersion || "latest")).version : "", forkRef };
}

export function hostIdentity(directory, env = process.env) {
  const packageDir = realpathSync.native(join(directory, "node_modules", codingAgent));
  directory = resolve(packageDir, "../../..");
  const manifest = readJson(join(packageDir, "package.json"));
  const index = join(packageDir, "dist", "index.js");
  const cli = join(packageDir, manifest.bin.pi);
  const tree = JSON.parse(run("npm", ["ls", "--all", "--json"], { cwd: directory, env, quiet: true }));
  const cohort = {};
  function visit(dependencies = {}) {
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (name.startsWith("@earendil-works/") && dependency.version) {
        if (cohort[name]) assert.equal(cohort[name], dependency.version, `Mixed host versions of ${name}`);
        cohort[name] = dependency.version;
      }
      visit(dependency.dependencies);
    }
  }
  visit(tree.dependencies);
  const typeboxManifest = modules.findPackageJSON("typebox", pathToFileURL(index));
  const companions = { typebox: readJson(typeboxManifest).version };
  const packageDirs = Object.fromEntries(Object.keys(cohort).map((name) => [name, realpathSync.native(join(directory, "node_modules", name))]));
  packageDirs.typebox = realpathSync.native(dirname(typeboxManifest));
  const graph = createHash("sha256");
  function visitFiles(root, prefix = "") {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(root, entry.name);
      graph.update(`${prefix}${entry.name}\0`);
      if (entry.isDirectory()) visitFiles(path, `${prefix}${entry.name}/`);
      else graph.update(entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path));
      graph.update("\0");
    }
  }
  visitFiles(join(directory, "node_modules"));
  return { directory, packageDir, packageDirs, version: manifest.version, index, cli, indexSha256: sha256(index), cliSha256: sha256(cli), cohort, companions,
    runtimeLockSha256: sha256(join(directory, "package-lock.json")), runtimeGraphSha256: graph.digest("hex") };
}

export async function prepareHost(directory, flavor, target, env) {
  mkdirSync(directory, { recursive: true });
  let provenance;
  if (flavor === "official") {
    provenance = await officialRelease(target);
    const installer = await officialInstaller(provenance);
    provenance.installer = installer.provenance;
    writeJson(join(directory, "package.json"), installer.manifest);
    writeJson(join(directory, "package-lock.json"), installer.lock);
  } else {
    assert.equal(flavor, "fork");
    const receipt = readJson(join(target, "receipt.json"));
    assert.match(receipt.ref, /^[a-f0-9]{40}$/);
    assert.equal(sha256(join(target, "manifest.json")), receipt.artifactManifestSha256, "Changed fork artifact manifest");
    const artifacts = readJson(join(target, "manifest.json"));
    assert.deepEqual(artifacts.source, { commit: receipt.ref, dirty: false }, "Fork artifacts do not identify the exact clean source");
    for (const [file, hash] of Object.entries(receipt.installFiles)) {
      assert.ok(["package.json", "package-lock.json", "install-lock/package.json", "install-lock/package-lock.json"].includes(file), "Unexpected fork install input");
      assert.equal(sha256(join(target, file)), hash, `Changed fork install input: ${file}`);
    }
    assert.equal(Object.keys(receipt.installFiles).length, 4, "Fork artifact must carry source and consumer installer inputs");
    for (const pkg of receipt.packages) {
      const tarball = resolve(target, pkg.file);
      assert.match(pkg.file, /^tarballs\/[^/\\]+\.tgz$/, "Fork archive must stay in its artifact directory");
      assert.equal(sha256(tarball), pkg.sha256, `Changed fork artifact: ${pkg.name}`);
      assert.deepEqual(artifacts.packages.find((artifact) => artifact.name === pkg.name),
        { name: pkg.name, version: pkg.version, tarball: pkg.file, integrity: pkg.integrity }, "Fork receipt differs from native artifact identity");
      assert.equal(`sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`, pkg.integrity);
    }
    assert.equal(artifacts.packages.length, receipt.packages.length);
    assert.ok(receipt.packages.some((pkg) => pkg.name === codingAgent), "Fork artifact does not contain coding-agent");
    cpSync(target, directory, { recursive: true });
    provenance = receipt;
  }
  run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--include=optional"], { cwd: directory, env });
  const identity = hostIdentity(directory, env);
  if (flavor === "official") {
    assert.equal(identity.version, provenance.version);
    assert.deepEqual(identity.cohort, provenance.cohort, "Installed official cohort differs from the resolved release");
    const lock = readJson(join(directory, "package-lock.json"));
    assert.equal(lock.packages[`node_modules/${codingAgent}`].integrity, provenance.integrity);
  }
  return { flavor, ...identity, provenance };
}

export function selectDevelopmentHost(directory, host, env) {
  const file = join(directory, "package.json");
  const original = readFileSync(file);
  const lockFile = join(directory, "package-lock.json");
  const originalLock = existsSync(lockFile) ? readFileSync(lockFile) : null;
  const manifest = readJson(file);
  const specifiers = Object.fromEntries(Object.entries(host.packageDirs).map(([name, path]) => [name, `file:${path.replaceAll("\\", "/")}`]));
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[group] ?? {})) {
      if (!name.startsWith("@earendil-works/") && name !== "typebox") continue;
      assert.ok(specifiers[name], `Selected host does not supply ${name}`);
      manifest[group][name] = specifiers[name];
    }
  }
  manifest.devDependencies ??= {};
  for (const [name, specifier] of Object.entries(specifiers)) {
    if (!manifest.dependencies?.[name] && !manifest.optionalDependencies?.[name]) manifest.devDependencies[name] = specifier;
  }
  manifest.overrides = { ...manifest.overrides, ...specifiers };
  writeJson(file, manifest);
  try {
    // npm links external directories without installing their dependencies. Keep the host's physical graph.
    run("npm", ["install", "--ignore-scripts", "--install-links=false"], { cwd: directory, env });
    const selected = hostIdentity(directory, env);
    for (const key of ["directory", "packageDir", "packageDirs", "runtimeLockSha256", "runtimeGraphSha256"]) {
      assert.deepEqual(selected[key], host[key], `Development selection changed the prepared host's ${key}`);
    }
    for (const [name, path] of Object.entries(host.packageDirs)) {
      assert.equal(realpathSync.native(join(directory, "node_modules", name)), path, `Development imports resolved a different ${name}`);
    }
    return selected;
  } finally {
    // Test distribution metadata unchanged while imports/types use the selected installed graph.
    writeFileSync(file, original);
    if (originalLock) writeFileSync(lockFile, originalLock);
    else rmSync(lockFile, { force: true });
  }
}
