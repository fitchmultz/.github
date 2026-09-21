import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Recognize only the vendor's optimized global Windows x64 shim (also used on ARM64).
 * Unknown/custom launchers and failed discovery retain the original cross-spawn route.
 * where searches child cwd, then PATH, applying PATHEXT; never scan past its first hit.
 */
export async function resolveAgentBrowserCommand(cwd: string, childEnv: NodeJS.ProcessEnv): Promise<string> {
	const fallback = "agent-browser";
	if (process.platform !== "win32") return fallback;
	try {
		const where = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "where.exe");
		const { stdout } = await execFileAsync(where, [fallback], {
			cwd, env: childEnv, encoding: "utf8", windowsHide: true, timeout: 2_000,
		});
		const selected = stdout.split(/\r?\n/, 1)[0];
		if (!selected || extname(selected).toLowerCase() !== ".cmd") return fallback;
		const shim = await readFile(selected, "utf8");
		const match = /^@ECHO off\r?\n"%~dp0(node_modules\\agent-browser\\bin\\agent-browser-win32-x64\.exe)" %\*\r?\n$/i.exec(shim);
		if (!match) return fallback;
		const native = join(dirname(selected), match[1]);
		return (await stat(native)).isFile() ? native : fallback;
	} catch {
		// Discovery must not replace the original missing-command/custom CLI errors.
		return fallback;
	}
}
