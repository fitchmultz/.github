import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../scripts/ci.mjs", import.meta.url));
const gate = { SCOPE: "success", HOSTS: "success", TESTS: "success", CONFIGURATION: "success", FLEET_REQUIRED: "true", FLEET: "success" };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "CI fixture", GIT_AUTHOR_EMAIL: "ci@example.invalid",
    GIT_COMMITTER_NAME: "CI fixture", GIT_COMMITTER_EMAIL: "ci@example.invalid" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : `${JSON.stringify(content)}\n`);
  };
  const manifest = { name: "automation", version: "1.0.0", private: true, type: "module", packageManager: "npm@12.2.0",
    scripts: { test: "node --test", "check:renovate": "renovate-config-validator --strict", qualify: "node scripts/qualify.mjs" },
    engines: { node: ">=22.22.2" }, devDependencies: { renovate: "1.0.0" }, allowScripts: { re2: true } };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: {
    "": { name: manifest.name, version: manifest.version, engines: manifest.engines, devDependencies: { ...manifest.devDependencies } },
    "node_modules/renovate": { version: "1.0.0", dev: true, dependencies: { validator: "1.0.0" } },
    "node_modules/validator": { version: "1.0.0", dev: true },
  } };
  const commit = () => {
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  write("package.json", manifest);
  write("package-lock.json", lock);
  write("scripts/qualify.mjs", "runtime\n");
  const base = commit();
  const invoke = (args, environment = {}) => {
    const output = join(root, ".git", "ci-output");
    const summary = join(root, ".git", "ci-summary");
    rmSync(output, { force: true });
    rmSync(summary, { force: true });
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8",
      env: { ...env, ...Object.fromEntries([...Object.keys(gate), "EVENT"].map((name) => [name, ""])),
        ...environment, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
    return { ...result, output: existsSync(output) ? readFileSync(output, "utf8") : "",
      summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
  };
  const scope = (head, event = "pull_request", before = base) => invoke(["scope", "--event", event, "--base", before, "--head", head]);
  return { root, manifest, lock, git, write, commit, base, invoke, scope };
}

function planned(result, required) {
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.fleetRequired, required);
  assert.equal(result.output, `fleet-required=${required}\n`);
  assert.match(result.summary, new RegExp(`Fleet required: \\*\\*${required}\\*\\*`));
  assert.ok(result.summary.includes(plan.reason), "The job summary must carry the rule that decided the scope");
  return plan;
}

test("docs and policy changes intentionally skip the fleet through the real CLI", (t) => {
  const f = fixture(t);
  const files = ["README.md", "docs/guide with\nnewline.md", ".github/readme/qualification.svg",
    "renovate.json", "pi-extensions.json"];
  for (const path of files) f.write(path, "changed\n");
  const head = f.commit();
  for (const event of ["pull_request", "push"]) {
    assert.deepEqual(planned(f.scope(head, event), false).files.sort(), files.sort());
  }
  // A manual run must never inherit the fast path, even without comparison refs.
  planned(f.invoke(["scope", "--event", "workflow_dispatch"]), true);
});

test("scripts, workflows, manifests and unknown paths require the fleet even beside fast-path changes", async (t) => {
  for (const path of ["package.json", "package-lock.json", "scripts/qualify.mjs", "scripts/npm-release.mjs",
    "scripts/future.mjs", "test/hosts.test.mjs", "fleet.json", ".github/workflows/ci.yml",
    ".github/workflows/npm-release-bump.yml", "scripts/ci.mjs", "test/ci.test.mjs",
    ".github/workflows/pi-compatibility.yml", ".github/workflows/resolve-hosts.yml",
    ".github/workflows/pi-canary.yml", "future.config", "unknown\nREADME.md"]) {
    await t.test(path, (t) => {
      const f = fixture(t);
      f.write("README.md", "docs also changed\n");
      f.write(path, "runtime change\n");
      assert.ok(planned(f.scope(f.commit()), true).reason.includes(JSON.stringify(path)), "The reason must name the path that required the fleet");
    });
  }
});

test("deletions and runtime renames into documentation cannot hide a fleet change", async (t) => {
  for (const rename of [false, true]) {
    await t.test(rename ? "rename" : "delete", (t) => {
      const f = fixture(t);
      if (rename) {
        mkdirSync(join(f.root, "docs"));
        renameSync(join(f.root, "scripts/qualify.mjs"), join(f.root, "docs/moved.md"));
      } else rmSync(join(f.root, "scripts/qualify.mjs"));
      const plan = planned(f.scope(f.commit()), true);
      assert.ok(plan.files.includes("scripts/qualify.mjs"));
    });
  }
});

test("PR merge-base scope excludes base-only changes while a multi-commit push includes runtime changes", (t) => {
  const f = fixture(t);
  f.write("scripts/qualify.mjs", "base advanced\n");
  const advancedBase = f.commit();
  f.git("checkout", "--quiet", "--detach", f.base);
  f.write("README.md", "PR docs\n");
  const docsHead = f.commit();
  planned(f.scope(docsHead, "pull_request", advancedBase), false);
  f.write("scripts/qualify.mjs", "pushed runtime\n");
  f.commit();
  f.write("docs/guide.md", "last push commit is docs\n");
  planned(f.scope(f.commit(), "push"), true);
});

test("invalid events and unavailable or noncommit refs never emit a fast-path decision", (t) => {
  const f = fixture(t);
  planned(f.scope(f.base), true);
  const blob = f.git("rev-parse", "HEAD:package.json");
  for (const args of [
    ["scope", "--event", "schedule"],
    ["scope", "--event", "pull_request", "--head", f.base],
    ["scope", "--event", "push", "--base", "0".repeat(40), "--head", f.base],
    ["scope", "--event", "push", "--base", blob, "--head", f.base],
    ["scope", "--event", "push", "--base", "--all", "--head", f.base],
    ["scope", "--event", "push", "--base", f.base, "--head", "f".repeat(40)],
  ]) {
    const result = f.invoke(args);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.output, "");
  }
});

test("automation requires every cheap check and only permits an explicit intentional fleet skip", (t) => {
  const f = fixture(t);
  for (const environment of [gate, { ...gate, FLEET_REQUIRED: "false" }, { ...gate, FLEET_REQUIRED: "false", FLEET: "skipped" }]) {
    const result = f.invoke(["check"], environment);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.summary, environment.FLEET === "skipped" ? /not fleet qualification/ : /full fleet qualification/);
  }
  for (const name of ["SCOPE", "HOSTS", "TESTS", "CONFIGURATION"]) {
    for (const state of ["", "failure", "cancelled", "skipped", "unknown"]) {
      const result = f.invoke(["check"], { ...gate, [name]: state, FLEET_REQUIRED: "false", FLEET: "skipped" });
      assert.equal(result.status, 1, `${name}=${state}: ${result.stdout}`);
    }
  }
  for (const required of ["true", "false"]) {
    for (const fleet of ["skipped", "failure", "cancelled", "", "unknown"]) {
      if (fleet === "skipped" && required === "false") continue;
      const result = f.invoke(["check"], { ...gate, FLEET_REQUIRED: required, FLEET: fleet });
      assert.equal(result.status, 1, `required=${required}, fleet=${fleet}: ${result.stdout}`);
      assert.equal(result.summary, "");
    }
  }
  for (const required of ["", "unknown", "False", "0"]) {
    assert.equal(f.invoke(["check"], { ...gate, FLEET_REQUIRED: required }).status, 1, `Unknown scope flag ${required} must fail even with a successful fleet`);
  }
  assert.equal(f.invoke(["check"]).status, 1, "Missing environment must fail");
});

test("a main push intentionally skips the fleet its pull request already qualified", (t) => {
  const f = fixture(t);
  const result = f.invoke(["check"], { ...gate, FLEET: "skipped", EVENT: "push" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.summary, /main push/);
  assert.match(result.summary, /daily canary/);
  for (const event of ["pull_request", "workflow_dispatch", "schedule", ""]) {
    assert.equal(f.invoke(["check"], { ...gate, FLEET: "skipped", EVENT: event }).status, 1, `event=${event || "(none)"}`);
  }
});
