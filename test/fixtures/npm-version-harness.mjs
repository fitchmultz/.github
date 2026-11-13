import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/npm-version.mjs", import.meta.url));
const api = fileURLToPath(new URL("./npm-version-api.mjs", import.meta.url));
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

function fixture(t, { unreleased = true, repo = repository, packageName = "pi-copy-message", versionReview = false } = {}) {
  const root = mkdtempSync("/tmp/npm-version-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const writer = join(root, "writer");
  const statePath = join(root, "github.json");
  const log = join(root, "github.log");
  const output = join(root, "output");
  mkdirSync(source);
  const manifest = {
    name: packageName,
    version: "4.0.0",
    description: "Original description",
    license: "MIT",
    author: "Original author",
    contributors: ["Original contributor"],
    repository: { type: "git", url: `git+https://github.com/${repo}.git` },
  };
  write(join(source, "package.json"), manifest);
  write(join(source, "package-lock.json"), {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: manifest.name, version: manifest.version } },
  });
  writeFileSync(
    join(source, "CHANGELOG.md"),
    `# Changes\n\n${unreleased ? "## Unreleased\n\n### Changed\n\nA real pending change.\nA second pending change.\n\n" : ""}## 4.0.0\n\nPrevious release.\n`,
  );
  if (versionReview) {
    mkdirSync(join(source, "scripts"), { recursive: true });
    writeFileSync(
      join(source, "scripts", "release-review.mjs"),
      `
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const root = ${JSON.stringify(root)}, remote = ${JSON.stringify(remote)}, phase = process.argv[2];
const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const receipt = process.argv[process.argv.indexOf("--receipt") + 1];
const baseIndex = process.argv.indexOf("--base");
appendFileSync(join(root, "review.log"), JSON.stringify({
  phase,
  head: git("rev-parse", "HEAD"),
  staged: git("diff", "--cached", "--name-only"),
  base: baseIndex < 0 ? null : process.argv[baseIndex + 1],
  remoteMain: git("--git-dir", remote, "rev-parse", "refs/heads/main"),
  leaked: ["GH_TOKEN", "RELEASE_GH_TOKEN", "CURSOR_API_KEY", "PI_DURABLE_ACCESS_TOKEN"].filter((key) => process.env[key]),
  zai: process.env.ZAI_API_KEY,
  automation: process.env.PI_RELEASE_REVIEW_AUTOMATION_VERSIONER,
}) + "\\n");
if (existsSync(join(root, \`deny-\${phase}\`))) process.exit(7);
mkdirSync(dirname(receipt), { recursive: true });
writeFileSync(receipt, JSON.stringify({ status: "passed" }));
`,
    );
  }
  git(source, "init", "--quiet", "--initial-branch=main");
  git(source, "config", "user.name", "Release test");
  git(source, "config", "user.email", "release-test@example.invalid");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "Previously released source");
  git(source, "tag", "v4.0.0");
  mkdirSync(join(source, ".github", "workflows"), { recursive: true });
  writeFileSync(join(source, ".github", "workflows", "npm-version.yml"), "name: npm version\n");
  writeFileSync(join(source, "integration.txt"), "Release integration\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "Initial source");
  const first = git(source, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--bare", source, remote);
  git(source, "remote", "add", "origin", remote);
  git(root, "clone", "--quiet", remote, writer);
  git(writer, "config", "user.name", "Release test");
  git(writer, "config", "user.email", "release-test@example.invalid");
  writeFileSync(log, "");
  write(statePath, {
    botCommits: [],
    unverifiedCommits: [],
    releases: [{ tag_name: "v4.0.0", draft: false }],
    runs: [],
    registry: {
      name: manifest.name,
      maintainers: [{ name: "fitchmultz" }],
      "dist-tags": { latest: manifest.version },
      versions: { [manifest.version]: manifest },
    },
  });
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${api}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: repo,
    GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/npm-version.yml@refs/heads/main`,
    GH_TOKEN: "read-fixture",
    RELEASE_GH_TOKEN: "app-fixture",
    GITHUB_OUTPUT: output,
    FAKE_GITHUB_STATE: statePath,
    FAKE_GITHUB_REMOTE: remote,
    FAKE_GITHUB_LOG: log,
    FAKE_FAST_POLL: "1",
  };
  if (versionReview) {
    Object.assign(env, { RUNNER_TEMP: root, ZAI_API_KEY: "zai-fixture", PI_RELEASE_REVIEW_SKILL: join(root, "skill.md") });
  }
  const state = () => read(statePath);
  const setState = (edit) => {
    const value = state();
    edit(value);
    write(statePath, value);
  };
  const invoke = (args, event = "push", environment = {}) => {
    writeFileSync(output, "");
    return spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, GITHUB_EVENT_NAME: event, ...environment },
    });
  };
  const reconcile = (event, extra = []) => invoke(["reconcile", "--source", source, "--app-slug", "pi-durable", ...extra], event);
  const ref = (branch = "main") => git(root, "--git-dir", remote, "rev-parse", `refs/heads/${branch}`);
  const advance = (text, note) => {
    git(writer, "pull", "--quiet", "--ff-only", "origin", "main");
    writeFileSync(join(writer, "change.txt"), text);
    if (note) {
      const path = join(writer, "CHANGELOG.md");
      const current = readFileSync(path, "utf8");
      if (/^## Unreleased$/m.test(current)) {
        writeFileSync(path, current.replace("## Unreleased\n", `## Unreleased\n\n${note}\n`));
      } else {
        writeFileSync(path, current.replace("# Changes\n\n", `# Changes\n\n## Unreleased\n\n${note}\n\n`));
      }
    }
    git(writer, "add", ".");
    git(writer, "commit", "--quiet", "-m", text);
    git(writer, "push", "--quiet", "origin", "main");
    return git(writer, "rev-parse", "HEAD");
  };
  return { root, source, remote, writer, state, setState, invoke, reconcile, ref, advance, output, log, first };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
}

function recordFailedRelease(f, bump, version, source, event = "push") {
  git(f.writer, "fetch", "--quiet", "origin", "main");
  git(f.writer, "tag", "-a", `v${version}`, bump, "-m", "Original candidate");
  git(f.writer, "push", "--quiet", "origin", `v${version}`);
  f.setState((s) => {
    s.runs.unshift({ id: 99 + s.runs.length, head_sha: bump, head_branch: "main", event, status: "completed", conclusion: "failure" });
    s.artifacts ??= [];
    s.artifacts.push({ name: `npm-candidate-${bump}`, expired: false });
    s.releases.push({
      id: 27 + s.releases.length,
      tag_name: `v${version}`,
      draft: true,
      body: `<!-- pi-npm-release: ${bump} sha512-original -->\n${marker(source)}`,
      assets: [{ id: 28 + s.releases.length, name: "original.tgz", digest: "sha256:original" }],
    });
  });
}

function completeRelease(f, bump, version, source, integrity = `sha512-${version}`) {
  git(f.writer, "fetch", "--quiet", "origin", "main");
  git(f.writer, "tag", "-f", `v${version}`, bump);
  git(f.writer, "push", "--quiet", "-f", "origin", `v${version}`);
  f.setState((s) => {
    s.registry.versions[version] = { ...s.registry.versions["4.0.0"], version, dist: { integrity } };
    s.registry["dist-tags"].latest = version;
    s.releases = [
      ...s.releases.filter((release) => release.tag_name !== `v${version}`),
      { tag_name: `v${version}`, draft: false, body: `<!-- pi-npm-release: ${bump} ${integrity} -->\n${marker(source)}` },
    ];
  });
}

function failedRelease(f, args = [], event = "push") {
  success(f.reconcile(undefined, args));
  const bump = f.ref("main");
  recordFailedRelease(f, bump, "4.0.1", f.first, event);
  return bump;
}

export { fixture, git, read, write, success, failedRelease, recordFailedRelease, completeRelease };
