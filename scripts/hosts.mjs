import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as modules from "node:module";
import { pathToFileURL } from "node:url";
import {
  codingAgent,
  githubHeaders,
  isRecord,
  readArray,
  readJson,
  readMatch,
  readRecord,
  run,
  sha256,
  writeJson,
} from "./common.mjs";
import { officialInstaller, officialRelease } from "./official-release.mjs";

export { officialRelease };

/**
 * Identity of one installed SDK/CLI graph.
 * @typedef {object} HostIdentity
 * @property {string} directory
 * @property {string} packageDir
 * @property {Record<string, string>} packageDirs
 * @property {string} version
 * @property {string} index
 * @property {string} cli
 * @property {string} indexSha256
 * @property {string} cliSha256
 * @property {Record<string, string>} cohort
 * @property {{ typebox: unknown }} companions
 * @property {string} runtimeLockSha256
 * @property {string} runtimeGraphSha256
 */

/** @returns {Promise<string>} */
async function maintainedForkMain() {
  const response = await fetch("https://api.github.com/repos/fitchmultz/pi/commits/main", {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `GitHub maintained fork: HTTP ${response.status}`);
  const commit = await response.json();
  return readMatch(
    isRecord(commit) ? commit.sha : undefined,
    /^[a-f0-9]{40}$/,
    "Fork host must be pinned to a full commit SHA",
  );
}

/**
 * @param {{ host?: string | undefined, officialVersion?: string | undefined, forkRef?: string | undefined }} [targets]
 * @returns {Promise<{ officialVersion: string, forkRef: string }>}
 */
export async function resolveHostTargets({
  host = "both",
  officialVersion = "latest",
  forkRef,
} = {}) {
  assert.ok(["both", "fork"].includes(host), "Host must be both or fork");
  const ref =
    forkRef !== undefined && forkRef !== ""
      ? readMatch(forkRef, /^[a-f0-9]{40}$/, "Fork host must be pinned to a full commit SHA")
      : await maintainedForkMain();
  const official = officialVersion === "" ? "latest" : officialVersion;
  return {
    officialVersion: host === "both" ? (await officialRelease(official)).version : "",
    forkRef: ref,
  };
}

/**
 * Pi package versions in an `npm ls --all --json` dependency tree, in traversal order.
 * @param {unknown} [dependencies]
 * @returns {Generator<[string, string], void, undefined>}
 */
function* cohortVersions(dependencies = {}) {
  for (const [name, value] of Object.entries(
    readRecord(dependencies, "Invalid npm dependency tree"),
  )) {
    const dependency = readRecord(value, `Invalid npm dependency tree: ${name}`);
    const { version } = dependency;
    if (name.startsWith("@earendil-works/") && version !== undefined) {
      assert.ok(
        typeof version === "string" && version !== "",
        `Invalid npm dependency tree: ${name}`,
      );
      yield [name, version];
    }
    yield* cohortVersions(dependency.dependencies);
  }
}

/**
 * Entry names, file contents and symlink targets beneath `root`, in the order hashed into the
 * runtime graph identity.
 * @param {string} root
 * @param {string} [prefix]
 * @returns {Generator<string | Buffer, void, undefined>}
 */
function* graphEntries(root, prefix = "") {
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(root, entry.name);
    yield `${prefix}${entry.name}\0`;
    if (entry.isDirectory()) {
      yield* graphEntries(path, `${prefix}${entry.name}/`);
    } else {
      yield entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
    }
    yield "\0";
  }
}

/**
 * @param {string} directory
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {HostIdentity}
 */
export function hostIdentity(directory, env = process.env) {
  const packageDir = realpathSync.native(join(directory, "node_modules", codingAgent));
  const root = resolve(packageDir, "../../..");
  const message = `Invalid package manifest: ${packageDir}`;
  const manifest = readRecord(readJson(join(packageDir, "package.json")), message);
  const { bin, version } = manifest;
  assert.ok(isRecord(bin) && typeof bin.pi === "string" && typeof version === "string", message);
  const index = join(packageDir, "dist", "index.js");
  const cli = join(packageDir, bin.pi);
  /** @type {unknown} */
  const tree = JSON.parse(run("npm", ["ls", "--all", "--json"], { cwd: root, env, quiet: true }));
  /** @type {Record<string, string>} */
  const cohort = {};
  const dependencies = readRecord(tree, "Invalid npm dependency tree").dependencies;
  for (const [name, member] of cohortVersions(dependencies)) {
    const previous = cohort[name];
    if (previous !== undefined) {
      assert.equal(previous, member, `Mixed host versions of ${name}`);
    }
    cohort[name] = member;
  }
  const typeboxManifest = modules.findPackageJSON("typebox", pathToFileURL(index));
  assert.ok(typeboxManifest !== undefined, `Host does not supply typebox: ${root}`);
  const typebox = readRecord(
    readJson(typeboxManifest),
    `Invalid package manifest: ${typeboxManifest}`,
  );
  const companions = { typebox: typebox.version };
  /** @type {Record<string, string>} */
  const packageDirs = {};
  for (const name of Object.keys(cohort)) {
    packageDirs[name] = realpathSync.native(join(root, "node_modules", name));
  }
  packageDirs.typebox = realpathSync.native(dirname(typeboxManifest));
  const graph = createHash("sha256");
  for (const chunk of graphEntries(join(root, "node_modules"))) {
    graph.update(chunk);
  }
  return {
    directory: root,
    packageDir,
    packageDirs,
    version,
    index,
    cli,
    indexSha256: sha256(index),
    cliSha256: sha256(cli),
    cohort,
    companions,
    runtimeLockSha256: sha256(join(root, "package-lock.json")),
    runtimeGraphSha256: graph.digest("hex"),
  };
}

const forkInstallFiles = new Set([
  "package.json",
  "package-lock.json",
  "install-lock/package.json",
  "install-lock/package-lock.json",
]);

/**
 * @param {string} target
 * @param {Record<string, unknown>} pkg
 * @param {readonly unknown[]} artifacts
 */
function verifyForkPackage(target, pkg, artifacts) {
  const { file, name } = pkg;
  assert.ok(typeof file === "string" && typeof name === "string", "Invalid fork artifact receipt");
  const tarball = resolve(target, file);
  assert.match(
    file,
    /^tarballs\/[^/\\]+\.tgz$/,
    "Fork archive must stay in its artifact directory",
  );
  assert.equal(sha256(tarball), pkg.sha256, `Changed fork artifact: ${name}`);
  assert.deepEqual(
    artifacts.find((artifact) => isRecord(artifact) && artifact.name === name),
    { name, version: pkg.version, tarball: file, integrity: pkg.integrity },
    "Fork receipt differs from native artifact identity",
  );
  assert.equal(
    `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
    pkg.integrity,
  );
}

/**
 * @param {string} target
 * @returns {Record<string, unknown>}
 */
export function verifyForkArtifact(target) {
  const receipt = readRecord(
    readJson(join(target, "receipt.json")),
    "Invalid fork artifact receipt",
  );
  const ref = readMatch(receipt.ref, /^[a-f0-9]{40}$/);
  assert.equal(
    sha256(join(target, "manifest.json")),
    receipt.artifactManifestSha256,
    "Changed fork artifact manifest",
  );
  const artifacts = readRecord(
    readJson(join(target, "manifest.json")),
    "Invalid fork artifact manifest",
  );
  assert.deepEqual(
    artifacts.source,
    { commit: ref, dirty: false },
    "Fork artifacts do not identify the exact clean source",
  );
  const installFiles = readRecord(
    receipt.installFiles,
    "Fork artifact must carry source and consumer installer inputs",
  );
  for (const [file, hash] of Object.entries(installFiles)) {
    assert.ok(forkInstallFiles.has(file), "Unexpected fork install input");
    assert.equal(sha256(join(target, file)), hash, `Changed fork install input: ${file}`);
  }
  assert.equal(
    Object.keys(installFiles).length,
    4,
    "Fork artifact must carry source and consumer installer inputs",
  );
  const packages = readArray(receipt.packages, "Invalid fork artifact receipt").map((pkg) =>
    readRecord(pkg, "Invalid fork artifact receipt"),
  );
  const artifactPackages = readArray(artifacts.packages, "Invalid fork artifact manifest");
  for (const pkg of packages) {
    verifyForkPackage(target, pkg, artifactPackages);
  }
  assert.equal(artifactPackages.length, packages.length);
  assert.ok(
    packages.some((pkg) => pkg.name === codingAgent),
    "Fork artifact does not contain coding-agent",
  );
  return receipt;
}

/**
 * @param {string} directory
 * @param {NodeJS.ProcessEnv} env
 * @returns {HostIdentity}
 */
function installHost(directory, env) {
  run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--include=optional"], {
    cwd: directory,
    env,
  });
  return hostIdentity(directory, env);
}

/**
 * Installs the exact official release or verified fork artifact `target` in `directory`.
 * @param {string} directory
 * @param {"official" | "fork"} flavor
 * @param {string} target
 * @param {NodeJS.ProcessEnv} env
 */
export async function prepareHost(directory, flavor, target, env) {
  mkdirSync(directory, { recursive: true });
  if (flavor === "official") {
    const release = await officialRelease(target);
    const installer = await officialInstaller(release);
    const provenance = { ...release, installer: installer.provenance };
    writeJson(join(directory, "package.json"), installer.manifest);
    writeJson(join(directory, "package-lock.json"), installer.lock);
    const identity = installHost(directory, env);
    assert.equal(identity.version, provenance.version);
    assert.deepEqual(
      identity.cohort,
      provenance.cohort,
      "Installed official cohort differs from the resolved release",
    );
    const lock = readRecord(
      readJson(join(directory, "package-lock.json")),
      "Invalid installed lock",
    );
    const installed = readRecord(lock.packages, "Invalid installed lock")[
      `node_modules/${codingAgent}`
    ];
    assert.equal(readRecord(installed, "Invalid installed lock").integrity, provenance.integrity);
    return { flavor, ...identity, provenance };
  }
  assert.equal(flavor, "fork");
  const provenance = verifyForkArtifact(target);
  cpSync(target, directory, { recursive: true });
  return { flavor, ...installHost(directory, env), provenance };
}

/** @type {readonly (keyof HostIdentity)[]} */
const preservedIdentity = [
  "directory",
  "packageDir",
  "packageDirs",
  "runtimeLockSha256",
  "runtimeGraphSha256",
];

/** @param {string} name */
const suppliedByHost = (name) => name.startsWith("@earendil-works/") || name === "typebox";

/**
 * @param {unknown} overrides
 * @param {Record<string, string>} specifiers
 * @returns {Record<string, unknown>}
 */
function hostOverrides(overrides, specifiers) {
  const names = Object.keys(specifiers);
  const retained = Object.entries(
    readRecord(overrides ?? {}, "Invalid development overrides"),
  ).filter(([key]) => !names.some((name) => key.startsWith(`${name}@`)));
  return { ...Object.fromEntries(retained), ...specifiers };
}

/**
 * Points the development manifest's Pi and typebox dependencies at the selected host.
 * @param {string} file
 * @param {Record<string, string>} specifiers
 */
function writeDevelopmentManifest(file, specifiers) {
  const message = `Invalid development manifest: ${file}`;
  const manifest = readRecord(readJson(file), message);
  manifest.devDependencies ??= {};
  const dependencies = readRecord(manifest.dependencies ?? {}, message);
  const devDependencies = readRecord(manifest.devDependencies, message);
  const optionalDependencies = readRecord(manifest.optionalDependencies ?? {}, message);
  for (const group of [dependencies, devDependencies, optionalDependencies]) {
    for (const name of Object.keys(group).filter(suppliedByHost)) {
      const specifier = specifiers[name];
      assert.ok(specifier !== undefined, `Selected host does not supply ${name}`);
      group[name] = specifier;
    }
  }
  for (const [name, specifier] of Object.entries(specifiers)) {
    if (dependencies[name] === undefined && optionalDependencies[name] === undefined) {
      devDependencies[name] = specifier;
    }
  }
  // Exact development overrides must not conflict with the selected host's file: dependencies.
  manifest.overrides = hostOverrides(manifest.overrides, specifiers);
  writeJson(file, manifest);
}

/**
 * Resolves the development checkout's imports and types from the prepared host graph.
 * @param {string} directory
 * @param {HostIdentity} host
 * @param {NodeJS.ProcessEnv} env
 * @returns {HostIdentity}
 */
export function selectDevelopmentHost(directory, host, env) {
  const file = join(directory, "package.json");
  const original = readFileSync(file);
  const lockFile = join(directory, "package-lock.json");
  const originalLock = existsSync(lockFile) ? readFileSync(lockFile) : null;
  /** @type {Record<string, string>} */
  const specifiers = {};
  for (const [name, path] of Object.entries(host.packageDirs)) {
    specifiers[name] = `file:${path.replaceAll("\\", "/")}`;
  }
  writeDevelopmentManifest(file, specifiers);
  try {
    // npm links external directories without installing their dependencies. Keep the host's physical graph.
    run("npm", ["install", "--ignore-scripts", "--install-links=false"], { cwd: directory, env });
    const selected = hostIdentity(directory, env);
    for (const key of preservedIdentity) {
      assert.deepEqual(
        selected[key],
        host[key],
        `Development selection changed the prepared host's ${key}`,
      );
    }
    for (const [name, path] of Object.entries(host.packageDirs)) {
      assert.equal(
        realpathSync.native(join(directory, "node_modules", name)),
        path,
        `Development imports resolved a different ${name}`,
      );
    }
    return selected;
  } finally {
    // Test distribution metadata unchanged while imports/types use the selected installed graph.
    writeFileSync(file, original);
    if (originalLock) {
      writeFileSync(lockFile, originalLock);
    } else {
      rmSync(lockFile, { force: true });
    }
  }
}
