import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { codingAgent, isolatedEnvironment, writeJson } from "../scripts/common.mjs";
import { officialRelease, prepareHost, selectDevelopmentHost } from "../scripts/hosts.mjs";

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

test("failed native host selection restores metadata and preserves caller-owned files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "package.json");
  writeJson(file, { private: true, devDependencies: { [codingAgent]: "0.86.1" }, peerDependencies: { [codingAgent]: "*" } });
  const original = readFileSync(file, "utf8");
  const lock = '{"name":"original public lock","lockfileVersion":3}\n';
  writeFileSync(join(root, "package-lock.json"), lock);
  mkdirSync(join(root, "node_modules"));
  const marker = join(root, "node_modules", "caller-owned.txt");
  writeFileSync(marker, "preserve caller-owned content");
  assert.throws(() => selectDevelopmentHost(root, { packageDirs: { [codingAgent]: join(root, "absent-package.tgz") } }, isolatedEnvironment(root)), /npm exited/);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readFileSync(join(root, "package-lock.json"), "utf8"), lock);
  assert.equal(readFileSync(marker, "utf8"), "preserve caller-owned content");
});

test("official installer provenance fails closed before installation", async (t) => {
  for (const fault of ["missing asset", "asset digest", "source origin", "cohort version", "cohort declarations"]) {
    await t.test(fault, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "pi-official-origin-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const pkg = metadata(codingAgent);
      const manifest = { name: `${codingAgent}-install`, version: pkg.version, dependencies: { [codingAgent]: pkg.version } };
      const lock = { lockfileVersion: 3, packages: { "": manifest, [`node_modules/${codingAgent}`]: {
        version: fault === "cohort version" ? "0.86.0" : pkg.version, resolved: pkg.dist.tarball,
        ...(fault === "cohort declarations" ? { dependencies: { "unexpected-runtime": "*" } } : {}),
      } } };
      const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
      const files = {
        "pi-coding-agent-install-package.json": JSON.stringify(manifest),
        "pi-coding-agent-install-package-lock.json": JSON.stringify(lock),
      };
      files.SHA256SUMS = Object.entries(files).map(([name, bytes]) => `${digest(bytes)}  ${name}`).join("\n");
      const releaseUrl = `https://github.com/earendil-works/pi/releases/download/v${pkg.version}/`;
      const sourceRef = "a".repeat(40);
      t.mock.method(globalThis, "fetch", async (input) => {
        const url = String(input);
        if (url.startsWith("https://registry.npmjs.org/")) return Response.json(pkg);
        if (url.includes("/releases/tags/")) return Response.json({
          tag_name: `v${pkg.version}`, draft: false, prerelease: false,
          assets: Object.entries(files).filter(([name]) => fault !== "missing asset" || name !== "pi-coding-agent-install-package-lock.json")
            .map(([name, bytes]) => ({ name, browser_download_url: `${releaseUrl}${name}`,
              digest: `sha256:${fault === "asset digest" && name.endsWith("lock.json") ? "0".repeat(64) : digest(bytes)}` })),
        });
        if (url.includes("/git/ref/")) return Response.json({ object: { type: "commit", sha: sourceRef } });
        if (url.startsWith(releaseUrl)) return new Response(files[url.slice(releaseUrl.length)]);
        if (url.startsWith(`https://raw.githubusercontent.com/earendil-works/pi/${sourceRef}/`)) {
          return new Response(fault === "source origin" ? "{}" : files[`pi-coding-agent-install-${url.endsWith("package-lock.json") ? "package-lock.json" : "package.json"}`]);
        }
        throw new Error(`Unexpected official input: ${url}`);
      });
      const expected = {
        "missing asset": /Missing\/ambiguous official installer asset/,
        "asset digest": /Changed official installer asset/,
        "source origin": /differs from its release's source lock/,
        "cohort version": /Official lock version mismatch/,
        "cohort declarations": /Official lock declaration mismatch/,
      };
      await assert.rejects(prepareHost(join(root, "host"), "official", pkg.version, isolatedEnvironment(root)), expected[fault]);
    });
  }
});
