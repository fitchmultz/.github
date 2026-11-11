import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { readJson, run, stageSource } from "./common.mjs";
import { selectDevelopmentHost } from "./hosts.mjs";
import { releaseFetch } from "./release-fetch.mjs";

// The lifecycle scripts npm runs for an installed package ("npm ci", "npm install" and "npm rebuild" in npm's scripts
// reference). npm runs every other script only for a command given in the package's own directory.
const installScripts = new Set(["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]);

// Pending release-note fragment path under changelog.d/ (excluding README.md).
export function changelogFragment(path) {
  return /^changelog\.d\/[^/]+\.md$/.test(path) && !/^changelog\.d\/readme\.md$/i.test(path);
}

/**
 * Stages `source`, a clean checkout of the commit to release, in `development` and builds it the way every release
 * candidate is built: imports and types resolve from the prepared `official` host, and the locked dependencies
 * that `npm pack` bundles are installed after the build. Package commands receive only `env`.
 */
export function buildPackage(source, development, official, env) {
  stageSource(source, development);
  if (existsSync(join(development, ".npmrc"))) {
    assert.ok(!/auth|password|username|token|otp|certfile|keyfile/i.test(readFileSync(join(development, ".npmrc"), "utf8")), "Project npm configuration must not contain credentials");
  }
  run("npm", ["ci", "--ignore-scripts", "--dry-run"], { cwd: development, env });
  selectDevelopmentHost(development, official, env);
  run("npm", ["run", "build", "--if-present"], { cwd: development, env });
  // Pack reviewed bundled dependencies, retaining the output compiled against the selected latest SDK.
  run("npm", ["ci", "--ignore-scripts"], { cwd: development, env });
}

/** Packs the built `development` directory into `destination` and returns npm's record of the one tarball. */
export function packPackage(development, destination, env) {
  const packedJson = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: development, env, quiet: true }));
  const packed = Array.isArray(packedJson) ? packedJson : Object.values(packedJson);
  assert.equal(packed.length, 1);
  assert.equal(basename(packed[0].filename), packed[0].filename);
  for (const file of packed[0].files) {
    assert.ok(!/(^|\/)(\.git|\.pi|\.env[^/]*|\.npmrc|\.artifacts|\.debug|\.dogfood|\.DS_Store)(\/|$)/.test(file.path), `Private/repository state in tarball: ${file.path}`);
  }
  return packed[0];
}

/**
 * Downloads the tarball of `published`, one version's registry metadata, into `directory` and returns its path.
 * The bytes must match the integrity the registry records for that version.
 */
export async function publishedTarball(published, directory) {
  const { tarball, integrity } = published?.dist ?? {};
  assert.ok(typeof tarball === "string" && typeof integrity === "string" && integrity.startsWith("sha512-"),
    "Published version has no tarball URL with a sha512 integrity");
  const response = await releaseFetch("npm", tarball);
  assert.ok(response.ok, `Published tarball: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, integrity, "Published tarball differs from its registry integrity");
  const file = join(directory, "published.tgz");
  writeFileSync(file, bytes);
  return file;
}

// Each packed file's path within the package, mapped to where it was extracted.
function packedFiles(tarball, directory, env) {
  mkdirSync(directory, { recursive: true });
  run("tar", ["-xzf", basename(tarball), "-C", directory], { cwd: dirname(tarball), env, quiet: true });
  const root = join(directory, "package");
  assert.ok(existsSync(root), "Tarball has no package directory");
  return new Map(readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return [relative(root, file).split(sep).join("/"), file];
    }));
}

// The manifest as an installation sees it. npm installs devDependencies only from a package's own root, and Pi
// reads neither them nor scripts from an installed package.
function installedManifest(file) {
  const manifest = readJson(file);
  delete manifest.version;
  delete manifest.devDependencies;
  if (manifest.scripts && typeof manifest.scripts === "object") {
    manifest.scripts = Object.fromEntries(Object.entries(manifest.scripts).filter(([name]) => installScripts.has(name)));
    if (!Object.keys(manifest.scripts).length) delete manifest.scripts;
  }
  return JSON.stringify(manifest);
}

function sameFile(candidate, published) {
  const [left, right] = [lstatSync(candidate), lstatSync(published)];
  return left.isFile() && right.isFile() && (left.mode & 0o111) === (right.mode & 0o111)
    && readFileSync(candidate).equals(readFileSync(published));
}

/**
 * Names the first packed file that differs between the `candidate` and `published` tarballs, or returns null when
 * an installation of either is the same package: every file has the same bytes and executable bits, apart from
 * `CHANGELOG.md`, `changelog.d/` and the manifest fields no installation uses (`version`, `devDependencies` and the
 * scripts npm runs only in the package's own directory). Both tarballs are extracted beneath `directory`.
 */
export function packageDifference(candidate, published, directory, env) {
  const built = packedFiles(candidate, join(directory, "candidate"), env);
  const released = packedFiles(published, join(directory, "published"), env);
  for (const path of [...new Set([...built.keys(), ...released.keys()])].sort()) {
    if (path === "CHANGELOG.md" || path.startsWith("changelog.d/")) continue;
    const [now, before] = [built.get(path), released.get(path)];
    if (!now || !before) return `${path} is ${now ? "new" : "no longer packed"}`;
    if (path === "package.json" ? installedManifest(now) !== installedManifest(before) : !sameFile(now, before)) return `${path} differs`;
  }
  return null;
}
