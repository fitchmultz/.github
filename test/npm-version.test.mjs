import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/npm-version.mjs", import.meta.url));
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

function fixture(t, { unreleased = true } = {}) {
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
  const manifest = { name: "pi-copy-message", version: "4.0.0", description: "Original description",
    license: "MIT", author: "Original author", contributors: ["Original contributor"],
    repository: { type: "git", url: `git+https://github.com/${repository}.git` } };
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
    GITHUB_REPOSITORY: repository, GH_TOKEN: "read-fixture", RELEASE_GH_TOKEN: "app-fixture", GITHUB_OUTPUT: output,
    FAKE_GITHUB_STATE: statePath, FAKE_GITHUB_REMOTE: remote, FAKE_GITHUB_LOG: log, FAKE_FAST_POLL: "1" };
  const state = () => read(statePath);
  const setState = (edit) => { const value = state(); edit(value); write(statePath, value); };
  const invoke = (args, event = "push") => {
    writeFileSync(output, "");
    return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env: { ...env, GITHUB_EVENT_NAME: event } });
  };
  const reconcile = (event) => invoke(["reconcile", "--source", source, "--app-slug", "pi-durable"], event);
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
  return { root, source, remote, writer, state, setState, invoke, reconcile, ref, advance, output, log, first };
}

function success(result) { assert.equal(result.status, 0, result.stderr); }
function check(app, name, head, base, conclusion = "success") {
  return { app: { slug: app }, name, head_sha: head, status: "completed", conclusion,
    output: { title: conclusion === "failure" ? "Review completed — 1 finding reported" : "Review completed — no new findings",
      summary: `**Reviewed pair:** base \`${base}\` → head \`${head}\`` } };
}

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
  assert.notEqual(result.status, 0); assert.match(result.stderr, /unresolved review threads/); assert.equal(f.ref(branch), original);
  f.setState((s) => { s.threads[0].isResolved = true; s.comments = [{ body: "<!-- pi-durable-review:standalone -->", html_url: "https://github.com/example/finding" }]; });
  result = f.reconcile();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /standalone.*https:\/\/github\.com\/example\/finding/); assert.equal(f.ref(branch), original);
  f.setState((s) => {
    s.comments = [];
    s.checks.push(check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", original, f.first),
      check("github-actions", "compatibility / compatibility", original, f.first));
  });
  const wait = () => f.invoke(["wait", "--pull", "1", "--head", original]);
  success(wait());
  assert.match(readFileSync(f.output, "utf8"), /refresh=true/);
  f.setState((s) => { s.checks.at(-1).conclusion = "failure"; });
  result = wait();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /compatibility \/ compatibility did not pass/);
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
  const merge = () => f.invoke(["merge", "--source", f.source, "--pull", "1", "--head", head]);
  let result = merge();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /checks are not complete/);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /^merge /m);
  f.setState((s) => { s.checks.push(check("github-actions", "compatibility / compatibility", head, f.first)); });
  f.advance("Main advanced during review");
  result = merge();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /did not review the current base and head/);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /^merge /m);
});

test("a successful Cursor review still waits for its inline finding to be resolved", (t) => {
  const f = fixture(t); success(f.reconcile());
  const head = f.ref(`npm-version/${f.first}`);
  f.setState((s) => {
    s.checks = [check("pi-durable", "Pi Durable Review", head, f.first),
      check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, f.first),
      check("github-actions", "compatibility / compatibility", head, f.first)];
    s.threads = [{ isResolved: false, comments: { nodes: [{ author: { login: "cursor" }, originalCommit: { oid: head }, body: "A finding" }] } }];
    s.resolveOnFirstLookup = true;
  });
  const result = f.invoke(["wait", "--pull", "1", "--head", head]);
  success(result);
  assert.match(result.stdout, /Waiting for review findings/);
  assert.match(readFileSync(f.output, "utf8"), /ready=true/);
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
