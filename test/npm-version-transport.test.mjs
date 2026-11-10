import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture, success, check } from "./fixtures/npm-version-harness.mjs";
import { request } from "../scripts/npm-version.mjs";

const transport = fileURLToPath(new URL("./fixtures/npm-version-transport.mjs", import.meta.url));
const agent = "bc-11111111-1111-4111-8111-111111111111";

function rejected(result, context) {
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(context), result.stderr);
  assert.match(result.stderr, /TypeError: fetch failed/);
  assert.match(result.stderr, /\[cause\]:/);
  assert.match(result.stderr, /UND_ERR_SOCKET/);
  for (const secret of ["read-fixture", "app-fixture", "cursor-fixture", "durable-fixture",
    "sentinel-query", "sentinel-fragment", "sentinel-body", "sentinel-user", "sentinel-password"]) {
    assert.ok(!result.stderr.includes(secret), `Diagnostic leaked ${secret}`);
  }
}

test("version CLI retains native transport cause and the final PR GET context after its local push", (t) => {
  const f = fixture(t);
  const result = f.invoke(["reconcile", "--source", f.source, "--app-slug", "pi-durable"], "push", {
    NODE_OPTIONS: `--import=${transport}`, FAKE_TRANSPORT_PATH: "/repos/fitchmultz/pi-copy-message/pulls/1",
  });
  assert.equal(f.state().open.length, 1, "The local version push and PR creation must precede the rejection");
  assert.ok(f.ref(`npm-version/${f.first}`));
  rejected(result, "GitHub GET https://api.github.com/repos/fitchmultz/pi-copy-message/pulls/1");
});

for (const [service, method, path, endpoint] of [
  ["GitHub", "POST", "/graphql", "https://api.github.com/graphql"],
  ["Cursor", "GET", `/v1/agents/${agent}`, `https://api.cursor.com/v1/agents/${agent}`],
  ["Pi Durable", "POST", "/api/chats", "https://durable.example.invalid/api/chats"],
]) test(`remediation CLI retains native transport cause and ${service} ${method} context`, (t) => {
  const f = fixture(t);
  success(f.reconcile());
  const head = f.ref(`npm-version/${f.first}`);
  f.setState((s) => {
    const cursor = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first);
    cursor.details_url = `https://cursor.com/agents/${agent}`;
    s.checks = [cursor, check("pi-durable", "Pi Durable Review", head, f.first),
      check("github-actions", "compatibility / compatibility", head, f.first)];
    s.cursorReports = { [agent]: "sentinel-body" };
  });
  const result = f.remediate(head, undefined, [], {
    NODE_OPTIONS: `--import=${transport}`, FAKE_TRANSPORT_PATH: path,
  });
  rejected(result, `${service} ${method} ${endpoint}`);
  assert.equal(f.state().submissions, undefined, "No durable work may be submitted after the rejection");
  if (service === "Pi Durable") {
    for (const origin of [
      "https://sentinel-user:sentinel-password@durable.example.invalid?token=sentinel-query",
      "https://sentinel-user:sentinel-password@[invalid?token=sentinel-query",
    ]) {
      const invalid = f.remediate(head, undefined, [], { PI_DURABLE_ORIGIN: origin });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /Pi Durable.*(?:credentials|invalid)/);
      assert.doesNotMatch(invalid.stderr, /sentinel-/);
    }
  }
});

test("GitHub request keeps the original native cause without logging headers, bodies or endpoint query data", async (t) => {
  const nativeFetch = globalThis.fetch;
  const server = createServer((incoming) => incoming.socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { globalThis.fetch = nativeFetch; server.close(); });
  let original;
  globalThis.fetch = async (_input, options) => {
    try {
      return await nativeFetch(`http://127.0.0.1:${server.address().port}/public?secret=sentinel-query`, options);
    } catch (error) {
      original = error;
      throw error;
    }
  };
  await assert.rejects(request("https://api.github.com/public?secret=sentinel-query#sentinel-fragment", {
    method: "POST", token: "sentinel-auth", body: { private: "sentinel-body" },
  }), (error) => {
    assert.equal(error.cause, original);
    assert.equal(error.cause.cause.code, "UND_ERR_SOCKET");
    assert.match(error.message, /GitHub POST https:\/\/api\.github\.com\/public: transport failed/);
    assert.doesNotMatch(inspect(error), /sentinel-/);
    return true;
  });
});

test("GitHub request diagnostics do not echo invalid URLs or URL credentials rejected by native fetch", () => {
  const script = new URL("../scripts/npm-version.mjs", import.meta.url).href;
  for (const [url, expected] of [
    ["https://sentinel-user:sentinel-password@example.invalid/public?token=sentinel-query#sentinel-fragment", /GitHub.*credentials/],
    ["https://sentinel-user:sentinel-password@[invalid?token=sentinel-query", /GitHub.*invalid/],
  ]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { request } from ${JSON.stringify(script)};
    try {
      await request(${JSON.stringify(url)}, {
        token: "sentinel-auth", body: { private: "sentinel-body" }, method: "POST",
      });
    } catch (error) { console.error(error); process.exitCode = 1; }
  `], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /sentinel-/);
  }
});
