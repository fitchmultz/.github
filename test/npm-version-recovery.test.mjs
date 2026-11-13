import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { completeRelease, failedRelease, fixture, git, recordFailedRelease, success } from "./fixtures/npm-version-harness.mjs";

const marker = (sha) => `<!-- pi-npm-source: ${sha} -->`;

for (const [event, correctiveNote] of [["push", "- Correct the unpublished release finding."], ["schedule", null]]) {
  test(`an explicit failed unpublished release replacement commits directly on fixed main while preserving prior records (${event})`, (t) => {
    const f = fixture(t, { repo: "fitchmultz/pi-cursor-sdk", packageName: "pi-cursor-sdk", versionReview: true });
    const args = ["--package-qualified", "--version-reviewed"];
    const bump = failedRelease(f, args, event);
    const old = structuredClone(f.state());
    const oldTag = git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.1");
    const oldChangelog = git(f.root, "--git-dir", f.remote, "show", `${bump}:CHANGELOG.md`);
    const oldSection = oldChangelog.slice(oldChangelog.indexOf("## 4.0.1"), oldChangelog.indexOf("## 4.0.0"));
    const fixed = f.advance("Remove the helper reported by post-merge review", correctiveNote);

    success(f.reconcile("push", args));
    assert.equal(f.ref("main"), fixed, "Ordinary main events must still wait for the failed version");

    f.setState((s) => { s.registry.versions["4.0.3"] = { ...s.registry.versions["4.0.0"], version: "4.0.3" }; });
    git(f.writer, "tag", "v4.0.5", fixed);
    git(f.writer, "push", "--quiet", "origin", "v4.0.5");
    const recovery = ["--supersede-version", "4.0.1", "--supersede-source", bump];
    const logOffset = readFileSync(f.log, "utf8").length;
    const superseded = f.reconcile("workflow_dispatch", [...args, ...recovery]);
    success(superseded);
    assert.doesNotMatch(superseded.stdout, /published package/, "An operator's supersession commits its replacement without a package comparison");

    const firstReplacement = f.ref("main");
    assert.notEqual(firstReplacement, fixed);
    assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${firstReplacement}:package.json`)).version, "4.0.6");
    assert.equal(git(f.root, "--git-dir", f.remote, "merge-base", fixed, firstReplacement), fixed);
    const firstMessage = git(f.root, "--git-dir", f.remote, "show", "-s", "--format=%B", firstReplacement);
    assert.match(firstMessage, new RegExp(marker(fixed)));
    assert.match(firstMessage, new RegExp(`<!-- pi-npm-supersedes: 4\\.0\\.1 ${bump} -->`));
    assert.match(readFileSync(f.output, "utf8"), new RegExp(`commit=${firstReplacement}\\nversion=4\\.0\\.6\\nsource=${fixed}`));

    const blob = spawnSync("git", ["--git-dir", f.remote, "show", `${firstReplacement}:CHANGELOG.md`], { encoding: "utf8" });
    success(blob);
    const notes = blob.stdout;
    assert.ok(notes.endsWith("\n"), "Recovery changelog must retain its final LF");
    const oldStart = notes.indexOf("## 4.0.1");
    const replacement = notes.slice(notes.indexOf("## 4.0.6"), oldStart);
    const pending = /<!-- npm-release:unreleased:start -->\n([\s\S]*?)<!-- npm-release:unreleased:end -->/.exec(replacement)?.[1].trim();
    assert.equal(pending, correctiveNote ?? "", "Only current Unreleased notes belong in the mutable pending block");
    const carried = "### Changed\n\nA real pending change.\nA second pending change.";
    assert.equal(replacement.split(carried).length, 2, "The replacement must carry the curated block exactly once");
    assert.ok(
      replacement.includes(`<!-- npm-release:unreleased:end -->\n\n<!-- npm-release:carried:start -->\n${carried}\n<!-- npm-release:carried:end -->\n\n- Supersedes unpublished 4.0.1`),
      "Curated notes must remain outside the pending block and before generated notes",
    );
    assert.ok(replacement.includes(bump));
    assert.equal(notes.slice(oldStart, notes.indexOf("## 4.0.0")), oldSection);

    const generated = readFileSync(f.log, "utf8").slice(logOffset);
    assert.deepEqual(generated.split("\n").filter((line) => line.startsWith("generate-notes ")), ["generate-notes previous=v4.0.0"]);
    assert.doesNotMatch(generated, /\/rerun|\/dispatches|DELETE/);
    assert.deepEqual(f.state().releases, old.releases);
    assert.deepEqual(f.state().runs, old.runs);
    assert.deepEqual(f.state().artifacts, old.artifacts);
    assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.1"), oldTag);

    recordFailedRelease(f, firstReplacement, "4.0.6", fixed, event);
    const failedRecords = structuredClone(f.state());
    const failedTag = git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.6");
    const previousSections = git(f.root, "--git-dir", f.remote, "show", `${firstReplacement}:CHANGELOG.md`).split("## 4.0.6")[1];
    const fixedAgain = f.advance("Fix the second failed release", "- Second corrective note.");

    success(f.reconcile("workflow_dispatch", [...args, "--supersede-version", "4.0.6", "--supersede-source", firstReplacement]));
    const secondReplacement = f.ref("main");
    const secondMessage = git(f.root, "--git-dir", f.remote, "show", "-s", "--format=%B", secondReplacement);
    assert.match(secondMessage, new RegExp(marker(fixedAgain)));
    assert.match(secondMessage, new RegExp(`<!-- pi-npm-supersedes: 4\\.0\\.6 ${firstReplacement} -->`));

    const secondText = git(f.root, "--git-dir", f.remote, "show", `${secondReplacement}:CHANGELOG.md`);
    const secondSection = secondText.slice(secondText.indexOf("## 4.0.7"), secondText.indexOf("## 4.0.6"));
    for (const literal of ["A real pending change.", "A second pending change.", correctiveNote, "- Second corrective note."].filter(Boolean)) {
      assert.equal(secondSection.split(literal).length, 2, `Second replacement must contain ${literal} exactly once`);
    }
    const secondPending = /<!-- npm-release:unreleased:start -->\n([\s\S]*?)<!-- npm-release:unreleased:end -->/.exec(secondSection)?.[1].trim();
    assert.equal(secondPending, "- Second corrective note.");
    const secondCarried = /<!-- npm-release:carried:start -->\n([\s\S]*?)\n<!-- npm-release:carried:end -->/.exec(secondSection)?.[1];
    assert.equal(secondCarried, ["### Changed\n\nA real pending change.\nA second pending change.", correctiveNote].filter(Boolean).join("\n\n"));
    assert.equal(secondText.split("## 4.0.6")[1], previousSections, "Both older sections must remain unchanged");
    assert.equal(secondSection.split("What's Changed").length, 2, "Do not copy prior generated notes");

    const allReviews = readFileSync(join(f.root, "review.log"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(allReviews.map(({ phase }) => phase), ["pre-commit", "pre-push", "pre-commit", "pre-push", "pre-commit", "pre-push"]);
    assert.ok(allReviews.every(({ leaked }) => leaked.length === 0));
    assert.deepEqual(f.state().releases, failedRecords.releases);
    assert.deepEqual(f.state().runs, failedRecords.runs);
    assert.deepEqual(f.state().artifacts, failedRecords.artifacts);
    assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.6"), failedTag);
    assert.equal(git(f.root, "--git-dir", f.remote, "rev-parse", "refs/tags/v4.0.1"), oldTag);

    completeRelease(f, secondReplacement, "4.0.7", fixedAgain, "sha512-fixed");
    const afterRecovery = f.advance("Ordinary change after recovery");
    success(f.reconcile("push", args));
    const ordinaryBump = f.ref("main");
    assert.equal(JSON.parse(git(f.root, "--git-dir", f.remote, "show", `${ordinaryBump}:package.json`)).version, "4.0.8");
    assert.match(git(f.root, "--git-dir", f.remote, "show", "-s", "--format=%B", ordinaryBump), new RegExp(marker(afterRecovery)));
  });
}
