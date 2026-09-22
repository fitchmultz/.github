import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codingAgent, readJson } from "../scripts/common.mjs";

const fleet = readJson(new URL("../fleet.json", import.meta.url));
const targets = readJson(new URL("../host-targets.json", import.meta.url));
const sourceSha = "a".repeat(40);
const forkSha = "b".repeat(40);
let invocation = 0;

// Execute the actual script, including environment parsing and GITHUB_OUTPUT writes.
// Only external HTTP is replaced; no matrix-selection logic is reimplemented here.
async function resolveFixture(t, environment = {}, { official = true, candidate = "0.88.0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-resolve-"));
  const output = join(root, "output");
  const env = { REPOSITORY: "all", HOST: undefined, SOURCE_REF: undefined, OFFICIAL_VERSION: undefined,
    FORK_REF: undefined, GH_TOKEN: undefined, ...environment, GITHUB_OUTPUT: output };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const requests = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    const { hostname, pathname } = new URL(url);
    if (hostname === "registry.npmjs.org") {
      assert.ok(official, `Official npm must not be consulted: ${url}`);
      const [, encodedName, requestedVersion] = pathname.split("/");
      const name = decodeURIComponent(encodedName);
      assert.ok([codingAgent, "@earendil-works/pi-ai"].includes(name));
      const version = requestedVersion === "latest" ? candidate : requestedVersion;
      return Response.json({ name, version, dist: { integrity: "sha512-fixture", tarball: "https://registry.npmjs.org/fixture.tgz" },
        dependencies: name === codingAgent ? { "@earendil-works/pi-ai": `^${version}` } : {} });
    }
    assert.equal(hostname, "api.github.com");
    const match = pathname.match(/^\/repos\/fitchmultz\/([^/]+)\/(commits\/[^/]+|contents\/package\.json)$/);
    assert.ok(match && fleet.some((entry) => entry.repo === match[1]), `Unexpected GitHub request: ${url}`);
    if (match[2].startsWith("commits/")) return Response.json({ sha: sourceSha });
    assert.ok(official, "Fork selection must not read the official candidate manifest");
    assert.equal(new URL(url).searchParams.get("ref"), sourceSha);
    return Response.json({ content: Buffer.from(JSON.stringify({ devDependencies: { [codingAgent]: candidate } })).toString("base64") });
  });
  const log = t.mock.method(console, "log", () => {});
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    let error;
    try {
      await import(`../scripts/resolve-matrix.mjs?fixture=${++invocation}`);
    } catch (caught) {
      error = caught;
    }
    const outputs = Object.fromEntries((existsSync(output) ? readFileSync(output, "utf8").trim().split("\n") : [])
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    return { error, requests, outputs, lanes: outputs.matrix ? JSON.parse(outputs.matrix).include : [] };
  } finally {
    fetch.mock.restore();
    log.mock.restore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function passed(result) {
  assert.ifError(result.error);
  assert.ok(result.lanes.length);
  assert.ok(result.lanes.every((lane) => lane.ref === sourceSha));
}

const platformLabels = (lanes, repo) => lanes.filter((lane) => lane.repo === repo).map((lane) => `${lane.os}/${lane.node}`);

test("default and explicit both preserve all 26 repositories and existing Node/platform lanes", async (t) => {
  const result = await resolveFixture(t);
  const explicit = await resolveFixture(t, { HOST: "both" });
  passed(result);
  passed(explicit);
  assert.deepEqual(result.outputs, explicit.outputs);
  assert.equal(result.outputs.forkRef, targets.forkRef);
  assert.equal(result.outputs.needsFork, "true");
  assert.equal(result.lanes.length, 128);
  assert.deepEqual([...new Set(result.lanes.map((lane) => lane.repo))], fleet.map((entry) => entry.repo));
  for (const entry of fleet) {
    const lanes = result.lanes.filter((lane) => lane.repo === entry.repo);
    assert.deepEqual([...new Set(lanes.map((lane) => lane.host))], entry.kind === "cli" ? ["none"] : ["official", "fork"]);
  }
  assert.ok(result.lanes.filter((lane) => lane.host === "official").every((lane) => lane.version === targets.official && lane.label === "official"));
  const fork = result.lanes.filter((lane) => lane.host === "fork");
  assert.deepEqual(platformLabels(fork, "pi-fitch-kit"), ["ubuntu-latest/24", "ubuntu-latest/26", "macos-latest/24"]);
  assert.deepEqual(platformLabels(fork, "pi-agent-browser-native"), ["ubuntu-latest/22.19.0", "ubuntu-latest/24", "macos-latest/24", "windows-latest/24"]);
  assert.deepEqual(platformLabels(fork, "macuse"), ["macos-latest/22.19.0", "macos-latest/24"]);
  assert.ok(result.requests.filter((url) => url.includes("/commits/")).every((url) => url.endsWith("/commits/main")));
  assert.equal(result.requests.filter((url) => url.startsWith("https://registry.npmjs.org/")).length, 2, "Cohort preflight is cached across the fleet");
});

test("fork reverse dependencies preserve all 63 fork lanes without any official npm or CLI lookup", async (t) => {
  const both = await resolveFixture(t);
  const fork = await resolveFixture(t, { HOST: "fork", FORK_REF: forkSha, SOURCE_REF: "compatibility/pi-releases", OFFICIAL_VERSION: "latest" }, { official: false });
  passed(both);
  passed(fork);
  assert.deepEqual(fork.lanes, both.lanes.filter((lane) => lane.host === "fork"));
  assert.equal(fork.outputs.forkRef, forkSha);
  assert.equal(fork.outputs.needsFork, "true");
  assert.equal(fork.lanes.length, 63);
  assert.equal(new Set(fork.lanes.map((lane) => lane.repo)).size, 25);
  assert.ok(fork.lanes.some((lane) => lane.repo === "pi-posthorse"));
  assert.ok(fork.lanes.some((lane) => lane.repo === "pi-agent-skills"));
  assert.ok(fork.lanes.some((lane) => lane.repo === "pi-workflows"));
  assert.ok(fork.lanes.every((lane) => lane.host === "fork" && lane.label === "fork" && lane.version === ""));
  assert.equal(fork.requests.length, 25);
  assert.ok(fork.requests.every((url) => url.startsWith("https://api.github.com/") && url.endsWith("/commits/compatibility%2Fpi-releases") && !url.includes("/pi-evidence/")));
});

test("an individual PR still resolves its manifest candidate and diagnostic official baseline", async (t) => {
  const result = await resolveFixture(t, { REPOSITORY: "fitchmultz/pi-calculator", SOURCE_REF: sourceSha });
  passed(result);
  assert.equal(result.lanes.length, 6);
  assert.deepEqual(result.lanes.slice(0, 3).map(({ host, label, version }) => ({ host, label, version })), [
    { host: "official", label: "official", version: "0.88.0" },
    { host: "fork", label: "fork", version: "" },
    { host: "official", label: "baseline", version: targets.official },
  ]);
  assert.ok(result.requests.includes(`https://api.github.com/repos/fitchmultz/pi-calculator/commits/${sourceSha}`));
  assert.ok(result.requests.includes(`https://api.github.com/repos/fitchmultz/pi-calculator/contents/package.json?ref=${sourceSha}`));
});

test("the default canary resolves latest once, retains baseline comparisons and the standalone CLI", async (t) => {
  const result = await resolveFixture(t, { OFFICIAL_VERSION: "latest", SOURCE_REF: "main" });
  passed(result);
  assert.equal(result.lanes.length, 191);
  assert.equal(new Set(result.lanes.map((lane) => lane.repo)).size, 26);
  assert.equal(result.requests.filter((url) => url.endsWith("/latest")).length, 1);
  assert.ok(result.lanes.filter((lane) => lane.label === "official").every((lane) => lane.version === "0.88.0"));
  assert.ok(result.lanes.filter((lane) => lane.label === "baseline").every((lane) => lane.version === targets.official));
  assert.deepEqual(platformLabels(result.lanes, "pi-evidence"), ["ubuntu-latest/20", "ubuntu-latest/24"]);
});

test("an individual fork selection needs only its source commit and defaults to the exact shared fork", async (t) => {
  const result = await resolveFixture(t, { HOST: "fork", REPOSITORY: "fitchmultz/pi-calculator" }, { official: false });
  passed(result);
  assert.equal(result.outputs.forkRef, targets.forkRef);
  assert.equal(result.lanes.length, 2);
  assert.ok(result.lanes.every((lane) => lane.host === "fork"));
  assert.deepEqual(result.requests, ["https://api.github.com/repos/fitchmultz/pi-calculator/commits/main"]);
});

test("standalone CLI callers keep host-free checks but cannot become fork reverse dependencies", async (t) => {
  const both = await resolveFixture(t, { REPOSITORY: "fitchmultz/pi-evidence" }, { official: false });
  passed(both);
  assert.equal(both.outputs.needsFork, "false");
  assert.equal(both.lanes.length, 2);
  assert.ok(both.lanes.every((lane) => lane.host === "none" && lane.label === "cli"));
  const fork = await resolveFixture(t, { REPOSITORY: "fitchmultz/pi-evidence", HOST: "fork" }, { official: false });
  assert.match(fork.error?.message ?? "", /No applicable fleet repository/);
  assert.deepEqual(fork.outputs, {});
  assert.deepEqual(fork.requests, []);
});

test("invalid host selectors fail closed before fetching or emitting outputs", async (t) => {
  for (const HOST of ["", "official", "none", "Fork", "fork ", "all"]) {
    const result = await resolveFixture(t, { HOST });
    assert.match(result.error?.message ?? "", /Host must be both or fork/);
    assert.deepEqual(result.outputs, {});
    assert.deepEqual(result.requests, []);
  }
});

test("unknown repositories and nonimmutable fork targets still fail closed", async (t) => {
  for (const environment of [{ HOST: "fork", REPOSITORY: "fitchmultz/unknown" }, { HOST: "fork", FORK_REF: "main" }]) {
    const result = await resolveFixture(t, environment);
    assert.match(result.error?.message ?? "", /No applicable fleet repository|Fork host must be pinned to a full commit SHA/);
    assert.deepEqual(result.outputs, {});
    assert.deepEqual(result.requests, []);
  }
});
