import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { packageDifference, publishedTarball } from "../scripts/npm-package.mjs";
import { fixture, git, read, write, success, check, failedRelease } from "./fixtures/npm-version-harness.mjs";

const script = fileURLToPath(new URL("../scripts/npm-version.mjs", import.meta.url));
const remediation = fileURLToPath(new URL("../scripts/npm-remediation.mjs", import.meta.url));
const repository = "fitchmultz/pi-copy-message";
const marker = (sha) => `<!-- pi-npm-source: ${sha} -->`;

function rawChangelog(f, head) {
  const result = spawnSync("git", ["--git-dir", f.remote, "show", `${head}:CHANGELOG.md`], { encoding: "utf8" });
  success(result);
  assert.ok(result.stdout.endsWith("\n"), "Reconciled changelog must retain its final LF");
  return result.stdout;
}

test("supersession rejects the wrong target, published bytes, and a release run that did not fail on main", async (t) => {
  const f = fixture(t);
  const bump = failedRelease(f);
  f.advance("Fixed source");
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
    assert.notEqual(result.status, 0); assert.match(result.stderr, expected);
    assert.equal(f.state().open.length, 0);
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
    assert.notEqual(result.status, 0); assert.match(result.stderr, expected);
  }
  const unpaired = f.reconcile("workflow_dispatch", ["--supersede-version", "4.0.1"]);
  assert.notEqual(unpaired.status, 0); assert.match(unpaired.stderr, /requires both --supersede-version and --supersede-source/);
  assert.equal(f.state().open.length, 0);
});

test("version creation and main updates use the project's formatter", (t) => {
  const f = fixture(t);
  const manifest = read(join(f.writer, "package.json"));
  manifest.scripts = { format: "node format.cjs" };
  write(join(f.writer, "package.json"), manifest);
  writeFileSync(join(f.writer, "format.cjs"), `const fs = require("node:fs");
const path = "CHANGELOG.md";
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace(/^\\* /gm, "- "));
`);
  git(f.writer, "add", "."); git(f.writer, "commit", "--quiet", "-m", "Add project formatter");
  git(f.writer, "push", "--quiet", "origin", "main");
  success(f.reconcile());
  const branch = `npm-version/${f.first}`;
  let head = f.ref(branch);
  let notes = git(f.root, "--git-dir", f.remote, "show", `${head}:CHANGELOG.md`);
  assert.match(notes, /\n- Add project formatter\n/);
  assert.doesNotMatch(notes, /\n\* Add project formatter/);
  f.advance("A later main merge", "* Newly merged changelog note.");
  success(f.reconcile());
  head = f.ref(branch);
  notes = git(f.root, "--git-dir", f.remote, "show", `${head}:CHANGELOG.md`);
  assert.match(notes, /\n- Newly merged changelog note\./);
  assert.doesNotMatch(notes, /\n\* Newly merged changelog note\./);
  assert.match(notes, /\n- A later main merge\n/);
  assert.doesNotMatch(notes, /\n\* A later main merge/);
});

test("remediation refuses a PR that is not the App-owned version for the selected source", (t) => {
  const f = fixture(t); success(f.reconcile());
  const head = f.ref(`npm-version/${f.first}`);
  f.setState((state) => {
    state.open[0].author = "someone-else";
    state.checks = [check("github-actions", "compatibility / compatibility", head, f.first, "failure")];
  });
  let result = f.remediate(head);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not owned by the release App/);
  assert.equal(f.state().submissions, undefined);
  f.setState((state) => {
    delete state.open[0].author;
    state.open[0].body = marker("a".repeat(40));
  });
  result = f.remediate(head);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source marker changed/);
  assert.equal(f.state().submissions, undefined);
});

test("version PR follows advancing main, and the next one starts after the commits its release published", (t) => {
  const f = fixture(t);
  const second = f.advance("Another main merge");
  const opened = f.reconcile();
  success(opened);
  // The fixture registry records no tarball for 4.0.0, so main cannot be proven to build the published package.
  assert.match(opened.stdout, /Could not compare main with the published package, so it is released as a change: .*no tarball URL/);
  const branch = `npm-version/${f.first}`;
  assert.equal(f.state().open[0].branch, branch);
  let head = f.ref(branch);
  rawChangelog(f, head);
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", second, head), second);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package.json`)).version, "4.0.1");
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package-lock.json`)).packages[""].version, "4.0.1");
  assert.match(git(f.root, "--git-dir", f.remote, "show", `${head}:CHANGELOG.md`), /## 4\.0\.1[\s\S]*A real pending change\.[\s\S]*\* Another main merge\n/);
  git(f.writer, "fetch", "--quiet", "origin", branch);
  git(f.writer, "switch", "--quiet", "--detach", "FETCH_HEAD");
  const changelog = join(f.writer, "CHANGELOG.md");
  writeFileSync(changelog, readFileSync(changelog, "utf8").replace("* Another main merge", "* Another main merge, described by hand"));
  git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Describe a change by hand");
  git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  git(f.writer, "switch", "--quiet", "main");
  success(f.reconcile());
  writeFileSync(changelog, readFileSync(changelog, "utf8").replace("A second pending change.", "A second pending change.\n\n- Appended ordinary note."));
  const third = f.advance("Third main merge", "- Newly merged changelog note.");
  const updated = f.reconcile();
  success(updated);
  assert.doesNotMatch(updated.stdout, /published package/, "An open version PR is not compared again");
  head = f.ref(branch);
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", third, head), third);
  const mergedNotes = rawChangelog(f, head);
  assert.equal(/<!-- npm-release:unreleased:start -->\n([\s\S]*?)\n<!-- npm-release:unreleased:end -->/.exec(mergedNotes)?.[1],
    "- Newly merged changelog note.\n\n### Changed\n\nA real pending change.\nA second pending change.\n\n- Appended ordinary note.");
  assert.match(mergedNotes, /## Unreleased\s+## 4\.0\.1[\s\S]*Newly merged changelog note\./);
  // fitchmultz/pi-subagents#347 kept the notes of the main it opened on through four updates; each one shipped a
  // change its section did not list.
  const pendingEnd = "<!-- npm-release:unreleased:end -->";
  assert.equal(mergedNotes.slice(mergedNotes.indexOf(pendingEnd) + pendingEnd.length, mergedNotes.indexOf("## 4.0.0")).trim(),
    `- Initial source ([${f.first.slice(0, 7)}](https://github.com/${repository}/commit/${f.first}))\n\n### What's Changed\n\n`
    + "* Initial source\n* Another main merge\n* Third main merge\n\n"
    + `**Full Changelog**: https://github.com/${repository}/compare/v4.0.0...v4.0.1`);
  assert.match(git(f.root, "--git-dir", f.remote, "show", "-s", "--format=%B", head), new RegExp(marker(f.first)));

  git(f.writer, "fetch", "--quiet", "origin", branch);
  git(f.writer, "merge", "--squash", "FETCH_HEAD");
  git(f.writer, "commit", "--quiet", "-m", "chore(release): 4.0.1", "-m", marker(f.first));
  git(f.writer, "push", "--quiet", "origin", "main");
  const bump = git(f.writer, "rev-parse", "HEAD");
  const later = f.advance("A later main merge");
  f.setState((s) => {
    s.open = []; s.merged.push({ sha: bump, branch });
    s.runs = [{ id: 99, head_sha: bump, status: "completed", conclusion: "failure" }];
    s.artifacts = [{ name: `npm-candidate-${bump}`, expired: false }];
  });
  const waiting = f.reconcile("schedule");
  success(waiting);
  assert.match(waiting.stdout, /Waiting for pi-copy-message@4\.0\.1 to complete/);
  assert.doesNotMatch(waiting.stdout, /published package/, "A release in flight is not compared");
  assert.match(readFileSync(f.log, "utf8"), /POST \/repos\/fitchmultz\/pi-copy-message\/actions\/runs\/99\/rerun-failed-jobs/);
  f.setState((s) => { s.artifacts[0].expired = true; });
  success(f.reconcile("schedule"));
  assert.match(readFileSync(f.log, "utf8"), /POST \/repos\/fitchmultz\/pi-copy-message\/actions\/runs\/99\/rerun\n/);
  assert.equal(f.state().open.length, 0);
  f.setState((s) => {
    s.runs = [];
    s.releases = [{ tag_name: "v4.0.1", draft: true, body: `<!-- pi-npm-release: ${bump} sha512-original -->` }];
  });
  const missingRun = f.reconcile("schedule");
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /No original release run remains.*cannot reproduce its provenance/);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /\/dispatches/);

  git(f.writer, "tag", "v4.0.1", bump); git(f.writer, "push", "--quiet", "origin", "v4.0.1");
  const integrity = "sha512-verified-bytes";
  f.setState((s) => {
    s.registry.versions["4.0.1"] = { ...s.registry.versions["4.0.0"], version: "4.0.1", dist: { integrity } };
    s.registry["dist-tags"].latest = "4.0.1";
    s.releases = [{ tag_name: "v4.0.1", draft: false, body: `<!-- pi-npm-release: ${bump} ${integrity} -->\n${marker(f.first)}` }];
  });
  success(f.reconcile("workflow_run"));
  const next = f.state().open[0];
  // `second` merged into the 4.0.1 version PR and shipped with it (fitchmultz/pi-oracle#82 reopened such a source).
  assert.equal(next.branch, `npm-version/${later}`);
  const nextHead = f.ref(next.branch);
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", later, nextHead), later);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${nextHead}:package.json`)).version, "4.0.2");
});

test("an update from main that moves the PR to a later version regenerates its notes for that version", (t) => {
  const f = fixture(t); success(f.reconcile());
  for (const file of ["package.json", "package-lock.json"]) {
    const manifest = read(join(f.writer, file));
    manifest.version = "4.1.0";
    if (manifest.packages) manifest.packages[""].version = "4.1.0";
    write(join(f.writer, file), manifest);
  }
  git(f.writer, "add", "."); git(f.writer, "commit", "--quiet", "-m", "Start the 4.1 line");
  git(f.writer, "push", "--quiet", "origin", "main");
  success(f.reconcile());
  const head = f.ref(`npm-version/${f.first}`);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package.json`)).version, "4.1.1");
  const notes = rawChangelog(f, head);
  assert.match(notes, /## Unreleased\s+## 4\.1\.1 - /);
  assert.doesNotMatch(notes, /4\.0\.1/);
  assert.ok(notes.includes(`* Start the 4.1 line\n\n**Full Changelog**: https://github.com/${repository}/compare/v4.0.0...v4.1.1\n`));
});

test("nothing is released when main and the version PR match the published release apart from version metadata", (t) => {
  // fitchmultz/pi-cursor-sdk#406 would have published 0.5.10 after #405 reverted #404.
  const f = fixture(t); success(f.reconcile());
  const branch = `npm-version/${f.first}`;
  git(f.writer, "pull", "--quiet", "--ff-only", "origin", "main");
  git(f.writer, "revert", "--no-edit", f.first);
  git(f.writer, "push", "--quiet", "origin", "main");
  const versionHead = git(f.root, "--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`);
  const closed = f.reconcile();
  success(closed);
  assert.match(closed.stdout, /Closed version PR #\d+; nothing changed since v4\.0\.0/);
  // The workflow reviews and merges whatever head reconcile pushes, so the PR closes without an update from main.
  assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`), versionHead);
  assert.equal(f.state().open.length, 0);
  assert.match(readFileSync(f.log, "utf8"), new RegExp(`DELETE /repos/fitchmultz/pi-copy-message/git/refs/heads/${branch}`));
  const idle = f.reconcile();
  success(idle);
  assert.match(idle.stdout, /Main has nothing to release since v4\.0\.0/);
  assert.doesNotMatch(idle.stdout, /published package/, "Unchanged repository files need no package comparison");
  assert.equal(f.state().open.length, 0);
});

test("a package is the published one only when every installed file and manifest field is the same", async (t) => {
  // 44 of 145 fleet releases (2026-11-02 to 2026-11-11) republished the previous version's installable package.
  const root = mkdtempSync("/tmp/npm-package-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = (name, edit) => {
    const directory = join(root, name);
    mkdirSync(join(directory, "bin"), { recursive: true });
    write(join(directory, "package.json"), { name: "pi-copy-message", version: "4.0.0", exports: { import: "./index.js", default: "./index.cjs" },
      scripts: { test: "node --test", postinstall: "node index.js" }, dependencies: { typebox: "1.0.0" }, devDependencies: { oxlint: "1.0.0" } });
    writeFileSync(join(directory, "index.js"), "export const copied = true;\n");
    writeFileSync(join(directory, "bin", "copy.sh"), "#!/bin/sh\n");
    writeFileSync(join(directory, "CHANGELOG.md"), "## 4.0.0\n");
    edit?.(directory, (change) => { const manifest = read(join(directory, "package.json")); change(manifest); write(join(directory, "package.json"), manifest); });
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
    const dist = { tarball: "https://registry.npmjs.org/pi-copy-message/-/pi-copy-message-4.0.0.tgz",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    assert.deepEqual(readFileSync(await publishedTarball({ dist }, root)), bytes);
    await assert.rejects(publishedTarball({ dist: { ...dist, integrity: `sha512-${createHash("sha512").update("other").digest("base64")}` } }, root),
      /differs from its registry integrity/);
  });
});

test("resolved Pi findings trigger one genuine fresh review without dismissing unresolved or standalone findings", (t) => {
  const f = fixture(t); success(f.reconcile());
  const branch = `npm-version/${f.first}`;
  const original = f.ref(branch);
  f.setState((s) => {
    s.checks = [check("pi-durable", "Pi Durable Review", original, f.first, "failure")];
    s.threads = [{ isResolved: false, comments: { nodes: [{ author: { login: "pi-durable" }, originalCommit: { oid: original }, body: "<!-- pi-durable-review:findings -->" }] } }];
  });
  let result = f.reconcile();
  success(result); assert.equal(f.ref(branch), original);
  f.setState((s) => { s.threads[0].isResolved = true; s.comments = [{ body: "<!-- pi-durable-review:standalone -->", html_url: "https://github.com/example/finding" }]; });
  result = f.reconcile();
  success(result); assert.equal(f.ref(branch), original);
  f.setState((s) => {
    s.comments = [];
    s.checks.push(check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", original, f.first),
      check("github-actions", "compatibility / compatibility", original, f.first));
  });
  const wait = () => f.invoke(["wait", "--pull", "1", "--head", original, "--cursor", "200"]);
  success(wait());
  assert.match(readFileSync(f.output, "utf8"), /refresh=true/);
  f.setState((s) => { s.checks.at(-1).conclusion = "failure"; });
  result = wait();
  success(result); assert.match(readFileSync(f.output, "utf8"), /refresh=true/);
  assert.match(result.stdout, /compatibility \/ compatibility needs remediation/);
  f.setState((s) => { s.checks.at(-1).conclusion = "success"; });
  success(f.reconcile());
  const refreshed = f.ref(branch);
  assert.notEqual(refreshed, original);
  assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", `${refreshed}^{tree}`), git(f.root, "--git-dir", f.remote, "rev-parse", `${original}^{tree}`));
  assert.match(git(f.root, "--git-dir", f.remote, "show", "-s", "--format=%B", refreshed), /recheck reviewed disposition/);
  success(f.reconcile());
  assert.equal(f.ref(branch), refreshed);
});

test("a Cursor review without a report gets one fresh review on an empty head, then stops visibly", async (t) => {
  // fitchmultz/pi-zai-mcp#55 waited on Cursor's "Automation encountered an error" neutral check until the job timed out.
  const cursorName = "Cursor Automation: PR Bug Review - Maintained Repos";
  const errored = (head, id) => {
    const cursor = check("cursor", cursorName, head, null, "neutral");
    cursor.id = id; cursor.details_url = `https://cursor.com/agents/bc-${String(id).repeat(8).slice(0, 8)}-0000-4000-8000-000000000000`;
    cursor.output = { title: cursorName, summary: "Automation encountered an error" };
    return cursor;
  };
  const setup = (t) => {
    const f = fixture(t); success(f.reconcile());
    const branch = `npm-version/${f.first}`;
    const original = f.ref(branch);
    f.setState((s) => {
      s.checks = [errored(original, 201), check("pi-durable", "Pi Durable Review", original, f.first),
        check("github-actions", "compatibility / compatibility", original, f.first)];
    });
    const result = f.remediate(original);
    success(result);
    assert.match(result.stdout, /Cursor review ended without a report/);
    assert.match(readFileSync(f.output, "utf8"), /refresh=true/);
    assert.equal(f.state().submissions, undefined);
    success(f.reconcile());
    const recheck = f.ref(branch);
    assert.notEqual(recheck, original);
    assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", `${recheck}^{tree}`), git(f.root, "--git-dir", f.remote, "rev-parse", `${original}^{tree}`));
    const message = git(f.root, "--git-dir", f.remote, "show", "-s", "--format=%B", recheck);
    assert.match(message, /^chore\(release\): recheck the unreported Cursor review/);
    assert.ok(message.includes(marker(f.first)));
    return { f, branch, recheck };
  };
  await t.test("a fresh review with a report proceeds", (t) => {
    const { f, recheck } = setup(t);
    const agent = "bc-12121212-1212-4212-8212-121212121212";
    f.setState((s) => {
      const cursor = check("cursor", cursorName, recheck, f.first);
      cursor.id = 202; cursor.details_url = `https://cursor.com/agents/${agent}`;
      s.checks.push(cursor, check("pi-durable", "Pi Durable Review", recheck, f.first),
        check("github-actions", "compatibility / compatibility", recheck, f.first));
      s.cursorReports = { [agent]: "No concrete findings." };
    });
    success(f.remediate(recheck));
    assert.match(readFileSync(f.output, "utf8"), /cursor=202\nready=true/);
  });
  await t.test("a second review without a report fails instead of waiting", (t) => {
    const { f, branch, recheck } = setup(t);
    f.setState((s) => {
      s.checks.push(errored(recheck, 203), check("pi-durable", "Pi Durable Review", recheck, f.first),
        check("github-actions", "compatibility / compatibility", recheck, f.first));
    });
    const result = f.remediate(recheck);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recheck head also ended without a report: https:\/\/cursor\.com\/agents\/bc-20320320/);
    assert.doesNotMatch(readFileSync(f.output, "utf8"), /refresh=true|ready=true/);
    success(f.reconcile());
    assert.equal(f.ref(branch), recheck, "A repeated Cursor error must not push another recheck");
  });
});

test("main may insert or revise unreleased notes without losing reviewed version notes", async (t) => {
  for (const [name, edit, expected] of [
    ["insert", (text) => text.replace("A real pending change.", () => "- Stop enumerating graphemes once a message preview is known to need truncation; preserve preview and copied text.\nA real pending change."), "- Stop enumerating graphemes once a message preview is known to need truncation; preserve preview and copied text."],
    ["revise", (text) => text.replace("A real pending change.", "A corrected pending change."), "A corrected pending change."],
    ["adjacent", (text) => text.replace("## Unreleased\n\n", "## Unreleased\n- New note without a blank line.\n\n").replace("A real pending change.", "A revised pending change."), "- New note without a blank line."],
  ]) await t.test(name, (t) => {
    const f = fixture(t); success(f.reconcile());
    const branch = `npm-version/${f.first}`;
    git(f.writer, "fetch", "--quiet", "origin", branch);
    git(f.writer, "switch", "--quiet", "--detach", "FETCH_HEAD");
    const path = join(f.writer, "CHANGELOG.md");
    const prior = name === "insert" ? "A real pending change." : "A second pending change.";
    // This real pi-posthorse history note contains "$`", which is special in string replacements.
    const correction = "- All-session search and bare-ID history reads use ripgrep (Pi's managed copy, then `PATH`) to skip session files that cannot match. Without ripgrep, and for queries that could match escaped or label-only text (quotes, backslashes, brackets, parentheses, braces, colons, `$`, edge spaces, or phrases such as \"Call ID\" and \"No handoff\"), every file is scanned as before; image-count and comma queries also search every file with an image block. Results always match a full scan.";
    writeFileSync(path, readFileSync(path, "utf8").replace(prior, () => correction));
    git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Address review");
    git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    git(f.writer, "switch", "--quiet", "main");
    writeFileSync(path, edit(readFileSync(path, "utf8")));
    git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Update unreleased notes");
    git(f.writer, "push", "--quiet", "origin", "main");
    success(f.reconcile());
    const notes = rawChangelog(f, f.ref(branch));
    assert.match(notes, /## Unreleased\s+## 4\.0\.1/);
    const released = notes.slice(notes.indexOf("## 4.0.1"));
    assert.ok(released.includes(expected), "Incoming note must be preserved verbatim");
    assert.ok(released.includes(correction), "Reviewed note must be preserved verbatim");
    assert.doesNotMatch(released, new RegExp(prior.replaceAll(".", "\\.")));
  });
});

test("a newly added Unreleased section is included in the version being reviewed", (t) => {
  const f = fixture(t, { unreleased: false }); success(f.reconcile());
  const path = join(f.writer, "CHANGELOG.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("# Changes\n\n", "# Changes\n\n## Unreleased\n\n### Added\n\n- New pending note.\n\n"));
  git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Add unreleased notes");
  git(f.writer, "push", "--quiet", "origin", "main");
  success(f.reconcile());
  const notes = git(f.root, "--git-dir", f.remote, "show", `${f.ref(`npm-version/${f.first}`)}:CHANGELOG.md`);
  assert.match(notes, /## Unreleased\s+## 4\.0\.1[\s\S]*### Added\n\n- New pending note\./);
});

test("versioned changelogs preserve notes and prior releases when headings have no blank line", async (t) => {
  for (const [name, afterHeading] of [
    ["pending note", "- Pending change.\n\n## 4.0.0\n\nPrevious release.\n"],
    ["prior heading", "## 4.0.0\n\nPrevious release.\n"],
  ]) await t.test(name, (t) => {
    const f = fixture(t);
    const path = join(f.writer, "CHANGELOG.md");
    writeFileSync(path, `# Changes\n\n## Unreleased\n${afterHeading}`);
    git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Update changelog");
    git(f.writer, "push", "--quiet", "origin", "main");
    success(f.reconcile());
    const notes = git(f.root, "--git-dir", f.remote, "show", `${f.ref(`npm-version/${f.first}`)}:CHANGELOG.md`);
    const released = notes.slice(notes.indexOf("## 4.0.1"), notes.indexOf("## 4.0.0"));
    assert.match(notes, /## 4\.0\.0\n\nPrevious release\./);
    if (name === "pending note") assert.match(released, /- Pending change\./);
    assert.doesNotMatch(released, /Previous release\./);
  });
});

test("an adjacent main manifest edit survives the automatic version change", (t) => {
  const f = fixture(t); success(f.reconcile());
  const branch = `npm-version/${f.first}`;
  git(f.writer, "fetch", "--quiet", "origin", branch);
  git(f.writer, "switch", "--quiet", "--detach", "FETCH_HEAD");
  const path = join(f.writer, "package.json");
  const reviewed = read(path); reviewed.author = "Reviewed author"; write(path, reviewed);
  git(f.writer, "add", "package.json"); git(f.writer, "commit", "--quiet", "-m", "Address manifest review");
  git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  git(f.writer, "switch", "--quiet", "main");
  const incoming = read(path); incoming.description = "Updated package description"; delete incoming.contributors; write(path, incoming);
  git(f.writer, "add", "package.json"); git(f.writer, "commit", "--quiet", "-m", "Update description");
  git(f.writer, "push", "--quiet", "origin", "main");
  success(f.reconcile());
  const head = f.ref(branch);
  const manifest = JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package.json`));
  const lock = JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package-lock.json`));
  assert.equal(manifest.description, "Updated package description");
  assert.equal(manifest.author, "Reviewed author");
  assert.equal(manifest.contributors, undefined);
  assert.equal(manifest.version, "4.0.1");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
});

test("overlapping reviewer and main note edits remain unresolved", (t) => {
  const f = fixture(t); success(f.reconcile());
  const branch = `npm-version/${f.first}`;
  git(f.writer, "fetch", "--quiet", "origin", branch);
  git(f.writer, "switch", "--quiet", "--detach", "FETCH_HEAD");
  const path = join(f.writer, "CHANGELOG.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("A real pending change.", "Reviewer wording."));
  git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Address review");
  git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  const reviewed = f.ref(branch);
  git(f.writer, "switch", "--quiet", "main");
  writeFileSync(path, readFileSync(path, "utf8").replace("A real pending change.", "Different main wording."));
  git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Revise note");
  git(f.writer, "push", "--quiet", "origin", "main");
  const result = f.reconcile();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Concurrent Unreleased edits need review/);
  assert.equal(f.ref(branch), reviewed);
});

test("merge waits for exact-head compatibility and the Pi-reviewed current base", (t) => {
  const f = fixture(t); success(f.reconcile());
  const head = f.ref(`npm-version/${f.first}`);
  f.setState((s) => { s.checks = [check("pi-durable", "Pi Durable Review", head, f.first),
    check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first)]; });
  const merge = () => f.invoke(["merge", "--source", f.source, "--pull", "1", "--head", head, "--cursor", "200"]);
  let result = merge();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /checks are not complete/);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /^merge /m);
  f.setState((s) => { s.checks.push(check("github-actions", "compatibility / compatibility", head, f.first)); });
  f.setState((s) => { s.checks[1].id = 201; });
  result = merge();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Cursor review changed after its report was handled/);
  f.setState((s) => { s.checks[1].id = 200; });
  f.advance("Main advanced during review");
  result = merge();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /did not review the current base and head/);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /^merge /m);
});

test("a successful Cursor review sends a new inline finding for remediation", (t) => {
  const f = fixture(t); success(f.reconcile());
  const head = f.ref(`npm-version/${f.first}`);
  f.setState((s) => {
    s.checks = [check("pi-durable", "Pi Durable Review", head, f.first),
      check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first),
      check("github-actions", "compatibility / compatibility", head, f.first)];
    s.threads = [{ isResolved: false, comments: { nodes: [{ author: { login: "cursor" }, originalCommit: { oid: head }, body: "A finding" }] } }];
    s.resolveOnFirstLookup = true;
  });
  const result = f.invoke(["wait", "--pull", "1", "--head", head, "--cursor", "200"]);
  success(result);
  assert.match(result.stdout, /New review findings need remediation/);
  assert.match(readFileSync(f.output, "utf8"), /refresh=true/);
});

test("all completed Cursor reports reach a durable disposition and are not resubmitted", (t) => {
  const f = fixture(t); success(f.reconcile());
  const branch = `npm-version/${f.first}`;
  const oldHead = f.ref(branch);
  git(f.writer, "fetch", "--quiet", "origin", branch);
  git(f.writer, "switch", "--quiet", "--detach", "FETCH_HEAD");
  writeFileSync(join(f.writer, "reviewed.txt"), "A reviewed correction\n");
  git(f.writer, "add", "reviewed.txt"); git(f.writer, "commit", "--quiet", "-m", "Address review");
  git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  const head = f.ref(branch);
  git(f.source, "fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  const firstAgent = "bc-11111111-1111-4111-8111-111111111111";
  const nextAgent = "bc-22222222-2222-4222-8222-222222222222";
  f.setState((s) => {
    const earlier = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", oldHead, f.first);
    const current = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first);
    earlier.id = 201; earlier.details_url = `https://cursor.com/agents/${firstAgent}`;
    current.id = 202; current.details_url = `https://cursor.com/agents/${nextAgent}`;
    s.checks = [earlier, current, check("pi-durable", "Pi Durable Review", head, f.first),
      check("github-actions", "compatibility / compatibility", head, f.first)];
    s.cursorReports = { [firstAgent]: "Earlier review: no concrete findings.", [nextAgent]: "Current review: no concrete findings." };
    s.durableOutcome = { status: "done", text: 'Verification complete.\n\n{"status":"no_findings","reason":"No concrete findings remain","evidenceUrl":""}' };
  });
  success(f.remediate(head));
  assert.match(readFileSync(f.output, "utf8"), /cursor=202\nready=true/);
  let submissions = f.state().submissions;
  assert.equal(submissions.length, 2);
  assert.match(submissions[0].prompt, /Earlier review: no concrete findings/);
  assert.match(submissions[1].prompt, /Current review: no concrete findings/);
  success(f.remediate(head));
  submissions = f.state().submissions;
  assert.equal(submissions.length, 2, "Existing native receipts must not be replayed");
  f.setState((state) => { state.cursorReports[firstAgent] = "A different report for the same run."; });
  const changed = f.remediate(head);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /differs from its original prompt/);
  assert.equal(f.state().submissions.length, 2);
});

test("an automation upgrade reconstructs the original prompt before resuming a source", (t) => {
  const f = fixture(t); success(f.reconcile());
  const head = f.ref(`npm-version/${f.first}`);
  const agent = "bc-77777777-7777-4777-8777-777777777777";
  f.setState((state) => {
    const cursor = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first);
    cursor.details_url = `https://cursor.com/agents/${agent}`;
    state.checks = [cursor, check("pi-durable", "Pi Durable Review", head, f.first),
      check("github-actions", "compatibility / compatibility", head, f.first)];
    state.cursorReports = { [agent]: "No concrete findings." };
  });
  const automation = join(f.root, "automation");
  const remote = join(f.root, "automation.git");
  mkdirSync(automation);
  cpSync(fileURLToPath(new URL("../scripts", import.meta.url)), join(automation, "scripts"), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../fleet.json", import.meta.url)), join(automation, "fleet.json"));
  git(automation, "init", "--quiet", "--initial-branch=main");
  git(automation, "config", "user.name", "Release test");
  git(automation, "config", "user.email", "release-test@example.invalid");
  git(automation, "add", "."); git(automation, "commit", "--quiet", "-m", "Original automation");
  const original = git(automation, "rev-parse", "HEAD");
  git(f.root, "clone", "--quiet", "--bare", automation, remote);
  git(automation, "remote", "add", "origin", remote);
  const executable = realpathSync(join(automation, "scripts/npm-remediation.mjs"));
  let result = f.remediate(head, executable);
  success(result);
  assert.equal(f.state().submissions?.length, 1, result.stdout);
  const promptFile = join(automation, "scripts/npm-remediation-prompt.mjs");
  writeFileSync(promptFile, readFileSync(promptFile, "utf8").replace("Work alone;", "Work deliberately alone;"));
  git(automation, "add", "."); git(automation, "commit", "--quiet", "-m", "Update automation");
  git(automation, "push", "--quiet", "origin", "main");
  result = f.remediate(head, executable);
  success(result);
  assert.equal(f.state().submissions.length, 1, "The admitted original operation must not be replayed");
  const shallow = join(f.root, "shallow-automation");
  git(f.root, "clone", "--quiet", "--depth=1", pathToFileURL(remote).href, shallow);
  assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
  assert.notEqual(spawnSync("git", ["cat-file", "-e", `${original}^{commit}`], { cwd: shallow }).status, 0);
  result = f.remediate(head, realpathSync(join(shallow, "scripts/npm-remediation.mjs")));
  success(result);
  assert.equal(f.state().submissions.length, 1, "A shallow upgrade must resume without replaying the operation");
});

test("an unposted Cursor finding cannot pass on an unverified or unanswered agent receipt", async (t) => {
  for (const [name, outcome, expected] of [
    ["unverified reply", { status: "done", text: JSON.stringify({ status: "addressed", reason: "Fixed", evidenceUrl: "https://github.com/example/missing" }) }, /No attributable PR reply/],
    ["unanswered", { status: "unanswered", reason: "aborted" }, /will not be replayed/],
  ]) await t.test(name, (t) => {
    const f = fixture(t); success(f.reconcile());
    const head = f.ref(`npm-version/${f.first}`);
    const agent = "bc-33333333-3333-4333-8333-333333333333";
    f.setState((s) => {
      const cursor = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first);
      cursor.details_url = `https://cursor.com/agents/${agent}`;
      s.checks = [cursor, check("pi-durable", "Pi Durable Review", head, f.first),
        check("github-actions", "compatibility / compatibility", head, f.first)];
      s.cursorReports = { [agent]: "[P2] A concrete finding in the review report, not posted to the PR." };
      s.durableOutcome = outcome;
    });
    let result = f.remediate(head);
    assert.notEqual(result.status, 0); assert.match(result.stderr, expected);
    assert.match(f.state().submissions[0].prompt, /A concrete finding in the review report/);
    result = f.remediate(head);
    assert.notEqual(result.status, 0); assert.equal(f.state().submissions.length, 1);
    assert.doesNotMatch(readFileSync(f.output, "utf8"), /ready=true/);
  });
});

test("a malformed remediation disposition gets one correction request for its source in the same chat, then stops visibly", async (t) => {
  // fitchmultz/pi-zai-mcp#55 stalled on a final line that escaped "]" in packages[\"\"\], which JSON.parse rejects.
  const malformed = { status: "done",
    text: 'Verified the version metadata.\n\n{"status":"no_findings","reason":"Versions align in packages[\\"\\"\\]","evidenceUrl":""}' };
  const agent = "bc-55555555-5555-4555-8555-555555555555";
  const setup = (t, correction) => {
    const f = fixture(t); success(f.reconcile());
    const head = f.ref(`npm-version/${f.first}`);
    f.setState((s) => {
      const cursor = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first);
      cursor.details_url = `https://cursor.com/agents/${agent}`;
      s.checks = [cursor, check("pi-durable", "Pi Durable Review", head, f.first),
        check("github-actions", "compatibility / compatibility", head, f.first)];
      s.cursorReports = { [agent]: "No concrete findings." };
      s.durableOutcomes = [malformed, correction];
    });
    return { f, head };
  };
  const requested = (f) => {
    const [original, correction] = f.state().submissions;
    assert.equal(correction.chat, original.chat);
    assert.notEqual(correction.operationId, original.operationId);
    // Every source of the PR shares the chat, and a later run can finish another source's request first
    // (fitchmultz/pi-workflows#39 review), so the request names its source and quotes the line it corrects.
    const key = JSON.stringify(`cursor:${agent}:run-${agent.slice(3)}`);
    assert.ok(original.prompt.includes(`"key":${key}`));
    assert.ok(correction.prompt.includes(`source with key ${key} (https://cursor.com/agents/${agent}) did not end with a valid`));
    assert.ok(correction.prompt.includes(`\n\n${malformed.text.split("\n").at(-1)}\n\n`));
  };
  await t.test("a corrected line completes the source", (t) => {
    const { f, head } = setup(t, { status: "done", text: '{"status":"no_findings","reason":"Versions align in packages[\\"\\"]","evidenceUrl":""}' });
    success(f.remediate(head));
    assert.match(readFileSync(f.output, "utf8"), /cursor=200\nready=true/);
    requested(f);
    success(f.remediate(head));
    assert.equal(f.state().submissions.length, 2, "Neither request may be repeated");
  });
  await t.test("a second malformed line fails without another request", (t) => {
    const { f, head } = setup(t, { status: "done", text: "The disposition is no_findings." });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.remediate(head);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /returned a valid JSON disposition for https:\/\/github\.com\/fitchmultz\/pi-copy-message\/pull\/1;/);
      assert.equal(f.state().submissions.length, 2);
    }
    requested(f);
    assert.doesNotMatch(readFileSync(f.output, "utf8"), /ready=true/);
  });
});

test("an incomplete Pi review uses native recovery only after uncertain comments are ruled out", async (t) => {
  for (const [name, posts, succeeds] of [
    ["settled", {}, true],
    ["uncertain comment", { finding: { status: "uncertain" } }, false],
  ]) await t.test(name, (t) => {
    const f = fixture(t); success(f.reconcile());
    const head = f.ref(`npm-version/${f.first}`);
    const delivery = "55555555-5555-4555-8555-555555555555";
    const agent = "bc-66666666-6666-4666-8666-666666666666";
    f.setState((s) => {
      const pi = check("pi-durable", "Pi Durable Review", head, f.first);
      pi.conclusion = "action_required"; pi.details_url = `https://durable.example.invalid/review#${delivery}`;
      const cursor = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first);
      cursor.details_url = `https://cursor.com/agents/${agent}`;
      s.checks = [pi, cursor, check("github-actions", "compatibility / compatibility", head, f.first)];
      s.cursorReports = { [agent]: "No concrete findings." };
      s.piRuns = { [delivery]: { status: "incomplete", taskState: { status: "terminal" }, pair: { base: f.first, head }, posts } };
    });
    const result = f.remediate(head);
    if (succeeds) {
      success(result);
      assert.equal(f.state().recoveries.length, 1);
      assert.match(readFileSync(f.output, "utf8"), /ready=true/);
    } else {
      assert.notEqual(result.status, 0); assert.match(result.stderr, /uncertain comment/);
      assert.equal(f.state().recoveries, undefined);
    }
  });
});

test("version automation stays held when a package's required release gates are not wired", () => {
  for (const name of ["pi-subagents", "pi-agent-browser-native", "pi-oracle", "pi-cursor-sdk", "pi-zai-mcp", "pi-codex-goal", "pi-posthorse", "pi-mcp-adapter"]) {
    const result = spawnSync(process.execPath, [script, "reconcile", "--source", ".", "--app-slug", "pi-durable"], {
      encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: `fitchmultz/${name}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, name === "pi-cursor-sdk" ? /exact-diff pre-commit and pre-push review/ : /package-specific release qualification/);
  }
});

test("a qualified caller versions and remediates its package, but cannot bypass exact-diff version review", (t) => {
  const f = fixture(t, { repo: "fitchmultz/pi-agent-browser-native", packageName: "pi-agent-browser-native" });
  const held = f.reconcile();
  assert.notEqual(held.status, 0);
  assert.match(held.stderr, /package-specific release qualification/);
  success(f.reconcile(undefined, ["--package-qualified"]));
  const head = f.ref(`npm-version/${f.first}`);
  assert.equal(f.state().open.length, 1);
  const agent = "bc-88888888-8888-4888-8888-888888888888";
  f.setState((state) => {
    const cursor = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first);
    cursor.details_url = `https://cursor.com/agents/${agent}`;
    state.checks = [cursor, check("pi-durable", "Pi Durable Review", head, f.first),
      ...["quality", "Native lifecycle Linux", "Official Pi / Node 24", "Fork Pi / Node 24", "macOS package smoke"]
        .map((name) => check("github-actions", name, head, f.first))];
    state.cursorReports = { [agent]: "No concrete findings." };
  });
  success(f.remediate(head, remediation, ["--package-qualified"]));
  assert.match(readFileSync(f.output, "utf8"), /ready=true/);
  assert.equal(f.state().submissions.length, 1);
  assert.deepEqual(f.state().modelSelections.map(({ chat, ...selection }) => selection), [{
    provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: "high",
    connectionId: "deployment:zai", expectedVersion: "fixture-configuration-version",
  }]);
  success(f.remediate(head, remediation, ["--package-qualified"]));
  assert.equal(f.state().modelSelections.length, 1);
  assert.equal(f.state().submissions.length, 1);
  const env = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" };
  const exactDiff = spawnSync(process.execPath, [script, "reconcile", "--package-qualified"], {
    encoding: "utf8", env: { ...env, GITHUB_REPOSITORY: "fitchmultz/pi-cursor-sdk" },
  });
  assert.notEqual(exactDiff.status, 0);
  assert.match(exactDiff.stderr, /exact-diff pre-commit and pre-push review/);
});

test("Cursor version automation reviews the actual staged tree and outgoing commits before publishing each branch head", (t) => {
  const f = fixture(t, { repo: "fitchmultz/pi-cursor-sdk", packageName: "pi-cursor-sdk", versionReview: true });
  const args = ["--package-qualified", "--version-reviewed"];
  const reviews = () => readFileSync(join(f.root, "review.log"), "utf8").trim().split("\n").map(JSON.parse);
  success(f.reconcile(undefined, args));
  const branch = `npm-version/${f.first}`;
  const firstHead = f.ref(branch);
  let records = reviews();
  assert.deepEqual(records.map(({ phase }) => phase), ["pre-commit", "pre-push"]);
  assert.equal(records[0].head, f.first);
  assert.match(records[0].staged, /CHANGELOG\.md/);
  assert.match(records[0].staged, /package-lock\.json/);
  assert.equal(records[0].remote, "");
  assert.equal(records[1].head, firstHead);
  assert.equal(records[1].base, f.first);
  assert.equal(records[1].staged, "");
  assert.equal(records[1].remote, "");
  for (const record of records) {
    assert.deepEqual(record.leaked, []);
    assert.equal(record.zai, "zai-fixture");
    assert.equal(realpathSync(record.automation), realpathSync(script));
  }

  const advanced = f.advance("New main change");
  success(f.reconcile(undefined, args));
  records = reviews();
  assert.deepEqual(records.map(({ phase }) => phase), ["pre-commit", "pre-push", "pre-commit", "pre-push"]);
  assert.equal(records[2].head, firstHead);
  assert.equal(records[2].remote, firstHead);
  assert.equal(records[3].base, firstHead);
  assert.equal(records[3].remote, firstHead);
  assert.equal(records[3].head, f.ref(branch));
  assert.notEqual(records[3].head, firstHead);
  rawChangelog(f, records[3].head);

  const updated = f.ref(branch);
  f.setState((state) => {
    state.checks = [check("pi-durable", "Pi Durable Review", updated, advanced, "failure")];
    state.threads = [{ isResolved: true, comments: { nodes: [{ author: { login: "pi-durable" },
      originalCommit: { oid: updated }, body: "<!-- pi-durable-review:findings -->" }] } }];
  });
  success(f.reconcile(undefined, args));
  records = reviews();
  assert.deepEqual(records.map(({ phase }) => phase),
    ["pre-commit", "pre-push", "pre-commit", "pre-push", "pre-commit", "pre-push"]);
  assert.equal(records[4].head, updated);
  assert.equal(records[4].staged, "");
  assert.equal(records[5].base, updated);
  assert.equal(records[5].remote, updated);
  assert.equal(records[5].head, f.ref(branch));
  assert.notEqual(records[5].head, updated);
  assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", `${updated}^{tree}`),
    git(f.root, "--git-dir", f.remote, "rev-parse", `${records[5].head}^{tree}`));
});

test("a failed Cursor version review stops before the corresponding commit or push", async (t) => {
  for (const phase of ["pre-commit", "pre-push"]) await t.test(phase, (t) => {
    const f = fixture(t, { repo: "fitchmultz/pi-cursor-sdk", packageName: "pi-cursor-sdk", versionReview: true });
    writeFileSync(join(f.root, `deny-${phase}`), "");
    const result = f.reconcile(undefined, ["--package-qualified", "--version-reviewed"]);
    assert.notEqual(result.status, 0);
    const remote = git(f.root, "--git-dir", f.remote, "for-each-ref", "--format=%(objectname)", "refs/heads/npm-version/");
    assert.equal(remote, "");
    const head = git(f.source, "rev-parse", "HEAD");
    if (phase === "pre-commit") assert.equal(head, f.first);
    else assert.notEqual(head, f.first);
    assert.equal(f.state().open.length, 0);
  });
});

test("qualified Cursor remediation preserves the mandatory review rule", (t) => {
  const f = fixture(t, { repo: "fitchmultz/pi-cursor-sdk", packageName: "pi-cursor-sdk", versionReview: true });
  success(f.reconcile(undefined, ["--package-qualified", "--version-reviewed"]));
  const head = f.ref(`npm-version/${f.first}`);
  const agent = "bc-88888888-8888-4888-8888-888888888888";
  f.setState((state) => {
    const cursor = check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first);
    cursor.details_url = `https://cursor.com/agents/${agent}`;
    state.checks = [cursor, check("pi-durable", "Pi Durable Review", head, f.first),
      check("github-actions", "compatibility / compatibility", head, f.first)];
    state.cursorReports = { [agent]: "No concrete findings." };
  });
  const held = f.remediate(head, remediation, ["--package-qualified"]);
  assert.notEqual(held.status, 0);
  assert.match(held.stderr, /not enabled for automatic version remediation/);
  f.setState((state) => { state.chatConfiguration = { provider: "openrouter" }; });
  success(f.remediate(head, remediation, ["--package-qualified", "--version-reviewed"]));
  assert.match(readFileSync(f.output, "utf8"), /ready=true/);
  const prompt = f.state().submissions[0].prompt;
  assert.match(prompt, /Before every commit and push, complete the independent exact-diff review/);
  assert.match(prompt, /If that review cannot be completed, do not commit or push; report blocked/);
  assert.match(prompt, /Do not use OpenRouter/);
  const [upload] = f.state().uploads ?? [];
  assert.ok(upload, "The remediator needs the direct Z.ai credential in its workspace");
  assert.equal(upload.bytes, Buffer.byteLength("zai-fixture"));
  assert.ok(prompt.includes(upload.path));
  assert.doesNotMatch(prompt, /zai-fixture/);
  success(f.remediate(head, remediation, ["--package-qualified", "--version-reviewed"]));
  assert.equal(f.state().uploads.length, 1, "An admitted upload must not be repeated");
  assert.equal(f.state().submissions.length, 1, "An admitted remediation must not be repeated");
});

test("changelog.d/*.md fragments assemble without CHANGELOG.md conflicts across opening, main updates, edits, and reverts", async (t) => {
  await t.test("consumes sorted fragments, keeps changelog.d/README.md, and merges sibling fragment PRs alongside reviewer edits", (t) => {
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
    writeFileSync(join(f.writer, "changelog.d", "20-second.md"), "* Second fragment note.\n");
    writeFileSync(join(f.writer, "changelog.d", "10-first.md"), "* First fragment note.\n");
    git(f.writer, "add", "."); git(f.writer, "commit", "--quiet", "-m", "Add initial fragments");
    git(f.writer, "push", "--quiet", "origin", "main");
    success(f.reconcile());

    const branch = `npm-version/${f.first}`;
    let head = f.ref(branch);
    const listedInitial = git(f.root, "--git-dir", f.remote, "ls-tree", "--name-only", "-r", head, "--", "changelog.d");
    assert.equal(listedInitial, "changelog.d/README.md", "Consumed fragments must be removed while keeping README.md");
    let notes = rawChangelog(f, head);
    assert.equal(/<!-- npm-release:unreleased:start -->\n([\s\S]*?)\n<!-- npm-release:unreleased:end -->/.exec(notes)?.[1],
      "- First fragment note.\n\n- Second fragment note.");

    git(f.writer, "fetch", "--quiet", "origin", branch);
    git(f.writer, "switch", "--quiet", "--detach", "FETCH_HEAD");
    writeFileSync(join(f.writer, "CHANGELOG.md"), readFileSync(join(f.writer, "CHANGELOG.md"), "utf8")
      .replace("- First fragment note.", "- First fragment note, refined in review."));
    git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Refine release note");
    git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);

    git(f.writer, "switch", "--quiet", "main");
    writeFileSync(join(f.writer, "change.txt"), "Sibling PRs landed");
    writeFileSync(join(f.writer, "changelog.d", "05-leading.md"), "* Leading sibling fragment.\n");
    writeFileSync(join(f.writer, "changelog.d", "15-middle.md"), "* Middle sibling fragment.\n");
    writeFileSync(join(f.writer, "changelog.d", "30-trailing.md"), "* Trailing sibling fragment.\n");
    git(f.writer, "add", "."); git(f.writer, "commit", "--quiet", "-m", "Merge sibling fragment PRs");
    git(f.writer, "push", "--quiet", "origin", "main");

    success(f.reconcile());
    head = f.ref(branch);
    assert.equal(git(f.root, "--git-dir", f.remote, "ls-tree", "--name-only", "-r", head, "--", "changelog.d"), "changelog.d/README.md");
    notes = rawChangelog(f, head);
    assert.equal(/<!-- npm-release:unreleased:start -->\n([\s\S]*?)\n<!-- npm-release:unreleased:end -->/.exec(notes)?.[1],
      "- Leading sibling fragment.\n\n- First fragment note, refined in review.\n\n- Middle sibling fragment.\n\n- Second fragment note.\n\n- Trailing sibling fragment.");
  });

  await t.test("reconciles main edits to an already-consumed fragment and rejects conflicting reviewer edits", (t) => {
    const f = fixture(t, { unreleased: false });
    mkdirSync(join(f.writer, "changelog.d"), { recursive: true });
    writeFileSync(join(f.writer, "changelog.d", "fix.md"), "- Original fragment text.\n");
    git(f.writer, "add", "."); git(f.writer, "commit", "--quiet", "-m", "Add fragment");
    git(f.writer, "push", "--quiet", "origin", "main");
    success(f.reconcile());
    const branch = `npm-version/${f.first}`;

    writeFileSync(join(f.writer, "changelog.d", "fix.md"), "- Revised on main.\n");
    git(f.writer, "add", "."); git(f.writer, "commit", "--quiet", "-m", "Revise fragment on main");
    git(f.writer, "push", "--quiet", "origin", "main");
    success(f.reconcile());
    let head = f.ref(branch);
    assert.equal(git(f.root, "--git-dir", f.remote, "ls-tree", "--name-only", "-r", head, "--", "changelog.d"), "");
    assert.equal(/<!-- npm-release:unreleased:start -->\n([\s\S]*?)\n<!-- npm-release:unreleased:end -->/.exec(rawChangelog(f, head))?.[1],
      "- Revised on main.");

    git(f.writer, "fetch", "--quiet", "origin", branch);
    git(f.writer, "switch", "--quiet", "--detach", "FETCH_HEAD");
    writeFileSync(join(f.writer, "CHANGELOG.md"), readFileSync(join(f.writer, "CHANGELOG.md"), "utf8")
      .replace("- Revised on main.", "- Edited on version branch."));
    git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Reviewer edit");
    git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    const reviewed = f.ref(branch);

    git(f.writer, "switch", "--quiet", "main");
    writeFileSync(join(f.writer, "changelog.d", "fix.md"), "- Conflicting main edit.\n");
    git(f.writer, "add", "."); git(f.writer, "commit", "--quiet", "-m", "Conflicting main edit");
    git(f.writer, "push", "--quiet", "origin", "main");
    const conflict = f.reconcile();
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /Concurrent Unreleased edits need review/);
    assert.equal(f.ref(branch), reviewed);
  });

  await t.test("reverting a fragment-backed commit closes the version PR when nothing else changed", (t) => {
    const f = fixture(t, { unreleased: false });
    git(f.writer, "pull", "--quiet", "--ff-only", "origin", "main");
    mkdirSync(join(f.writer, "changelog.d"), { recursive: true });
    writeFileSync(join(f.writer, "changelog.d", "feature.md"), "- Added feature.\n");
    git(f.writer, "add", "."); git(f.writer, "commit", "--quiet", "--amend", "-m", "Initial source with fragment");
    const amended = git(f.writer, "rev-parse", "HEAD");
    git(f.writer, "push", "--quiet", "--force", "origin", "main");
    success(f.reconcile());
    assert.equal(f.state().open[0].branch, `npm-version/${amended}`);
    git(f.writer, "revert", "--no-edit", amended);
    git(f.writer, "push", "--quiet", "origin", "main");
    const closed = f.reconcile();
    success(closed);
    assert.match(closed.stdout, /Closed version PR #\d+; nothing changed since v4\.0\.0/);
    assert.equal(f.state().open.length, 0);
  });

  await t.test("nests level-2 fragment headings so the version section, release notes, and later updates stay intact", (t) => {
    const f = fixture(t, { unreleased: false });
    writeFileSync(join(f.writer, "change.txt"), "Real source change");
    mkdirSync(join(f.writer, "changelog.d"), { recursive: true });
    writeFileSync(join(f.writer, "changelog.d", "feature.md"), "## Added\n\n- A brand new command.\n");
    git(f.writer, "add", ".");
    git(f.writer, "commit", "--quiet", "-m", "Add feature fragment");
    git(f.writer, "push", "--quiet", "origin", "main");
    success(f.reconcile());
    const branch = `npm-version/${f.first}`;
    const head = f.ref(branch);
    const notes = rawChangelog(f, head);
    assert.equal(
      /<!-- npm-release:unreleased:start -->\n([\s\S]*?)\n<!-- npm-release:unreleased:end -->/.exec(notes)?.[1],
      "### Added\n\n- A brand new command.",
    );
    const heading = /^##[ \t]+\d+\.\d+\.\d+[^\n]*$/m.exec(notes);
    assert.ok(heading, "Version section heading is missing");
    const rest = notes.slice(heading.index + heading[0].length);
    const next = /^##[ \t]+/m.exec(rest);
    const section = rest.slice(0, next === null ? rest.length : next.index);
    assert.ok(section.includes("<!-- npm-release:unreleased:end -->"), "Note markers must stay inside the version section");
    assert.ok(section.includes("- A brand new command."), "Release notes must keep the fragment note");
    f.advance("A later main merge");
    success(f.reconcile());
  });
});
