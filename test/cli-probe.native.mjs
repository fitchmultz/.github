import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeCli } from "../scripts/cli-probe.mjs";
import { isolatedEnvironment, readJson, writeJson } from "../scripts/common.mjs";
import { hostIdentity } from "../scripts/hosts.mjs";

assert.ok(process.env.PI_TEST_HOST, "PI_TEST_HOST must identify a real installed Pi consumer");
const host = hostIdentity(process.env.PI_TEST_HOST);

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
