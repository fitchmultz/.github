import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, git, success, check, failedRelease, mergeVersion, recordFailedRelease } from "./fixtures/npm-version-harness.mjs";
const marker = (sha) => `<!-- pi-npm-source: ${sha} -->`;

for (const [event, correctiveNote] of [["push", "- Correct the unpublished release finding."], ["schedule", null]]) test(`an explicit failed unpublished release replacement follows fixed main through the normal version pipeline (${event})`, (t) => {
  // SDK 0.5.27 failed its post-merge review; the corrective main merge was not an admitted release source.
  const f = fixture(t, { repo: "fitchmultz/pi-cursor-sdk", packageName: "pi-cursor-sdk", versionReview: true });
  const args = ["--package-qualified", "--version-reviewed"];
  const bump = failedRelease(f, args, event);
  const old = f.state();
  const oldBranchHead = f.ref(`npm-version/${f.first}`);
  const oldTag = git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.1");
  const oldChangelog = git(f.root, "--git-dir", f.remote, "show", `${bump}:CHANGELOG.md`);
  const oldSection = oldChangelog.slice(oldChangelog.indexOf("## 4.0.1"), oldChangelog.indexOf("## 4.0.0"));
  const fixed = f.advance("Remove the helper reported by post-merge review", correctiveNote);
  success(f.reconcile("push", args));
  assert.equal(f.state().open.length, 0, "Ordinary main events must still wait for the failed version");
  // Reserve numbers independently in npm and tags. Recovery must use the same native nextVersion as normal releases.
  f.setState((s) => { s.registry.versions["4.0.3"] = { ...s.registry.versions["4.0.0"], version: "4.0.3" }; });
  git(f.writer, "tag", "v4.0.5", fixed); git(f.writer, "push", "--quiet", "origin", "v4.0.5");
  const recovery = ["--supersede-version", "4.0.1", "--supersede-source", bump];
  const logOffset = readFileSync(f.log, "utf8").length;
  success(f.reconcile("workflow_dispatch", [...args, ...recovery]));
  const pull = f.state().open[0];
  assert.equal(pull.branch, `npm-version/${fixed}`);
  assert.match(pull.body, new RegExp(`<!-- pi-npm-supersedes: 4\\.0\\.1 ${bump} -->`));
  let head = f.ref(pull.branch);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${head}:package.json`)).version, "4.0.6");
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", fixed, head), fixed);
  const assertNotes = (laterNote = null) => {
    const notes = git(f.root, "--git-dir", f.remote, "show", `${head}:CHANGELOG.md`);
    const oldStart = notes.indexOf("## 4.0.1");
    const replacement = notes.slice(notes.indexOf("## 4.0.6"), oldStart);
    const pending = /<!-- npm-release:unreleased:start -->\n([\s\S]*?)<!-- npm-release:unreleased:end -->/.exec(replacement)?.[1].trim();
    assert.equal(pending, (event === "push" ? [correctiveNote, laterNote] : [laterNote, correctiveNote]).filter(Boolean).join("\n\n"),
      "Only current Unreleased notes belong in the mutable pending block");
    const carried = "### Changed\n\nA real pending change.\nA second pending change.";
    assert.equal(replacement.split(carried).length, 2, "The replacement must carry the curated block exactly once");
    assert.ok(replacement.includes(`<!-- npm-release:unreleased:end -->\n\n<!-- npm-release:carried:start -->\n${carried}\n<!-- npm-release:carried:end -->\n\n- Supersedes unpublished 4.0.1`),
      "Curated notes must remain outside the pending block and before generated notes");
    assert.match(replacement, /Supersedes unpublished 4\.0\.1/);
    assert.ok(replacement.includes(bump));
    assert.equal(notes.slice(oldStart, notes.indexOf("## 4.0.0")), oldSection);
  };
  assertNotes();
  // Native source notes span the last published tag, not the failed automatic bump.
  const generated = readFileSync(f.log, "utf8").slice(logOffset);
  assert.deepEqual(generated.split("\n").filter((line) => line.startsWith("generate-notes ")), ["generate-notes previous=v4.0.0"]);
  assert.doesNotMatch(generated, /\/rerun|\/dispatches|DELETE|PATCH/);
  if (event === "push") {
    const path = join(f.writer, "CHANGELOG.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(correctiveNote, `${correctiveNote}\n\n- Newly merged changelog note.\n`));
  }
  const later = f.advance("Later fixed-main source", event === "push" ? null : "- Newly merged changelog note.");
  success(f.reconcile("check_run", args));
  head = f.ref(pull.branch);
  assert.equal(f.state().open.length, 1);
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", later, head), later);
  assertNotes("- Newly merged changelog note.");
  assert.match(readFileSync(f.output, "utf8"), new RegExp(`pull=${pull.number}\\nhead=${head}\\nsource=${fixed}`));
  const reviews = readFileSync(join(f.root, "review.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(reviews.map(({ phase }) => phase), ["pre-commit", "pre-push", "pre-commit", "pre-push", "pre-commit", "pre-push"]);
  assert.ok(reviews.every(({ leaked }) => leaked.length === 0));
  const merge = () => f.invoke(["merge", "--source", f.source, "--pull", String(pull.number), "--head", head, "--cursor", "200", ...args]);
  let result = merge();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /checks are not complete|Cursor review changed/);
  f.setState((s) => {
    s.checks = [check("pi-durable", "Pi Durable Review", head, later),
      check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", head, later),
      check("github-actions", "compatibility / compatibility", head, later)];
  });
  success(merge());
  assert.match(readFileSync(f.log, "utf8"), new RegExp(`merge [\\s\\S]*pi-npm-supersedes: 4\\.0\\.1 ${bump}`));
  assert.deepEqual(f.state().releases, old.releases);
  assert.deepEqual(f.state().runs, old.runs);
  assert.deepEqual(f.state().artifacts, old.artifacts);
  assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.1"), oldTag);
  assert.equal(f.ref(`npm-version/${f.first}`), oldBranchHead);
  // The gh boundary records admission; the shared fixture performs the actual local squash merge.
  const firstReplacement = mergeVersion(f, pull.branch, fixed, "4.0.6", { version: "4.0.1", source: bump });
  recordFailedRelease(f, firstReplacement, "4.0.6", fixed, event);
  const failedRecords = f.state();
  const failedTag = git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.6");
  const firstHead = f.ref(pull.branch);
  const previousSections = git(f.root, "--git-dir", f.remote, "show", `${firstReplacement}:CHANGELOG.md`).split("## 4.0.6")[1];
  const fixedAgain = f.advance("Fix the second failed release", "- Second corrective note.");
  success(f.reconcile("workflow_dispatch", [...args, "--supersede-version", "4.0.6", "--supersede-source", firstReplacement]));
  const secondPull = f.state().open[0];
  assert.equal(secondPull.branch, `npm-version/${fixedAgain}`);
  assert.match(secondPull.body, new RegExp(`<!-- pi-npm-supersedes: 4\\.0\\.6 ${firstReplacement} -->`));
  const assertSecondNotes = (laterNote = null) => {
    const text = git(f.root, "--git-dir", f.remote, "show", `${f.ref(secondPull.branch)}:CHANGELOG.md`);
    const section = text.slice(text.indexOf("## 4.0.7"), text.indexOf("## 4.0.6"));
    for (const literal of ["A real pending change.", "A second pending change.", "- Newly merged changelog note.", correctiveNote, "- Second corrective note.", laterNote].filter(Boolean)) {
      assert.equal(section.split(literal).length, 2, `Second replacement must contain ${literal} exactly once`);
    }
    const pending = /<!-- npm-release:unreleased:start -->\n([\s\S]*?)<!-- npm-release:unreleased:end -->/.exec(section)?.[1].trim();
    assert.equal(pending, [laterNote, "- Second corrective note."].filter(Boolean).join("\n\n"));
    const carried = /<!-- npm-release:carried:start -->\n([\s\S]*?)\n<!-- npm-release:carried:end -->/.exec(section)?.[1];
    const firstPending = event === "push" ? [correctiveNote, "- Newly merged changelog note."] : ["- Newly merged changelog note.", correctiveNote];
    assert.equal(carried, ["### Changed\n\nA real pending change.\nA second pending change.", ...firstPending].filter(Boolean).join("\n\n"));
    assert.equal(text.split("## 4.0.6")[1], previousSections, "Both older sections must remain unchanged");
    assert.equal(section.split("Meaningful change").length, 2, "Do not copy prior generated notes");
  };
  assertSecondNotes();
  const secondLater = f.advance("Later main after the second recovery", "- Another merged note.");
  success(f.reconcile("check_run", args));
  assertSecondNotes("- Another merged note.");
  const secondHead = f.ref(secondPull.branch);
  assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", secondLater, secondHead), secondLater);
  const secondMerge = () => f.invoke(["merge", "--source", f.source, "--pull", String(secondPull.number), "--head", secondHead, "--cursor", "200", ...args]);
  assert.notEqual(secondMerge().status, 0, "The second recovery also requires current-head reviews");
  f.setState((s) => { s.checks = [check("pi-durable", "Pi Durable Review", secondHead, secondLater),
    check("cursor", "Cursor Automation: PR Bug Review - Maintained Repos", secondHead, secondLater),
    check("github-actions", "compatibility / compatibility", secondHead, secondLater)]; });
  success(secondMerge());
  const allReviews = readFileSync(join(f.root, "review.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(allReviews.map(({ phase }) => phase), Array.from({ length: 5 }, () => ["pre-commit", "pre-push"]).flat());
  assert.ok(allReviews.every(({ leaked }) => leaked.length === 0));
  assert.deepEqual(f.state().releases, failedRecords.releases);
  assert.deepEqual(f.state().runs, failedRecords.runs);
  assert.deepEqual(f.state().artifacts, failedRecords.artifacts);
  assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.6"), failedTag);
  assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.1"), oldTag);
  assert.equal(f.ref(pull.branch), firstHead);
  assert.equal(f.ref(`npm-version/${f.first}`), oldBranchHead);
  const replacement = mergeVersion(f, secondPull.branch, fixedAgain, "4.0.7", { version: "4.0.6", source: firstReplacement });
  git(f.writer, "tag", "v4.0.7", replacement); git(f.writer, "push", "--quiet", "origin", "v4.0.7");
  f.setState((s) => {
    s.registry.versions["4.0.7"] = { ...s.registry.versions["4.0.0"], version: "4.0.7", dist: { integrity: "sha512-fixed" } };
    s.registry["dist-tags"].latest = "4.0.7";
    s.releases.push({ tag_name: "v4.0.7", draft: false,
      body: `<!-- pi-npm-release: ${replacement} sha512-fixed -->\n${marker(fixedAgain)}` });
  });
  const queued = f.advance("Next ordinary queued source");
  success(f.reconcile("push", args));
  assert.equal(f.state().open[0].branch, `npm-version/${queued}`);
  assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${f.ref(`npm-version/${queued}`)}:package.json`)).version, "4.0.8");
  assert.deepEqual(f.state().releases.slice(0, failedRecords.releases.length), failedRecords.releases);
});
