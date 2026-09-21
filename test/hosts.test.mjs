import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codingAgent, isolatedEnvironment, writeJson } from "../scripts/common.mjs";
import { officialRelease, selectDevelopmentHost } from "../scripts/hosts.mjs";

const metadata = (name, dependencies = {}) => ({ name, version: "0.86.1", dependencies, dist: { integrity: "sha512-fixture", tarball: `https://registry.npmjs.org/${name}/fixture.tgz` } });

test("the official target includes the recursively published cohort at one exact stable version", async (t) => {
  const agent = metadata(codingAgent, { "@earendil-works/pi-ai": "^0.86.1", chalk: "6.0.0" });
  const ai = metadata("@earendil-works/pi-ai", { "@earendil-works/pi-agent-core": "^0.86.1" });
  const core = metadata("@earendil-works/pi-agent-core");
  const responses = new Map([[`${codingAgent}/latest`, agent], [`${ai.name}/0.86.1`, ai], [`${core.name}/0.86.1`, core]]);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const key = decodeURIComponent(new URL(url).pathname.slice(1));
    requests.push(key);
    assert.ok(responses.has(key), `Unexpected metadata request: ${key}`);
    return Response.json(responses.get(key));
  });
  const release = await officialRelease();
  assert.deepEqual(release.cohort, { [codingAgent]: "0.86.1", [ai.name]: "0.86.1", [core.name]: "0.86.1" });
  assert.equal(requests.length, 3);
});

test("an incompletely published cohort stops before extension qualification", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => String(url).endsWith("/latest")
    ? Response.json(metadata(codingAgent, { "@earendil-works/pi-ai": "^0.86.1" }))
    : new Response("not yet published", { status: 404 }));
  await assert.rejects(officialRelease(), /cohort is not fully published: @earendil-works\/pi-ai/);
});

test("a prerelease cannot become the required official target", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  await assert.rejects(officialRelease("0.87.0-beta.1"), /exact stable/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("failed native host selection restores the public source manifest and leaves the lock untouched", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "package.json");
  writeJson(file, { private: true, devDependencies: { [codingAgent]: "0.86.1" }, peerDependencies: { [codingAgent]: "*" } });
  const original = readFileSync(file, "utf8");
  const lock = '{"name":"original public lock","lockfileVersion":3}\n';
  writeFileSync(join(root, "package-lock.json"), lock);
  assert.throws(() => selectDevelopmentHost(root, { overrides: { [codingAgent]: `file:${join(root, "absent-package.tgz")}` } }, isolatedEnvironment(root)), /npm exited/);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readFileSync(join(root, "package-lock.json"), "utf8"), lock);
});
