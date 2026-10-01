import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../scripts/common.mjs";

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
