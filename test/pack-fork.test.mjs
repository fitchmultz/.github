import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("pack-fork resolves the fork workspace from the source argument regardless of cwd", () => {
	const fixture = mkdtempSync(join(tmpdir(), "pack-fork-fixture-"));
	const source = join(fixture, "source");
	const output = join(fixture, "output");
	try {
		mkdirSync(join(source, "scripts"), { recursive: true });
		mkdirSync(join(source, "packages", "demo-pkg"), { recursive: true });
		mkdirSync(join(source, "packages", "ai", "src", "providers", "data"), { recursive: true });
		writeFileSync(join(source, "package.json"), JSON.stringify({ name: "fixture-fork", private: true }));
		writeFileSync(join(source, "package-lock.json"), "{}");
		writeFileSync(join(source, "packages", "ai", "src", "providers", "data", ".manifest.json"), "{}");
		writeFileSync(join(source, "packages", "demo-pkg", "package.json"), JSON.stringify({ name: "demo-pkg", version: "1.2.3" }));
		// Mirror the real fork helper contract: the workspace root is resolved from
		// process.cwd(), and the argument pack-fork passes is ignored.
		writeFileSync(join(source, "scripts", "package-workspaces.mjs"),
			'import { existsSync, readdirSync } from "node:fs";\n' +
			'import { join } from "node:path";\n' +
			'export function findPackageDirectories(root = "packages") {\n' +
			'	const directories = [];\n' +
			'	function visit(directory) {\n' +
			'		if (existsSync(join(directory, "package.json"))) directories.push(directory);\n' +
			'		for (const entry of readdirSync(directory, { withFileTypes: true })) {\n' +
			'			if (!entry.isDirectory() || entry.name === "node_modules") continue;\n' +
			'			visit(join(directory, entry.name));\n' +
			'		}\n' +
			'	}\n' +
			'	visit(root);\n' +
			'	return directories;\n' +
			'}\n');
		writeFileSync(join(source, "scripts", "release-packages.mjs"),
			'import { readFileSync } from "node:fs";\n' +
			'import { join } from "node:path";\n' +
			'import { findPackageDirectories } from "./package-workspaces.mjs";\n' +
			'export function getPublicWorkspacePackages() {\n' +
			'	return findPackageDirectories()\n' +
			'		.map((directory) => ({ directory, ...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) }))\n' +
			'		.filter((pkg) => pkg.private !== true)\n' +
			'		.map(({ directory, name, version }) => ({ directory, name, version }));\n' +
			'}\n');
		writeFileSync(join(source, "scripts", "coding-agent-consumer.mjs"),
			'import { writeFileSync } from "node:fs";\n' +
			'import { join } from "node:path";\n' +
			'export function packReleasePackages(packages, output) {\n' +
			'	const tarballs = new Map();\n' +
			'	for (const pkg of packages) {\n' +
			'		const file = `${pkg.name}-${pkg.version}.tgz`;\n' +
			'		writeFileSync(join(output, file), "tarball");\n' +
			'		tarballs.set(pkg.name, join(output, file));\n' +
			'	}\n' +
			'	return tarballs;\n' +
			'}\n');
		const git = (...args) => spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
		assert.equal(git("init", "-q").status, 0);
		assert.equal(git("config", "user.email", "fixture@example.com").status, 0);
		assert.equal(git("config", "user.name", "Fixture").status, 0);
		assert.equal(git("add", ".").status, 0);
		assert.equal(git("commit", "-qm", "fixture").status, 0);
		const ref = git("rev-parse", "HEAD").stdout.trim();

		// Invoke from an unrelated cwd, exactly like external callers that are not
		// already inside the fork checkout.
		const foreign = mkdtempSync(join(tmpdir(), "pack-fork-foreign-"));
		try {
			const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pack-fork.mjs");
			const result = spawnSync(process.execPath, [script, source, output, ref],
				{ cwd: foreign, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			const receipt = JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"));
			assert.equal(receipt.ref, ref);
			assert.deepEqual(receipt.packages.map((pkg) => pkg.name), ["demo-pkg"]);
			assert.equal(receipt.packages[0].sha256.length, 64);
		} finally {
			rmSync(foreign, { recursive: true, force: true });
		}
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
