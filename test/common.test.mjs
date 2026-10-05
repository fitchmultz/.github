import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { awaitsFirstPublication, isolatedEnvironment, publishedMetadata } from "../scripts/common.mjs";

test("isolation paths preserve one filesystem identity through directory aliases", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const alias = join(root, "alias");
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const env = isolatedEnvironment(join(alias, "new-root"));
  assert.equal(env.HOME, realpathSync.native(env.HOME));
  assert.equal(env.TMPDIR, realpathSync.native(env.TMPDIR));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.TMP, env.TMPDIR);
  assert.equal(env.TEMP, env.TMPDIR);
});

const scoped = { repo: "pi-calculator", npmPackage: "@fitchmultz/pi-calculator", npmRelease: "automatic" };
const unscoped = { repo: "pi-copy-message", npmPackage: "pi-copy-message", npmRelease: "automatic" };

test("only an enabled owned scoped channel may await its first publication", () => {
  assert.equal(awaitsFirstPublication(scoped), true);
  assert.equal(awaitsFirstPublication({ ...scoped, npmRelease: "approval" }), true);
  assert.equal(awaitsFirstPublication({ ...scoped, npmRelease: undefined }), false);
  assert.equal(awaitsFirstPublication(unscoped), false);
  assert.equal(awaitsFirstPublication({ ...scoped, npmPackage: "@someone/pi-calculator" }), false);
  assert.equal(awaitsFirstPublication(scoped, "pi-calculator"), false);
  assert.equal(awaitsFirstPublication(undefined, "@fitchmultz/pi-calculator"), false);
});

test("published metadata treats a registry 404 as pending only for a first-publication channel", { skip: process.platform === "win32" }, (t) => {
  const bin = mkdtempSync(join(tmpdir(), "pi-fake-npm-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const npm = join(bin, "npm");
  const fake = (body) => { writeFileSync(npm, `#!/bin/sh\n${body}\n`); chmodSync(npm, 0o755); };
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  fake(`echo '{"error":{"code":"E404","summary":"Not Found"}}'; echo 'npm error code E404' >&2; exit 1`);
  assert.equal(publishedMetadata(scoped, [], { env }), null);
  assert.throws(() => publishedMetadata(unscoped, [], { env }), /npm exited 1/);
  fake(`echo 'npm error code ETIMEDOUT' >&2; exit 1`);
  assert.throws(() => publishedMetadata(scoped, [], { env }), /npm exited 1/);
  fake(`echo '{"name":"@fitchmultz/pi-calculator","version":"1.2.3"}'`);
  assert.deepEqual(publishedMetadata(scoped, [], { env }), { name: "@fitchmultz/pi-calculator", version: "1.2.3" });
});
