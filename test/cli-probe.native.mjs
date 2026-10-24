import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { probeCli } from "../scripts/cli-probe.mjs";
import { codingAgent, isolatedEnvironment, readJson, run, sha256, writeJson } from "../scripts/common.mjs";
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
  assert.deepEqual(selected, host);
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
const selectedAi = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
const preparedAi = ${JSON.stringify(join(host.packageDirs["@earendil-works/pi-ai"], "package.json"))};
assert.equal(realpathSync(findPackageJSON("@earendil-works/pi-ai", import.meta.url)), preparedAi);
assert.equal(realpathSync(findPackageJSON("@aws-sdk/credential-provider-node", selectedAi)),
  realpathSync(findPackageJSON("@aws-sdk/credential-provider-node", preparedAi)));
assert.equal(realpathSync(fileURLToPath(import.meta.resolve(${JSON.stringify(codingAgent)}))), ${JSON.stringify(host.index)});
`);
  run(process.execPath, [join(development, "imports.mjs")], { cwd: development, env });
});

test("exact development overrides select the native host without changing unrelated overrides or distribution bytes", async (t) => {
  for (const version of ["1.0.0", "1.0.2", "1.1.0"]) {
    await t.test(`development SDK ${version}`, (t) => {
      const root = mkdtempSync(join(tmpdir(), "pi-native-exact-override-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const development = join(root, "development");
      mkdirSync(development);
      writeJson(join(development, "package.json"), { private: true, type: "module",
        devDependencies: { [codingAgent]: version, typebox: "1.3.27", "is-odd": "3.0.1", "is-even": "1.0.0" },
        peerDependencies: { [codingAgent]: "*" },
        overrides: {
          [`${codingAgent}@${version}`]: { undici: "8.12.2" },
          "typebox@1.3.27": "1.3.27",
          ...Object.fromEntries(Object.keys(host.packageDirs).filter((name) => name !== codingAgent && name !== "typebox")
            .map((name) => [`${name}@^${version}`, { ".": version }])),
          "is-number@^6.0.0": "7.0.0",
          "is-even": { "is-odd": "3.0.1" },
        } });
      const file = join(development, "package.json");
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
      // Exercise both an existing lock's exact bytes and removal of a newly generated lock.
      const lockFile = join(development, "package-lock.json");
      if (version !== "1.0.0") writeFileSync(lockFile, '{"lockfileVersion":3,"packages":{}}\n');
      const original = readFileSync(join(development, "package.json"));
      const originalLock = version === "1.0.0" ? null : readFileSync(lockFile);
      const selected = selectDevelopmentHost(development, host, isolatedEnvironment(root));
      assert.deepEqual(selected, host, "SDK, actual CLI, cohort, TypeBox, physical paths and runtime lock/graph must all match");
      assert.equal(readJson(join(development, "node_modules/is-number/package.json")).version, "7.0.0", "unrelated version-qualified override still applies");
      assert.equal(readJson(findPackageJSON("is-odd", pathToFileURL(join(development, "node_modules/is-even/package.json")))).version, "3.0.1", "unrelated nested override still applies");
      assert.deepEqual(readFileSync(join(development, "package.json")), original);
      if (originalLock) assert.deepEqual(readFileSync(lockFile), originalLock);
      else assert.equal(existsSync(lockFile), false);
    });
  }
});

test("non-selected qualified overrides still fail native npm validation and restore metadata", (t) => {
  for (const name of ["@earendil-works/selection-sentinel", "typebox-extra", "selection-sentinel"]) {
    const root = mkdtempSync(join(tmpdir(), "pi-native-unrelated-override-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "package.json");
    writeJson(file, { private: true, devDependencies: { [codingAgent]: "1.1.0" },
      peerDependencies: { [name]: "1.0.0" }, peerDependenciesMeta: { [name]: { optional: true } },
      overrides: { [`${codingAgent}@1.1.0`]: { undici: "8.12.2" }, [`${name}@1.0.0`]: "2.0.0" } });
    const original = readFileSync(file);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { selectDevelopmentHost } from ${JSON.stringify(new URL("../scripts/hosts.mjs", import.meta.url).href)};
      selectDevelopmentHost(${JSON.stringify(root)}, ${JSON.stringify(host)}, process.env);
    `], { env: isolatedEnvironment(root), encoding: "utf8" });
    if (process.env.PI_COMPAT_EVIDENCE_DIR) {
      mkdirSync(process.env.PI_COMPAT_EVIDENCE_DIR, { recursive: true });
      writeJson(join(process.env.PI_COMPAT_EVIDENCE_DIR, `${basename(root)}.json`), {
        executable: process.execPath, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
      });
    }
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, output);
    assert.match(output, /EOVERRIDE/);
    assert.ok(output.includes(`Override for ${name}@`), output);
    assert.deepEqual(readFileSync(file), original);
    assert.equal(existsSync(join(root, "package-lock.json")), false);
  }
});

function fixture(t, code, pi = { extensions: ["index.ts"] }) {
  const root = mkdtempSync(join(tmpdir(), "pi-compat-native-"));
  t.after(() => {
    if (process.env.PI_COMPAT_EVIDENCE_DIR && existsSync(join(root, "probes"))) {
      // A failed copy/verification leaves the originals intact and fails this cleanup hook.
      const probes = join(root, "probes");
      const destination = join(process.env.PI_COMPAT_EVIDENCE_DIR, basename(root));
      const hashes = Object.fromEntries(globSync("*/*", { cwd: probes }).map((file) => [file, sha256(join(probes, file))]));
      cpSync(probes, destination, { recursive: true });
      for (const [file, hash] of Object.entries(hashes)) assert.equal(sha256(join(destination, file)), hash);
      writeJson(join(destination, "sha256.json"), hashes);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const extension = join(root, "extension");
  mkdirSync(extension);
  writeJson(join(extension, "package.json"), { name: "compatibility-fixture", type: "module", ...(pi && { pi }) });
  writeFileSync(join(extension, "index.ts"), code);
  let attempt = 0;
  return { extension, probe: () => probeCli(host, extension, join(root, "probes", String(++attempt)), isolatedEnvironment(root)) };
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
