import assert from "node:assert/strict";
import { appendFileSync, chownSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkResources, probeCli } from "./cli-probe.mjs";
import { isolatedEnvironment, readJson, run, sha256, stageSource, writeJson } from "./common.mjs";
import { prepareHost, selectDevelopmentHost } from "./hosts.mjs";

const { values } = parseArgs({ options: {
  repo: { type: "string" }, source: { type: "string" }, host: { type: "string" },
  target: { type: "string" }, output: { type: "string" }, published: { type: "boolean", default: false },
} });
assert.ok(values.repo && values.source && values.host && values.output, "Required: --repo NAME --source PATH --host official|fork|none --output PATH [--target VERSION|FORK_ARTIFACT]");
const entry = readJson(new URL("../fleet.json", import.meta.url)).find((item) => item.repo === values.repo);
assert.ok(entry, `Repository is not in the fleet: ${values.repo}`);
assert.ok(["official", "fork", "none"].includes(values.host));
assert.equal(values.host === "none", entry.kind === "cli", "Only standalone CLIs use the host-free lane");
const source = resolve(values.source);
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
// Browser/Intercom fixtures use Unix sockets; Darwin's socket pathname limit is 103 bytes.
const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pc-"));
// macOS temporary directories can inherit wheel; permission fixtures need the executing user's group.
if (process.getgid) chownSync(root, process.getuid(), process.getgid());
const env = isolatedEnvironment(root);
const report = { repo: values.repo, flavor: values.host, lane: process.env.PI_COMPAT_LANE_LABEL ?? values.host, node: process.version, platform: process.platform,
  source: run("git", ["rev-parse", "HEAD"], { cwd: source, quiet: true }).trim(),
  sourceDirty: run("git", ["status", "--porcelain"], { cwd: source, quiet: true }).trim() !== "",
  target: values.host === "fork" ? process.env.PI_COMPAT_FORK_REF : values.target, checks: {} };
let phase = "prepare";
try {
  const development = join(root, "development");
  stageSource(source, development);
  run("npm", [existsSync(join(development, "package-lock.json")) ? "ci" : "install", "--ignore-scripts"], { cwd: development, env });
  const manifest = readJson(join(development, "package.json"));
  if (entry.npmPackage) assert.equal(manifest.name, entry.npmPackage, "Owned npm channel differs from the source manifest");
  assert.ok(manifest.scripts?.["check:compat"], "Repository must supply its package-specific check:compat contract");
  let host;
  const expectedRefusal = entry.forkOnly === true && values.host === "official";
  if (values.host !== "none") {
    phase = "host-install";
    const target = values.target ?? readJson(new URL("../host-targets.json", import.meta.url)).official;
    assert.ok(values.host !== "fork" || values.target, "Fork lane requires the built artifact directory");
    host = await prepareHost(join(root, "host"), values.host, target, env);
    report.host = host;
    phase = "development-host-selection";
    const selected = selectDevelopmentHost(development, host, env);
    report.developmentHost = selected;
    if (!expectedRefusal) {
      phase = "package-contracts";
      run("npm", ["run", "check:compat"], { cwd: development, env: {
        ...env, PI_COMPAT_HOST: values.host, PI_COMPAT_EXPECTED_VERSION: host.version,
        PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir, PI_PACKAGE_DIR: selected.packageDir,
        PI_HOST_INDEX: selected.index, PI_HOST_CLI: selected.cli,
        PI_COMPAT_EVIDENCE_DIR: join(root, "probes", "contracts"),
      } });
      report.checks.contracts = "passed";
    } else {
      report.checks.contracts = "fork-only; official refusal checked through native CLI";
    }
  } else {
    phase = "standalone-cli-contracts";
    run("npm", ["run", "check:compat"], { cwd: development, env });
    report.checks.contracts = "passed";
  }

  phase = "git-consumer-install";
  const gitConsumer = join(root, "git-consumer");
  stageSource(source, gitConsumer);
  run("npm", ["install", "--omit=dev"], { cwd: gitConsumer, env });
  checkResources(gitConsumer);
  report.checks.gitInstall = "passed (fresh checkout, production dependencies and native lifecycle)";
  if (entry.kind === "extension") {
    phase = "git-consumer-cli";
    report.checks.gitCli = probeCli(host, gitConsumer, join(root, "probes", "git"), env, { expectedRefusal });
  }

  if (entry.npmPackage || entry.kind === "cli") {
    phase = "npm-pack";
    const packedJson = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", output], { cwd: development, env, quiet: true }));
    const packed = Array.isArray(packedJson) ? packedJson[0] : Object.values(packedJson)[0];
    const tarball = join(output, packed.filename);
    report.package = { name: manifest.name, version: manifest.version, file: packed.filename, integrity: packed.integrity, sha256: sha256(tarball) };
    const consumer = join(root, "npm-consumer");
    mkdirSync(consumer);
    writeJson(join(consumer, "package.json"), { private: true, dependencies: { [manifest.name]: `file:${tarball.replaceAll("\\", "/")}` } });
    phase = "npm-consumer-install";
    run("npm", ["install", "--omit=dev"], { cwd: consumer, env });
    const installed = join(consumer, "node_modules", manifest.name);
    assert.equal(readJson(join(installed, "package.json")).version, manifest.version);
    checkResources(installed);
    report.checks.npmInstall = "passed";
    if (entry.kind === "extension") {
      phase = "npm-consumer-cli";
      report.checks.npmCli = probeCli(host, installed, join(root, "probes", "npm"), env, { expectedRefusal });
      for (const key of ["tools", "activeTools", "commands", "providers"]) {
        const names = (observation) => observation[key].map((value) => typeof value === "string" ? value : value.name).sort();
        assert.deepEqual(names(report.checks.npmCli), names(report.checks.gitCli), `npm and Git expose different ${key}`);
      }
    }
  }

  if (values.published && entry.npmPackage) {
    phase = "published-npm";
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(entry.npmPackage)}/latest`);
    assert.ok(response.ok, `Published package metadata: HTTP ${response.status}`);
    const metadata = await response.json();
    assert.equal(metadata.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, ""),
      `https://github.com/fitchmultz/${entry.repo}`, "Published npm source identity changed");
    const consumer = join(root, "published-consumer");
    mkdirSync(consumer);
    writeJson(join(consumer, "package.json"), { private: true, dependencies: { [entry.npmPackage]: metadata.version } });
    run("npm", ["install", "--omit=dev"], { cwd: consumer, env });
    assert.equal(readJson(join(consumer, "package-lock.json")).packages[`node_modules/${entry.npmPackage}`].integrity, metadata.dist.integrity);
    const installed = join(consumer, "node_modules", entry.npmPackage);
    checkResources(installed);
    report.published = { name: entry.npmPackage, version: metadata.version, integrity: metadata.dist.integrity, gitHead: metadata.gitHead };
    report.checks.publishedCli = probeCli(host, installed, join(root, "probes", "published"), env, { expectedRefusal });
  }
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.phase = phase;
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (existsSync(join(root, "probes"))) cpSync(join(root, "probes"), join(output, "probes"), { recursive: true });
  writeJson(join(output, "qualification.json"), report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### ${report.repo} / ${report.lane} / ${report.node}\n\n${report.result}. Source: \`${report.source}\`. Host: \`${report.host?.provenance.ref ?? report.host?.version ?? "standalone"}\`.\n\n${report.phase ? `Failed phase: **${report.phase}**. ` : ""}See the qualification artifact for exact SDK/CLI hashes, installation provenance, errors and reproduction inputs.\n`);
  }
  console.log(`${report.repo}: ${report.result} (${report.phase ?? "complete"}); evidence: ${output}`);
  rmSync(root, { recursive: true, force: true });
}
