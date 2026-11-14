import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { packageDifference, publishedTarball } from "../scripts/npm-package.mjs";
import { completeRelease, failedRelease, fixture, git, read, success, write } from "./fixtures/npm-version-harness.mjs";

const script = fileURLToPath(new URL("../scripts/npm-version.mjs", import.meta.url));
const repository = "fitchmultz/pi-copy-message";
const marker = (sha) => `<!-- pi-npm-source: ${sha} -->`;

function rawChangelog(f, head = f.ref("main")) {
  const result = spawnSync("git", ["--git-dir", f.remote, "show", `${head}:CHANGELOG.md`], { encoding: "utf8" });
  success(result);
  assert.ok(result.stdout.endsWith("\n"), "Reconciled changelog must retain its final LF");
  return result.stdout;
}

test("supersession rejects the wrong target, published bytes, and a release run that did not fail on main", async (t) => {
  const f = fixture(t);
  const bump = failedRelease(f);
  const fixed = f.advance("Fixed source");
  const baseline = f.state();
  for (const [name, edit, version, source, expected] of [
    ["wrong version", () => {}, "4.0.2", bump, /does not match the latest automatic version/],
    ["wrong source", () => {}, "4.0.1", f.first, /does not match the latest automatic version/],
    ["npm published", (s) => { s.registry.versions["4.0.1"] = { ...s.registry.versions["4.0.0"], version: "4.0.1" }; }, "4.0.1", bump, /already published on npm/],
    ["GitHub published", (s) => { s.releases[1].draft = false; }, "4.0.1", bump, /already published on GitHub/],
    ["missing run", (s) => { s.runs = []; }, "4.0.1", bump, /requires a failed original main release run/],
    ["successful run", (s) => { s.runs[0].conclusion = "success"; }, "4.0.1", bump, /requires a failed original main release run/],
    ["active run", (s) => { s.runs[0].status = "in_progress"; }, "4.0.1", bump, /requires a failed original main release run/],
    ["other branch", (s) => { s.runs[0].head_branch = "other"; }, "4.0.1", bump, /requires a failed original main release run/],
  ]) await t.test(name, () => {
    f.setState((s) => { Object.assign(s, structuredClone(baseline)); edit(s); });
    const records = f.state().releases;
    const result = f.reconcile("workflow_dispatch", ["--supersede-version", version, "--supersede-source", source]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(f.ref("main"), fixed);
    assert.deepEqual(f.state().releases, records);
  });
});

test("only the trusted main version caller's operator dispatch can request a paired supersession", (t) => {
  const f = fixture(t);
  const args = ["reconcile", "--source", f.source, "--app-slug", "pi-durable", "--supersede-version", "4.0.1", "--supersede-source", f.first];
  for (const [event, env, expected] of [
    ["push", {}, /operator workflow_dispatch/],
    ["workflow_dispatch", { GITHUB_REF: "refs/heads/other" }, /only runs from main/],
    ["workflow_dispatch", { GITHUB_ACTIONS: "false" }, /only runs in GitHub Actions/],
    ["workflow_dispatch", { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@refs/heads/main` }, /trusted npm-version.yml caller/],
  ]) {
    const result = f.invoke(args, event, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
  const unpaired = f.reconcile("workflow_dispatch", ["--supersede-version", "4.0.1"]);
  assert.notEqual(unpaired.status, 0);
  assert.match(unpaired.stderr, /requires both --supersede-version and --supersede-source/);
  assert.equal(f.ref("main"), f.first);
});

test("direct release commits apply the project formatter across releases", (t) => {
  const f = fixture(t);
  const manifest = read(join(f.writer, "package.json"));
  manifest.scripts = { format: "node format.cjs" };
  write(join(f.writer, "package.json"), manifest);
  writeFileSync(join(f.writer, "format.cjs"), `const fs = require("node:fs");
const path = "CHANGELOG.md";
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace(/^\\* /gm, "- "));
`);
  git(f.writer, "add", ".");
  git(f.writer, "commit", "--quiet", "-m", "Add project formatter");
  git(f.writer, "push", "--quiet", "origin", "main");
  success(f.reconcile());
  const firstBump = f.ref("main");
  let notes = rawChangelog(f, firstBump);
  assert.match(notes, /\n- Add project formatter\n/);
  assert.doesNotMatch(notes, /\n\* Add project formatter/);

  completeRelease(f, firstBump, "4.0.1", f.first);
  const nextSource = f.advance("A later main merge", "* Newly merged changelog note.");
  success(f.reconcile());
  const secondBump = f.ref("main");
  notes = rawChangelog(f, secondBump);
  assert.match(notes, /\n- Newly merged changelog note\./);
  assert.doesNotMatch(notes, /\n\* Newly merged changelog note\./);
  assert.match(notes, /\n- A later main merge\n/);
  assert.doesNotMatch(notes, /\n\* A later main merge/);
  assert.match(readFileSync(f.output, "utf8"), new RegExp(`commit=${secondBump}\\nversion=4\\.0\\.2\\nsource=${nextSource}`));
});

test("direct release commit ships current main, holds while release is incomplete, and advances after publication", (t) => {
  const f = fixture(t);
  const second = f.advance("Another main merge", "- Newly merged changelog note.");
  const committed = f.reconcile();
  success(committed);
  assert.match(committed.stdout, /Could not compare main with the published package, so it is released as a change: .*no tarball URL/);

  const bump = f.ref("main");
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", second, bump), second);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${bump}:package.json`)).version, "4.0.1");
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${bump}:package-lock.json`)).packages[""].version, "4.0.1");
  assert.match(git(f.root, "--git-dir", f.remote, "show", "-s", "--format=%B", bump), new RegExp(`^chore\\(release\\): 4\\.0\\.1\\n\\n${marker(f.first)}`));
  assert.match(readFileSync(f.output, "utf8"), new RegExp(`commit=${bump}\\nversion=4\\.0\\.1\\nsource=${f.first}`));

  const notes = rawChangelog(f, bump);
  assert.equal(
    /<!-- npm-release:unreleased:start -->\n([\s\S]*?)\n<!-- npm-release:unreleased:end -->/.exec(notes)?.[1],
    "- Newly merged changelog note.\n\n### Changed\n\nA real pending change.\nA second pending change.",
  );
  const pendingEnd = "<!-- npm-release:unreleased:end -->";
  assert.equal(
    notes.slice(notes.indexOf(pendingEnd) + pendingEnd.length, notes.indexOf("## 4.0.0")).trim(),
    `- Initial source ([${f.first.slice(0, 7)}](https://github.com/${repository}/commit/${f.first}))\n\n### What's Changed\n\n` +
      "* Initial source\n* Another main merge\n\n" +
      `**Full Changelog**: https://github.com/${repository}/compare/v4.0.0...v4.0.1`,
  );

  const later = f.advance("A later main merge");
  f.setState((s) => {
    s.runs = [{ id: 99, head_sha: bump, status: "completed", conclusion: "failure" }];
    s.artifacts = [{ name: `npm-candidate-${bump}`, expired: false }];
  });
  const waiting = f.reconcile("schedule");
  success(waiting);
  assert.match(waiting.stdout, /Waiting for pi-copy-message@4\.0\.1 to complete/);
  assert.doesNotMatch(waiting.stdout, /published package/, "A release in flight is not compared");
  assert.equal(f.ref("main"), later, "No second release commit may be created while 4.0.1 is incomplete");
  assert.match(readFileSync(f.log, "utf8"), /POST \/repos\/fitchmultz\/pi-copy-message\/actions\/runs\/99\/rerun-failed-jobs/);

  f.setState((s) => { s.artifacts[0].expired = true; });
  success(f.reconcile("schedule"));
  assert.match(readFileSync(f.log, "utf8"), /POST \/repos\/fitchmultz\/pi-copy-message\/actions\/runs\/99\/rerun\n/);

  f.setState((s) => {
    s.runs = [];
    s.releases = [{ tag_name: "v4.0.1", draft: true, body: `<!-- pi-npm-release: ${bump} sha512-original -->` }];
  });
  const missingRun = f.reconcile("schedule");
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /No original release run remains.*cannot reproduce its provenance/);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /\/dispatches/);

  completeRelease(f, bump, "4.0.1", f.first, "sha512-verified-bytes");
  success(f.reconcile("workflow_run"));
  const nextBump = f.ref("main");
  assert.notEqual(nextBump, later);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${nextBump}:package.json`)).version, "4.0.2");
  assert.match(git(f.root, "--git-dir", f.remote, "show", "-s", "--format=%B", nextBump), new RegExp(marker(later)));
});

test("concurrent pushes to main during versioning retry cleanly on the fast-forwarded head", (t) => {
  const f = fixture(t);
  f.setState((s) => {
    s.concurrentAdvances = ["Concurrent main merge 1", "Concurrent main merge 2"];
  });
  const result = f.reconcile();
  success(result);
  assert.match(result.stdout, /Main advanced past .* before fast-forward \(attempt 1\/3\); retrying/);
  assert.match(result.stdout, /Main advanced past .* before fast-forward \(attempt 2\/3\); retrying/);
  const bump = f.ref("main");
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${bump}:package.json`)).version, "4.0.1");
  assert.equal(git(f.root, "--git-dir", f.remote, "show", `${bump}:concurrent.txt`), "Concurrent main merge 2");
  const notes = rawChangelog(f, bump);
  assert.match(notes, /\* Concurrent main merge 1\n\* Concurrent main merge 2\n/);
});

test("unverified or human commits carrying a source marker are ignored as release sources, not treated as Bot version commits", (t) => {
  const f = fixture(t);
  git(f.writer, "pull", "--quiet", "--ff-only", "origin", "main");
  const changelog = join(f.writer, "CHANGELOG.md");
  writeFileSync(changelog, readFileSync(changelog, "utf8").replace("## Unreleased\n", "## Unreleased\n\n- Manual edit.\n"));
  git(f.writer, "add", "CHANGELOG.md");
  git(f.writer, "commit", "--quiet", "-m", "chore(release): 4.0.1", "-m", marker(f.first));
  git(f.writer, "push", "--quiet", "origin", "main");
  const spoofed = f.ref("main");

  success(f.reconcile());
  const realBump = f.ref("main");
  assert.notEqual(realBump, spoofed, "Human commit with release subject and marker must not halt versioning");
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${realBump}:package.json`)).version, "4.0.1");
});

test("nothing is released when main matches the published release apart from version metadata", (t) => {
  const f = fixture(t, { exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.cjs" } } });
  git(f.writer, "pull", "--quiet", "--ff-only", "origin", "main");
  git(f.writer, "revert", "--no-edit", f.first);
  git(f.writer, "push", "--quiet", "origin", "main");
  const reverted = f.ref("main");
  const idle = f.reconcile();
  success(idle);
  assert.match(idle.stdout, /Main has nothing to release since v4\.0\.0/);
  assert.doesNotMatch(idle.stdout, /published package/, "Unchanged repository files need no package comparison");
  assert.equal(f.ref("main"), reverted);

  const manifest = read(join(f.writer, "package.json"));
  manifest.exports = { ".": { default: "./index.cjs", import: "./index.js", types: "./index.d.ts" } };
  write(join(f.writer, "package.json"), manifest);
  git(f.writer, "add", "package.json");
  git(f.writer, "commit", "--quiet", "-m", "Reorder export conditions");
  git(f.writer, "push", "--quiet", "origin", "main");
  success(f.reconcile());
  const released = f.ref("main");
  assert.notEqual(released, reverted, "Reordered package.json exports conditions must trigger a release");
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${released}:package.json`)).version, "4.0.1");
});

test("a package is the published one only when every installed file and manifest field is the same", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "npm-package-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = (name, edit) => {
    const directory = join(root, name);
    mkdirSync(join(directory, "bin"), { recursive: true });
    write(join(directory, "package.json"), {
      name: "pi-copy-message",
      version: "4.0.0",
      exports: { import: "./index.js", default: "./index.cjs" },
      scripts: { test: "node --test", postinstall: "node index.js" },
      dependencies: { typebox: "1.0.0" },
      devDependencies: { oxlint: "1.0.0" },
    });
    writeFileSync(join(directory, "index.js"), "export const copied = true;\n");
    writeFileSync(join(directory, "bin", "copy.sh"), "#!/bin/sh\n");
    writeFileSync(join(directory, "CHANGELOG.md"), "## 4.0.0\n");
    edit?.(directory, (change) => {
      const manifest = read(join(directory, "package.json"));
      change(manifest);
      write(join(directory, "package.json"), manifest);
    });
    const [packed] = Object.values(JSON.parse(spawnSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: directory, encoding: "utf8" }).stdout));
    return join(directory, packed.filename);
  };
  const published = pack("published");
  for (const [name, edit, expected] of [
    ["version metadata and development-only fields", (directory, manifest) => {
      manifest((value) => { value.version = "4.0.1"; value.devDependencies.oxlint = "2.0.0"; value.scripts.test = "node --test test/"; value.scripts.lint = "oxlint"; });
      writeFileSync(join(directory, "CHANGELOG.md"), "## 4.0.1\n\n## 4.0.0\n");
      mkdirSync(join(directory, "changelog.d"), { recursive: true });
      writeFileSync(join(directory, "changelog.d", "README.md"), "# Pending notes\n");
      writeFileSync(join(directory, "changelog.d", "note.md"), "- Ignored fragment.\n");
    }, null],
    ["a changed file", (directory) => writeFileSync(join(directory, "index.js"), "export const copied = false;\n"), "index.js differs"],
    ["a new file", (directory) => writeFileSync(join(directory, "extra.js"), ""), "extra.js is new"],
    ["a removed file", (directory) => rmSync(join(directory, "bin", "copy.sh")), "bin/copy.sh is no longer packed"],
    ["an executable file", (directory) => chmodSync(join(directory, "bin", "copy.sh"), 0o755), "bin/copy.sh differs"],
    ["a runtime dependency", (directory, manifest) => manifest((value) => { value.dependencies.typebox = "1.0.1"; }), "package.json differs"],
    ["an install script", (directory, manifest) => manifest((value) => { value.scripts.postinstall = "node bin/copy.sh"; }), "package.json differs"],
    ["the order of export conditions", (directory, manifest) => manifest((value) => { value.exports = { default: "./index.cjs", import: "./index.js" }; }), "package.json differs"],
  ]) await t.test(name, () => {
    assert.equal(packageDifference(pack(name, edit), published, join(root, `${name} files`), process.env), expected);
  });
  await t.test("the published bytes must match the registry integrity", async (t) => {
    const bytes = readFileSync(published);
    t.mock.method(globalThis, "fetch", async () => new Response(bytes));
    const dist = {
      tarball: "https://registry.npmjs.org/pi-copy-message/-/pi-copy-message-4.0.0.tgz",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
    assert.deepEqual(readFileSync(await publishedTarball({ dist }, root)), bytes);
    await assert.rejects(
      publishedTarball({ dist: { ...dist, integrity: `sha512-${createHash("sha512").update("other").digest("base64")}` } }, root),
      /differs from its registry integrity/,
    );
  });
});

test("versioned changelogs preserve notes and prior releases when headings have no blank line", (t) => {
  const f = fixture(t, { unreleased: false });
  git(f.writer, "pull", "--quiet", "--ff-only", "origin", "main");
  writeFileSync(join(f.writer, "CHANGELOG.md"), "# Changes\n## Unreleased\n- Tight unreleased note.\n## 4.0.0\nPrevious release.\n");
  writeFileSync(join(f.writer, "change.txt"), "Updated");
  git(f.writer, "add", ".");
  git(f.writer, "commit", "--quiet", "-m", "Tight changelog");
  git(f.writer, "push", "--quiet", "origin", "main");
  success(f.reconcile());
  const notes = rawChangelog(f);
  assert.match(notes, /## 4\.0\.1[\s\S]*- Tight unreleased note\.[\s\S]*## 4\.0\.0\nPrevious release\./);
});

test("changelog.d/*.md fragments sort deterministically, keep README.md, and nest level-2 headings", (t) => {
  const f = fixture(t, { unreleased: false });
  const manifest = read(join(f.writer, "package.json"));
  manifest.scripts = { format: "node format.cjs" };
  write(join(f.writer, "package.json"), manifest);
  writeFileSync(join(f.writer, "format.cjs"), `const fs = require("node:fs");
const path = "CHANGELOG.md";
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace(/^\\* /gm, "- "));
`);
  mkdirSync(join(f.writer, "changelog.d"), { recursive: true });
  writeFileSync(join(f.writer, "changelog.d", "README.md"), "# Release fragments\n");
  writeFileSync(join(f.writer, "changelog.d", "20-second.md"), "## Added\n\n* Second fragment note.\n");
  writeFileSync(join(f.writer, "changelog.d", "10-first.md"), "* First fragment note.\n");
  git(f.writer, "add", ".");
  git(f.writer, "commit", "--quiet", "-m", "Add initial fragments");
  git(f.writer, "push", "--quiet", "origin", "main");

  success(f.reconcile());
  const head = f.ref("main");
  const listed = git(f.root, "--git-dir", f.remote, "ls-tree", "--name-only", "-r", head, "--", "changelog.d");
  assert.equal(listed, "changelog.d/README.md", "Consumed fragments must be removed while keeping README.md");
  const notes = rawChangelog(f, head);
  assert.equal(
    /<!-- npm-release:unreleased:start -->\n([\s\S]*?)\n<!-- npm-release:unreleased:end -->/.exec(notes)?.[1],
    "- First fragment note.\n\n### Added\n\n- Second fragment note.",
  );
  const heading = /^##[ \t]+\d+\.\d+\.\d+[^\n]*$/m.exec(notes);
  assert.ok(heading, "Version section heading is missing");
  const rest = notes.slice(heading.index + heading[0].length);
  const next = /^##[ \t]+/m.exec(rest);
  const section = rest.slice(0, next === null ? rest.length : next.index);
  assert.ok(section.includes("<!-- npm-release:unreleased:end -->"), "Note markers must stay inside the version section");
});

test("version automation stays held when a package's required release gates are not wired", () => {
  for (const name of ["pi-subagents", "pi-agent-browser-native", "pi-oracle", "pi-cursor-sdk", "pi-zai-mcp", "pi-codex-goal", "pi-posthorse", "pi-mcp-adapter"]) {
    const result = spawnSync(process.execPath, [script, "reconcile", "--source", ".", "--app-slug", "pi-durable"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: `fitchmultz/${name}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, name === "pi-cursor-sdk" ? /exact-diff pre-commit and pre-push review/ : /package-specific release qualification/);
  }
});

test("a qualified caller versions its package on main, and cannot bypass exact-diff version review", (t) => {
  const f = fixture(t, { repo: "fitchmultz/pi-agent-browser-native", packageName: "pi-agent-browser-native" });
  const held = f.reconcile();
  assert.notEqual(held.status, 0);
  assert.match(held.stderr, /package-specific release qualification/);
  success(f.reconcile(undefined, ["--package-qualified"]));
  const head = f.ref("main");
  assert.notEqual(head, f.first);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package.json`)).version, "4.0.1");

  const exactDiff = spawnSync(process.execPath, [script, "reconcile", "--package-qualified"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "fitchmultz/pi-cursor-sdk" },
  });
  assert.notEqual(exactDiff.status, 0);
  assert.match(exactDiff.stderr, /exact-diff pre-commit and pre-push review/);
});

test("Cursor version automation reviews the exact staged tree and outgoing commit before updating main", (t) => {
  const f = fixture(t, { repo: "fitchmultz/pi-cursor-sdk", packageName: "pi-cursor-sdk", versionReview: true });
  const args = ["--package-qualified", "--version-reviewed"];
  const reviews = () => readFileSync(join(f.root, "review.log"), "utf8").trim().split("\n").map(JSON.parse);

  success(f.reconcile(undefined, args));
  const bump = f.ref("main");
  const records = reviews();
  assert.deepEqual(records.map(({ phase }) => phase), ["pre-commit", "pre-push"]);
  assert.equal(records[0].head, f.first);
  assert.match(records[0].staged, /CHANGELOG\.md/);
  assert.match(records[0].staged, /package-lock\.json/);
  assert.equal(records[0].remoteMain, f.first, "Remote main must not advance before pre-commit and pre-push pass");
  assert.equal(records[1].base, f.first);
  assert.equal(records[1].staged, "");
  assert.equal(records[1].remoteMain, f.first, "Remote main must not advance before pre-push completes");
  assert.equal(
    git(f.source, "rev-parse", `${records[1].head}^{tree}`),
    git(f.root, "--git-dir", f.remote, "rev-parse", `${bump}^{tree}`),
    "Published GitHub-signed commit tree must match the reviewed local tree byte-for-byte",
  );
  for (const record of records) {
    assert.deepEqual(record.leaked, []);
    assert.equal(record.zai, "zai-fixture");
    assert.equal(realpathSync(record.automation), realpathSync(script));
  }
});

test("a failed Cursor version review stops before remote main is updated", async (t) => {
  for (const phase of ["pre-commit", "pre-push"]) await t.test(phase, (t) => {
    const f = fixture(t, { repo: "fitchmultz/pi-cursor-sdk", packageName: "pi-cursor-sdk", versionReview: true });
    writeFileSync(join(f.root, `deny-${phase}`), "");
    const result = f.reconcile(undefined, ["--package-qualified", "--version-reviewed"]);
    assert.notEqual(result.status, 0);
    assert.equal(f.ref("main"), f.first, "Remote main must remain untouched when version review fails");
    const head = git(f.source, "rev-parse", "HEAD");
    if (phase === "pre-commit") assert.equal(head, f.first);
    else assert.notEqual(head, f.first);
  });
});
