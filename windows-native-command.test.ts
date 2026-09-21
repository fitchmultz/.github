// Native-only prototype contracts: real where.exe, copied node.exe, and real subprocesses.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveAgentBrowserCommand } from "./windows-native-command.ts";

assert.equal(process.platform, "win32", "run on native Windows, not an emulated platform");
const cross = createRequire(process.env.PROBE_BROWSER_PACKAGE!)("cross-spawn");
const exec = promisify(execFile);
const where = join(process.env.SystemRoot ?? process.env.SYSTEMROOT!, "System32", "where.exe");
const template = '@ECHO off\r\n"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe" %*\r\n';
const vectors = [
	["open", "https://chromium-args.example.test/", "--args", "--no-startup-window,--disable-gpu\n--no-sandbox"],
	["", "one two", '"quoted"', "C:\\path with space\\", "雪", "one\r\ntwo", "%PATH%", "a&b", "a^b"],
];

async function fixture(run: (f: { root: string; cwd: string; stock: string; native: string; script: string; env: NodeJS.ProcessEnv }) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "native-command-"));
	const cwd = join(root, "child cwd");
	const stock = join(root, "stock prefix");
	const native = join(stock, "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe");
	await mkdir(cwd, { recursive: true });
	await mkdir(dirname(native), { recursive: true });
	await copyFile(process.execPath, native);
	await writeFile(join(stock, "agent-browser.cmd"), template);
	const script = join(root, "argv.cjs");
	await writeFile(script, "process.stdout.write(JSON.stringify({exe:process.execPath,args:process.argv.slice(2)}))");
	const env = { ...process.env, PATH: `${stock};${dirname(process.execPath)}` };
	delete env.Path;
	try { await run({ root, cwd, stock, native, script, env }); }
	finally { await rm(root, { recursive: true, force: true }); }
}

async function selected(cwd: string, env: NodeJS.ProcessEnv) {
	const { stdout } = await exec(where, ["agent-browser"], { cwd, env, encoding: "utf8" });
	return stdout.trimEnd().split(/\r?\n/);
}
async function observe(label: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	const { stdout } = await exec(command, args, { cwd, env, encoding: "utf8" });
	const received = JSON.parse(stdout);
	await appendFile(process.env.PROBE_OBSERVATIONS!, JSON.stringify({ label, command, args, received }) + "\n");
	return received;
}

test("stock template resolves selected native file and Node spawn preserves LF/CRLF/full vector", async () => {
	await fixture(async ({ cwd, stock, native, script, env }) => {
		assert.equal((await selected(cwd, env))[0], join(stock, "agent-browser.cmd"));
		assert.equal(await resolveAgentBrowserCommand(stock, { ...env, PATH: dirname(process.execPath) }), native);
		for (const shim of [template, template.replaceAll("\r\n", "\n"), template.toUpperCase()]) {
			await writeFile(join(stock, "agent-browser.cmd"), shim);
			const command = await resolveAgentBrowserCommand(cwd, env);
			assert.equal(command.toLowerCase(), native.toLowerCase());
			for (const args of vectors) assert.deepEqual((await observe("stock", command, [script, ...args], cwd, env)).args, args);
		}
	});
});

test("where first selection agrees with cross-spawn for native EXE and PATHEXT order", async () => {
	await fixture(async ({ cwd, stock, native, script, env }) => {
		const exe = join(stock, "agent-browser.exe");
		await copyFile(process.execPath, exe);
		// Use a subprocess with this environment so cross-spawn/which sees the same PATHEXT.
		const crossEntry = createRequire(process.env.PROBE_BROWSER_PACKAGE!).resolve("cross-spawn");
		for (const extensions of [".EXE;.CMD", ".CMD;.EXE"]) {
			const childEnv = { ...env, PATHEXT: extensions };
			const first = (await selected(cwd, childEnv))[0];
			const expected = extensions.startsWith(".EXE") ? exe : native;
			assert.equal(first, extensions.startsWith(".EXE") ? exe : join(stock, "agent-browser.cmd"));
			const code = `const r=require(${JSON.stringify(crossEntry)}).sync('agent-browser',${JSON.stringify([script, "safe control"])},{cwd:process.cwd(),env:process.env,encoding:'utf8'});if(r.error)throw r.error;process.stdout.write(r.stdout);process.exitCode=r.status;`;
			assert.equal((await observe("cross-PATHEXT", process.execPath, ["-e", code], cwd, childEnv)).exe, expected);
			const resolved = await resolveAgentBrowserCommand(cwd, childEnv);
			assert.equal(resolved, expected === exe ? "agent-browser" : native);
		}
	});
});

test("custom cmd and earlier cwd/PATH shadows retain original cross-spawn behavior", async () => {
	await fixture(async ({ root, cwd, stock, script, env }) => {
		const shadow = join(root, "custom prefix");
		await mkdir(shadow);
		for (const [label, directory, childEnv] of [
			["cwd", cwd, env],
			["PATH", shadow, { ...env, PATH: `${shadow};${env.PATH}` }],
			["selected-custom", stock, env],
		] as const) {
			await writeFile(join(directory, "agent-browser.cmd"), '@ECHO off\r\n@echo custom-shadow\r\n@exit /b 23\r\n');
			assert.equal((await selected(cwd, childEnv))[0], join(directory, "agent-browser.cmd"));
			const command = await resolveAgentBrowserCommand(cwd, childEnv);
			assert.equal(command, "agent-browser");
			const actual = cross.sync(command, [script], { cwd, env: childEnv, encoding: "utf8" });
			assert.equal(actual.status, 23, label);
			assert.equal(actual.stdout.trim(), "custom-shadow", label);
			await rm(join(directory, "agent-browser.cmd"));
		}
	});
});

test("relative PATH and Path casing use child cwd/env, not resolver process cwd/PATH", async () => {
	await fixture(async ({ cwd, stock, native, script, env }) => {
		const childEnv = { ...env, Path: `..\\stock prefix;${dirname(process.execPath)}` };
		delete childEnv.PATH;
		assert.notEqual(process.cwd(), cwd);
		assert.equal((await selected(cwd, childEnv))[0], join(stock, "agent-browser.cmd"));
		assert.equal(await resolveAgentBrowserCommand(cwd, childEnv), native);
		const actual = cross.sync("agent-browser", [script, "safe control"], { cwd, env: childEnv, encoding: "utf8" });
		assert.equal(actual.status, 0);
		assert.equal(JSON.parse(actual.stdout).exe, native);
	});
});

test("missing native, directory target and missing command keep fallback errors; never scan later stock", async () => {
	await fixture(async ({ root, cwd, stock, native, script, env }) => {
		const later = join(root, "later stock");
		const laterNative = join(later, "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe");
		await mkdir(dirname(laterNative), { recursive: true });
		await copyFile(process.execPath, laterNative);
		await writeFile(join(later, "agent-browser.cmd"), template);
		const childEnv = { ...env, PATH: `${stock};${later};${dirname(process.execPath)}` };
		await rm(native);
		for (const directory of [false, true]) {
			if (directory) await mkdir(native);
			assert.equal(await resolveAgentBrowserCommand(cwd, childEnv), "agent-browser");
			const actual = cross.sync("agent-browser", [script], { cwd, env: childEnv, encoding: "utf8" });
			assert.notEqual(actual.status, 0);
			assert.equal(actual.stdout, "");
		}
		const absentEnv = { ...env, PATH: cwd };
		assert.equal(await resolveAgentBrowserCommand(cwd, absentEnv), "agent-browser");
		const missing = cross.sync("agent-browser", [], { cwd, env: absentEnv, encoding: "utf8" });
		assert.equal(missing.error?.code, "ENOENT");
	});
});

test("extra batch commands and unrecognized layouts are not treated as stock", async () => {
	await fixture(async ({ cwd, stock, env }) => {
		for (const shim of [template + "@echo extra\r\n", template.replace("%*", '"%*"'), template.replace("node_modules\\agent-browser", "other-package"), template.replace("x64", "arm64")]) {
			await writeFile(join(stock, "agent-browser.cmd"), shim);
			assert.equal(await resolveAgentBrowserCommand(cwd, env), "agent-browser");
		}
	});
});
