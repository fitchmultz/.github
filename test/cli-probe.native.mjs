import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { probeCli } from "../scripts/cli-probe.mjs";
import { codingAgent, isolatedEnvironment, readJson, run, writeJson } from "../scripts/common.mjs";
import { hostIdentity, selectDevelopmentHost } from "../scripts/hosts.mjs";

assert.ok(process.env.PI_TEST_HOST, "PI_TEST_HOST must identify a real installed Pi consumer");
const host = hostIdentity(process.env.PI_TEST_HOST);

test("native development imports reuse the prepared SDK, TypeBox and transitive runtime graph", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-host-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const development = join(root, "development");
  mkdirSync(development);
  writeJson(join(development, "package.json"), { private: true, type: "module",
    devDependencies: { [codingAgent]: "0.0.0", typebox: "0.0.0" }, peerDependencies: { [codingAgent]: "*" } });
  writeFileSync(join(development, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  const originals = ["package.json", "package-lock.json"].map((file) => readFileSync(join(development, file)));
  const env = isolatedEnvironment(root);
  const selected = selectDevelopmentHost(development, host, env);
  assert.equal(selected.runtimeGraphSha256, host.runtimeGraphSha256);
  assert.equal(selected.runtimeLockSha256, host.runtimeLockSha256);
  for (const [index, file] of ["package.json", "package-lock.json"].entries()) assert.deepEqual(readFileSync(join(development, file)), originals[index]);
  writeFileSync(join(development, "imports.mjs"), `import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { fileURLToPath } from "node:url";
import { SessionManager } from ${JSON.stringify(codingAgent)};
import { SessionManager as PreparedSessionManager } from ${JSON.stringify(pathToFileURL(host.index).href)};
import { Type } from "typebox";
import { Type as PreparedType } from ${JSON.stringify(pathToFileURL(join(host.packageDirs.typebox, readJson(join(host.packageDirs.typebox, "package.json")).exports["."].import)).href)};
assert.equal(SessionManager, PreparedSessionManager);
assert.equal(Type, PreparedType);
const selectedAi = findPackageJSON("@earendil-works/pi-ai", import.meta.url);
const preparedAi = ${JSON.stringify(join(host.packageDirs["@earendil-works/pi-ai"], "package.json"))};
assert.equal(realpathSync(selectedAi), preparedAi);
assert.equal(realpathSync(findPackageJSON("@aws-sdk/credential-provider-node", selectedAi)),
  realpathSync(findPackageJSON("@aws-sdk/credential-provider-node", preparedAi)));
assert.equal(realpathSync(fileURLToPath(import.meta.resolve(${JSON.stringify(codingAgent)}))), ${JSON.stringify(host.index)});
`);
  run(process.execPath, [join(development, "imports.mjs")], { cwd: development, env });
});

function fixture(t, code, pi = { extensions: ["index.ts"] }) {
  const root = mkdtempSync(join(tmpdir(), "pi-compat-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extension = join(root, "extension");
  mkdirSync(extension);
  writeJson(join(extension, "package.json"), { name: "compatibility-fixture", type: "module", ...(pi && { pi }) });
  writeFileSync(join(extension, "index.ts"), code);
  return { extension, probe: () => probeCli(host, extension, join(root, "probe"), isolatedEnvironment(root)) };
}

test("real bundled CLI reports its exact host and the loaded extension's active tool", (t) => {
  const { probe } = fixture(t, `import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({name:"compatibility_fixture_echo",label:"Echo",description:"Fixture",parameters:Type.Object({}),
    execute:async()=>({content:[{type:"text",text:"ok"}],details:{}})});
}`);
  const result = probe();
  assert.ok(result.tools.some((tool) => tool.name === "compatibility_fixture_echo"));
  assert.ok(result.activeTools.includes("compatibility_fixture_echo"));
  assert.equal(result.indexSha256, host.indexSha256);
});

test("a factory load failure cannot receive a green qualification", (t) => {
  const { probe } = fixture(t, `export default function() { throw new Error("broken consumer factory"); }`);
  assert.throws(probe, /broken consumer factory/);
});

test("an extension lifecycle error fails even when the native CLI continues", (t) => {
  const { probe } = fixture(t, `export default function(pi) { pi.on("session_start", () => { throw new Error("broken startup contract"); }); }`);
  assert.throws(probe, /Native extension lifecycle errors/);
});

const themeFixture = () => ({ ...readJson(join(host.packageDir, "dist/modes/interactive/theme/dark.json")),
  name: "qualification-theme-fixture" });

test("native theme acceptance honors package discovery, manifest selection and exclusions", (t) => {
  for (const [pi, names] of [
    [{ extensions: ["index.ts"], themes: ["themes/*.json", "!themes/excluded.json"] }, ["qualification-theme-fixture"]],
    [null, ["qualification-theme-fixture"]],
    [{ extensions: ["index.ts"] }, []],
  ]) {
    const { extension, probe } = fixture(t, `export default function() {}`, pi);
    mkdirSync(join(extension, "themes"));
    writeJson(join(extension, "themes", "valid.json"), themeFixture());
    if (pi) writeFileSync(join(extension, "themes", "excluded.json"), "{invalid json}");
    const result = probe();
    assert.deepEqual(result.themes.map(({ name }) => name), names);
    if (names.length) assert.equal(result.themes[0].sourcePath, join(extension, "themes", "valid.json"));
  }
});

test("existing but invalid packaged themes cannot receive a green qualification", (t) => {
  const { extension, probe } = fixture(t, `export default function() {}`, { extensions: ["index.ts"], themes: ["themes"] });
  mkdirSync(join(extension, "themes"));
  const missingColor = themeFixture();
  delete missingColor.colors.accent;
  const unresolvedColor = themeFixture();
  unresolvedColor.colors.accent = "missing-fixture-variable";
  for (const content of ["{invalid json}", JSON.stringify(missingColor), JSON.stringify(unresolvedColor)]) {
    writeFileSync(join(extension, "themes", "invalid.json"), content);
    assert.throws(probe, /Packaged theme acceptance failed/);
  }
});
