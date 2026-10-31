import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/npm-version.mjs", import.meta.url));
const remediation = fileURLToPath(new URL("../scripts/npm-remediation.mjs", import.meta.url));
const api = fileURLToPath(new URL("./fixtures/npm-version-api.mjs", import.meta.url));
const gh = fileURLToPath(new URL("./fixtures/npm-version-gh.mjs", import.meta.url));
const repository = "fitchmultz/pi-copy-message";
const marker = (sha) => `<!-- pi-npm-source: ${sha} -->`;

function command(executable, args, cwd, options = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
const git = (cwd, ...args) => command("git", args, cwd);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function fixture(t, { unreleased = true, repo = repository, packageName = "pi-copy-message" } = {}) {
  const root = mkdtempSync("/tmp/npm-version-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const writer = join(root, "writer");
  const bin = join(root, "bin");
  const statePath = join(root, "github.json");
  const log = join(root, "github.log");
  const output = join(root, "output");
  mkdirSync(source); mkdirSync(bin);
  const manifest = { name: packageName, version: "4.0.0", description: "Original description",
    license: "MIT", author: "Original author", contributors: ["Original contributor"],
    repository: { type: "git", url: `git+https://github.com/${repo}.git` } };
  write(join(source, "package.json"), manifest);
  write(join(source, "package-lock.json"), { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: { "": { name: manifest.name, version: manifest.version } } });
  writeFileSync(join(source, "CHANGELOG.md"), `# Changes\n\n${unreleased ? "## Unreleased\n\n### Changed\n\nA real pending change.\nA second pending change.\n\n" : ""}## 4.0.0\n\nPrevious release.\n`);
  git(source, "init", "--quiet", "--initial-branch=main");
  git(source, "config", "user.name", "Release test");
  git(source, "config", "user.email", "release-test@example.invalid");
  git(source, "add", "."); git(source, "commit", "--quiet", "-m", "Previously released source");
  git(source, "tag", "v4.0.0");
  mkdirSync(join(source, ".github", "workflows"), { recursive: true });
  writeFileSync(join(source, ".github", "workflows", "npm-version.yml"), "name: npm version\n");
  writeFileSync(join(source, "integration.txt"), "Release integration\n");
  git(source, "add", "."); git(source, "commit", "--quiet", "-m", "Initial source");
  const first = git(source, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--bare", source, remote);
  git(source, "remote", "add", "origin", remote);
  git(root, "clone", "--quiet", remote, writer);
  git(writer, "config", "user.name", "Release test");
  git(writer, "config", "user.email", "release-test@example.invalid");
  copyFileSync(gh, join(bin, "gh")); chmodSync(join(bin, "gh"), 0o755);
  write(statePath, { nextPull: 1, open: [], merged: [], checks: [], threads: [], comments: [], releases: [{ tag_name: "v4.0.0", draft: false }], runs: [],
    registry: { name: manifest.name, maintainers: [{ name: "fitchmultz" }], "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: manifest } } });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${api}`,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repo, GH_TOKEN: "read-fixture", RELEASE_GH_TOKEN: "app-fixture", GITHUB_OUTPUT: output,
    PI_DURABLE_ORIGIN: "https://durable.example.invalid", PI_DURABLE_ACCESS_TOKEN: "durable-fixture", CURSOR_API_KEY: "cursor-fixture",
    FAKE_GITHUB_STATE: statePath, FAKE_GITHUB_REMOTE: remote, FAKE_GITHUB_LOG: log, FAKE_FAST_POLL: "1" };
  const state = () => read(statePath);
  const setState = (edit) => { const value = state(); edit(value); write(statePath, value); };
  const invoke = (args, event = "push") => {
    writeFileSync(output, "");
    return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env: { ...env, GITHUB_EVENT_NAME: event } });
  };
  const reconcile = (event, extra = []) => invoke(["reconcile", "--source", source, "--app-slug", "pi-durable", ...extra], event);
  const remediate = (head, executable = remediation, extra = []) => {
    writeFileSync(output, "");
    return spawnSync(process.execPath, [executable, "--source", source, "--pull", "1", "--head", head,
      "--release-source", first, "--app-slug", "pi-durable", ...extra], { cwd: root, encoding: "utf8", env });
  };
  const ref = (branch) => git(root, "--git-dir", remote, "rev-parse", `refs/heads/${branch}`);
  const advance = (text, note) => {
    writeFileSync(join(writer, "change.txt"), text);
    if (note) {
      const path = join(writer, "CHANGELOG.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("## Unreleased\n", `## Unreleased\n\n${note}\n`));
    }
    git(writer, "add", "."); git(writer, "commit", "--quiet", "-m", text); git(writer, "push", "--quiet", "origin", "main");
    return git(writer, "rev-parse", "HEAD");
  };
  return { root, source, remote, writer, state, setState, invoke, reconcile, remediate, ref, advance, output, log, first };
}

function success(result) { assert.equal(result.status, 0, result.stderr); }
function check(app, name, head, base, conclusion = "success") {
  return { id: app === "cursor" ? 200 : app === "pi-durable" ? 100 : 300, app: { slug: app }, name, head_sha: head, status: "completed", conclusion,
    output: { title: conclusion === "failure" ? "Review completed — 1 finding reported" : "Review completed — no new findings",
      summary: `**Reviewed pair:** base \`${base}\` → head \`${head}\`` } };
}

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

test("version PR follows advancing main and drains source commits only after the previous release completes", (t) => {
  const f = fixture(t);
  const second = f.advance("Another main merge");
  success(f.reconcile());
  const branch = `npm-version/${f.first}`;
  assert.equal(f.state().open[0].branch, branch);
  let head = f.ref(branch);
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", second, head), second);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package.json`)).version, "4.0.1");
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package-lock.json`)).packages[""].version, "4.0.1");
  assert.match(git(f.root, "--git-dir", f.remote, "show", `${head}:CHANGELOG.md`), /## 4\.0\.1[\s\S]*A real pending change\.[\s\S]*Meaningful change/);
  git(f.writer, "fetch", "--quiet", "origin", branch);
  git(f.writer, "switch", "--quiet", "--detach", "FETCH_HEAD");
  const changelog = join(f.writer, "CHANGELOG.md");
  writeFileSync(changelog, readFileSync(changelog, "utf8").replace("Meaningful change", "Meaningful change with a reviewed correction"));
  git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Address review");
  git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  git(f.writer, "switch", "--quiet", "main");
  success(f.reconcile());
  const third = f.advance("Third main merge", "- Newly merged changelog note.");
  success(f.reconcile());
  head = f.ref(branch);
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", third, head), third);
  const mergedNotes = git(f.root, "--git-dir", f.remote, "show", `${head}:CHANGELOG.md`);
  assert.match(mergedNotes, /## Unreleased\s+## 4\.0\.1[\s\S]*Newly merged changelog note\.[\s\S]*reviewed correction/);
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
  assert.equal(next.branch, `npm-version/${second}`);
  const nextHead = f.ref(next.branch);
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", later, nextHead), later);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${nextHead}:package.json`)).version, "4.0.2");
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
    writeFileSync(path, readFileSync(path, "utf8").replace(prior, () => correction).replace("Meaningful change", "Reviewed release note"));
    git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Address review");
    git(f.writer, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    git(f.writer, "switch", "--quiet", "main");
    writeFileSync(path, edit(readFileSync(path, "utf8")));
    git(f.writer, "add", "CHANGELOG.md"); git(f.writer, "commit", "--quiet", "-m", "Update unreleased notes");
    git(f.writer, "push", "--quiet", "origin", "main");
    success(f.reconcile());
    const notes = git(f.root, "--git-dir", f.remote, "show", `${f.ref(branch)}:CHANGELOG.md`);
    assert.match(notes, /## Unreleased\s+## 4\.0\.1/);
    const released = notes.slice(notes.indexOf("## 4.0.1"));
    assert.ok(released.includes(expected), "Incoming note must be preserved verbatim");
    assert.ok(released.includes(correction), "Reviewed note must be preserved verbatim");
    assert.match(released, /Reviewed release note/);
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
  for (const name of ["pi-subagents", "pi-agent-browser-native", "pi-oracle", "pi-cursor-sdk", "pi-zai-mcp", "pi-codex-goal", "pi-posthorse", "pi-mcp-adapter", "pi-workflows"]) {
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
  const env = { ...process.env, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" };
  const exactDiff = spawnSync(process.execPath, [script, "reconcile", "--package-qualified"], {
    encoding: "utf8", env: { ...env, GITHUB_REPOSITORY: "fitchmultz/pi-cursor-sdk" },
  });
  assert.notEqual(exactDiff.status, 0);
  assert.match(exactDiff.stderr, /exact-diff pre-commit and pre-push review/);
});
