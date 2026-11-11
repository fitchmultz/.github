import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/setup-linux-dns.sh", import.meta.url));

function harness(t, { active = true, domainOutput = "Global:\nLink 2 (eth0):\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-linux-dns-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const etc = join(root, "etc");
  const log = join(root, "calls.log");
  mkdirSync(bin, { recursive: true });

  const writeTool = (name, body) => {
    const target = join(bin, name);
    writeFileSync(target, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(target, 0o755);
  };

  writeTool(
    "sudo",
    `mapped=()
for arg in "$@"; do
  mapped+=("\${arg/#\\/etc\\//${etc}/}")
done
printf 'sudo %s\\n' "\${mapped[*]}" >> "${log}"
exec "\${mapped[@]}"`,
  );

  writeTool(
    "systemctl",
    `printf 'systemctl %s\\n' "$*" >> "${log}"
if [ "\${1:-}" = "is-active" ]; then
  ${active ? "exit 0" : "exit 3"}
fi`,
  );

  writeTool(
    "resolvectl",
    `printf 'resolvectl %s\\n' "$*" >> "${log}"
if [ "\${1:-}" = "domain" ]; then
  cat <<'EOF'
${domainOutput}
EOF
fi`,
  );

  const run = (...args) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    });

  return {
    run,
    dropin: join(etc, "systemd/resolved.conf.d/ci-dns.conf"),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

test("no-ops cleanly when systemd-resolved is not active", (t) => {
  const h = harness(t, { active: false });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(h.dropin), false);
  assert.deepEqual(h.calls(), ["systemctl is-active --quiet systemd-resolved"]);
});

test("writes parallel global DNS without Domains=~. when no link carries a catch-all routing domain", (t) => {
  const h = harness(t, { domainOutput: "Global:\nLink 2 (eth0): reddog.microsoft.com\n" });
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(h.dropin, "utf8"), "[Resolve]\nDNS=1.1.1.1 1.0.0.1 9.9.9.9\n");
  const calls = h.calls();
  assert.ok(calls.some((line) => line.endsWith("systemctl restart systemd-resolved")));
  assert.ok(calls.some((line) => line.endsWith("resolvectl flush-caches")));
  assert.ok(calls.includes("resolvectl query archive.ubuntu.com security.ubuntu.com"));
});

test("matches Domains=~. when a link carries a catch-all routing domain so global DNS stays in the active scope", (t) => {
  const h = harness(t, { domainOutput: "Global:\nLink 2 (eth0): ~. internal.cloudapp.net\n" });
  const result = h.run("archive.ubuntu.com");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(h.dropin, "utf8"),
    "[Resolve]\nDNS=1.1.1.1 1.0.0.1 9.9.9.9\nDomains=~.\n",
  );
  assert.ok(h.calls().includes("resolvectl query archive.ubuntu.com"));
});
