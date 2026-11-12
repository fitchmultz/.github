import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/** @import { SpawnSyncOptions } from "node:child_process" */

/**
 * Fleet entry fields read by the shared helpers.
 * @typedef {object} FleetEntry
 * @property {string} repo
 * @property {string} [npmPackage]
 * @property {string} [npmRelease]
 * @property {string} [os]
 * @property {string[]} [nodes]
 * @property {string[]} [extraPlatforms]
 */

/** @typedef {Omit<SpawnSyncOptions, "encoding"> & { quiet?: boolean }} RunOptions */

export const codingAgent = "@earendil-works/pi-coding-agent";
// Default Node floor/current lanes.
export const defaultNodes = ["22.23.5", "24"];
/**
 * @param {string} os
 * @returns {"win32" | "darwin" | "linux"}
 */
export const runnerPlatform = (os) => {
  if (os.startsWith("windows")) {
    return "win32";
  }
  return os.startsWith("macos") ? "darwin" : "linux";
};

/**
 * @param {FleetEntry} entry
 * @returns {{ node: string, os: string }[]}
 */
export function fleetPlatforms(entry) {
  return [
    ...(entry.nodes ?? defaultNodes).map((node) => ({ node, os: entry.os ?? "ubuntu-latest" })),
    ...(entry.extraPlatforms ?? []).map((os) => ({ node: "24", os })),
  ];
}
// An enabled owned scoped channel has no registry entry until its first protected publication.
// The owned scoped name also proves that npmPackage is a non-empty string.
/**
 * @param {FleetEntry | undefined} entry
 * @param {string} [name]
 * @returns {boolean}
 */
export const awaitsFirstPublication = (entry, name = entry?.npmPackage) =>
  entry?.npmPackage !== undefined &&
  name === entry.npmPackage &&
  name === `@fitchmultz/${entry.repo}` &&
  (entry.npmRelease === "automatic" || entry.npmRelease === "approval");
/**
 * @param {string} file
 * @returns {unknown}
 */
export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
/**
 * @param {string} file
 * @param {unknown} value
 */
export const writeJson = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
/** @param {string} file */
export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/**
 * Parsed JSON objects keep unknown field values until each field is checked.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @param {string} message
 * @returns {Record<string, unknown>}
 */
export function readRecord(value, message) {
  assert.ok(isRecord(value), message);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} message
 * @returns {readonly unknown[]}
 */
export function readArray(value, message) {
  assert.ok(Array.isArray(value), message);
  return value;
}

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @param {string} [message]
 * @returns {string}
 */
export function readMatch(value, pattern, message) {
  assert.ok(typeof value === "string", message ?? `Expected a string matching ${String(pattern)}`);
  assert.match(value, pattern, message);
  return value;
}

/**
 * GitHub REST headers, authenticated when GH_TOKEN is set.
 * @returns {Record<string, string>}
 */
export function githubHeaders() {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/vnd.github+json" };
  const token = process.env.GH_TOKEN;
  if (token !== undefined && token !== "") {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * spawnSync leaves stdout/stderr undefined when the process cannot start, although its
 * declarations promise strings.
 * @param {string | null | undefined} text
 * @param {NodeJS.WriteStream} stream
 */
function forwardOutput(text, stream) {
  if (typeof text === "string" && text !== "") {
    stream.write(text);
  }
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {RunOptions} [options]
 * @returns {string}
 */
export function run(command, args, { quiet = false, ...options } = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32" && command === "npm",
    ...options,
  });
  if (!quiet || result.status !== 0) {
    forwardOutput(result.stdout, process.stdout);
    forwardOutput(result.stderr, process.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited ${String(result.status)} (${result.signal ?? "no signal"})`);
  }
  return result.stdout;
}

/**
 * Published `latest` fields that qualification reads; every other registry field is retained.
 * @typedef {Record<string, unknown> & {
 *   version: string,
 *   repository: Record<string, unknown> & { url: string },
 *   dist: Record<string, unknown> & { integrity: string },
 * }} PublishedMetadata
 */

/**
 * @param {unknown} value
 * @returns {value is PublishedMetadata}
 */
function isPublishedMetadata(value) {
  if (!isRecord(value)) {
    return false;
  }
  const { version, repository, dist } = value;
  return (
    typeof version === "string" &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    isRecord(repository) &&
    typeof repository.url === "string" &&
    repository.url.length > 0 &&
    isRecord(dist) &&
    typeof dist.integrity === "string" &&
    dist.integrity.length > 0
  );
}

/**
 * npm 11 prints one package record; npm 12.2.0 prints the same record in a singleton array.
 * @param {string} stdout
 * @param {string} name
 * @returns {PublishedMetadata}
 */
function parsePublishedMetadata(stdout, name) {
  /** @type {unknown} */
  const parsed = JSON.parse(stdout);
  /** @type {unknown} */
  const metadata = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  assert.ok(
    isPublishedMetadata(metadata) && metadata.name === name,
    "Invalid published npm metadata: expected one package record with exact version, source and integrity",
  );
  return metadata;
}

/**
 * Reads published `latest` metadata; returns null only for a registry 404 of a channel that
 * awaits its first publication.
 * @param {FleetEntry & { npmPackage: string }} entry
 * @param {readonly string[]} args
 * @param {{ env?: NodeJS.ProcessEnv | undefined, timeout?: number | undefined }} [options]
 * @returns {PublishedMetadata | null}
 */
export function publishedMetadata(entry, args, { env, timeout } = {}) {
  const command = ["view", `${entry.npmPackage}@latest`, "--json", ...args];
  console.log(`$ npm ${command.join(" ")}`);
  const result = spawnSync("npm", command, {
    encoding: "utf8",
    env,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return parsePublishedMetadata(result.stdout, entry.npmPackage);
  }
  forwardOutput(result.stdout, process.stdout);
  forwardOutput(result.stderr, process.stderr);
  if (awaitsFirstPublication(entry) && /\bE404\b/.test(`${result.stdout}\n${result.stderr}`)) {
    return null;
  }
  throw new Error(`npm exited ${String(result.status)} (${result.signal ?? "no signal"})`);
}

/**
 * @param {string} directory
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedEnvironment(directory) {
  // Canonicalize once so native Git/SDK identity checks agree across directory aliases (for example macOS /var -> /private/var).
  mkdirSync(directory, { recursive: true });
  const root = realpathSync.native(directory);
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const userConfig = join(root, "user.npmrc");
  const globalConfig = join(root, "global.npmrc");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    USER: "pi-compatibility",
    LOGNAME: "pi-compatibility",
    USERNAME: "pi-compatibility",
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TERM: "xterm-256color",
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_cache: process.env.npm_config_cache ?? join(root, "npm-cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
  };
  // Leave agentDir HOME-derived: several tests deliberately substitute HOME.
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PSModulePath"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      env[name] = value;
    }
  }
  return env;
}

/**
 * @param {string} source
 * @param {string} target
 */
export function stageSource(source, target) {
  run("git", ["clone", "--no-hardlinks", "--quiet", source, target]);
  const paths = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: source,
    quiet: true,
  });
  for (const file of paths.split("\0").filter(Boolean)) {
    const destination = resolve(target, file);
    if (!existsSync(join(source, file))) {
      rmSync(destination, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(source, file), destination, { recursive: true });
  }
}
