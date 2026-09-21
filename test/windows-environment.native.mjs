import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isolatedEnvironment } from "../scripts/common.mjs";

test("isolated Windows environment preserves native process identity queries", { skip: process.platform !== "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-compat-windows-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"]) {
    assert.equal(env[name], join(root, "home"));
  }
  const command = `$p = Get-Process -Id ${process.pid} -ErrorAction Stop; $p.Id; $p.StartTime.ToUniversalTime().ToString('o')`;
  const query = (environment, timeout) => execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
    env: environment, encoding: "utf8", timeout, maxBuffer: 64 * 1024,
  }).trim();
  // Warm native PowerShell/CLR once: first startup on a fresh VM can exceed 5s.
  const expected = query(process.env, 30_000);
  const [pid, started] = expected.split(/\r?\n/);
  assert.equal(Number(pid), process.pid);
  assert.ok(Number.isFinite(Date.parse(started)), "native start identity must be a timestamp");
  // Keep the consumer's 5s bound; do not repair the environment inside the test.
  assert.equal(query(env, 5_000), expected);
});
