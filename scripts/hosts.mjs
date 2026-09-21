import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as modules from "node:module";
import { pathToFileURL } from "node:url";
import { codingAgent, readJson, run, sha256, writeJson } from "./common.mjs";

export async function officialRelease(version = "latest") {
  assert.match(version, /^(latest|\d+\.\d+\.\d+)$/, "Use an exact stable Pi version or latest");
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(codingAgent)}/${version}`);
  if (!response.ok) throw new Error(`Official Pi metadata: HTTP ${response.status}`);
  const metadata = await response.json();
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  assert.ok(metadata.dist?.integrity && metadata.dist?.tarball, "Missing npm provenance");
  // Pi publishes its workspace cohort together. Check publication before scheduling consumers,
  // and pin the cohort so a later caret-compatible package cannot change this host's identity.
  const cohort = { [codingAgent]: metadata.version };
  const pending = [metadata];
  for (const pkg of pending) {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (!name.startsWith("@earendil-works/") || cohort[name]) continue;
      const dependency = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${metadata.version}`);
      assert.ok(dependency.ok, `Pi ${metadata.version} cohort is not fully published: ${name} (HTTP ${dependency.status})`);
      const published = await dependency.json();
      assert.equal(published.version, metadata.version, `Unexpected cohort release: ${name}`);
      assert.ok(published.dist?.integrity, `Missing cohort integrity: ${name}`);
      cohort[name] = published.version;
      pending.push(published);
    }
  }
  return { version: metadata.version, integrity: metadata.dist.integrity, tarball: metadata.dist.tarball, gitHead: metadata.gitHead, cohort };
}

export function hostIdentity(directory, env = process.env) {
  const packageDir = join(directory, "node_modules", codingAgent);
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
  const companions = { typebox: readJson(modules.findPackageJSON("typebox", pathToFileURL(index))).version };
  return { packageDir, version: manifest.version, index, cli, indexSha256: sha256(index), cliSha256: sha256(cli), cohort, companions };
}

export async function prepareHost(directory, flavor, target, env) {
  mkdirSync(directory, { recursive: true });
  let provenance;
  let overrides = {};
  let spec;
  if (flavor === "official") {
    provenance = await officialRelease(target);
    spec = provenance.version;
    overrides = provenance.cohort;
  } else {
    assert.equal(flavor, "fork");
    const receipt = readJson(join(target, "receipt.json"));
    assert.match(receipt.ref, /^[a-f0-9]{40}$/);
    for (const pkg of receipt.packages) {
      const tarball = resolve(target, pkg.file);
      assert.equal(sha256(tarball), pkg.sha256, `Changed fork artifact: ${pkg.name}`);
      overrides[pkg.name] = `file:${tarball.replaceAll("\\", "/")}`;
    }
    spec = overrides[codingAgent];
    assert.ok(spec, "Fork artifact does not contain coding-agent");
    provenance = receipt;
  }
  writeJson(join(directory, "package.json"), { private: true, dependencies: { [codingAgent]: spec }, overrides });
  run("npm", ["install", "--ignore-scripts", "--omit=dev"], { cwd: directory, env });
  const identity = hostIdentity(directory, env);
  if (flavor === "official") {
    assert.equal(identity.version, provenance.version);
    assert.deepEqual(identity.cohort, provenance.cohort, "Installed official cohort differs from the resolved release");
    const lock = readJson(join(directory, "package-lock.json"));
    assert.equal(lock.packages[`node_modules/${codingAgent}`].integrity, provenance.integrity);
    overrides = { ...identity.cohort };
  }
  return { flavor, ...identity, provenance, overrides: { ...overrides, ...identity.companions } };
}

export function selectDevelopmentHost(directory, host, env) {
  const file = join(directory, "package.json");
  const original = readFileSync(file);
  const manifest = readJson(file);
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[group] ?? {})) {
      if (!name.startsWith("@earendil-works/") && name !== "typebox") continue;
      assert.ok(host.overrides[name], `Selected host does not supply ${name}`);
      manifest[group][name] = host.overrides[name];
    }
  }
  manifest.devDependencies ??= {};
  if (!manifest.dependencies?.[codingAgent]) manifest.devDependencies[codingAgent] = host.overrides[codingAgent];
  manifest.overrides = { ...manifest.overrides, ...host.overrides };
  writeJson(file, manifest);
  try {
    run("npm", ["install", "--ignore-scripts", "--package-lock=false"], { cwd: directory, env });
    const selected = hostIdentity(directory, env);
    assert.equal(selected.indexSha256, host.indexSha256, "Tests resolved a different Pi SDK");
    assert.equal(selected.cliSha256, host.cliSha256, "Tests resolved a different Pi CLI");
    assert.deepEqual(selected.companions, host.companions, "Tests resolved different host-provided companions");
    return selected;
  } finally {
    // Test distribution metadata unchanged while imports/types use the selected installed graph.
    writeFileSync(file, original);
  }
}
