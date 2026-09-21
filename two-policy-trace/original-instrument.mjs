// Diagnostic-only text additions. No command, environment, timeout, cache or return-value edits.
import assert from 'node:assert/strict';
export function instrument(files) {
  const output = { ...files };
  function replace(file, before, after) {
    assert.equal(output[file].split(before).length, 2, `unique instrumentation anchor: ${file}`);
    output[file] = output[file].replace(before, after);
  }
  const identity = 'extensions/agent-browser/lib/process-identity.ts';
  replace(identity, `\t\texecFile(command.file, command.args, { timeout: PROCESS_START_IDENTITY_TIMEOUT_MS }, (error, stdout) => {
\t\t\tresolve(error ? undefined : normalizeProcessStartIdentity(stdout));
\t\t});`, `\t\tconst started = new Date().toISOString(), start = performance.now();
\t\tconst environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PSModulePath', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'].map(key => [key, process.env[key] ?? null]));
\t\tlet firstStdoutMs: number | undefined, firstStderrMs: number | undefined;
\t\tconst trace = { hostPid: process.pid, selectedPid: command.args.at(-1)?.match(/Get-Process -Id (\\d+)/)?.[1], file: command.file, args: command.args, started, timeoutMs: PROCESS_START_IDENTITY_TIMEOUT_MS, environment };
\t\tconsole.error('IDENTITY_START ' + JSON.stringify(trace));
\t\tconst child = execFile(command.file, command.args, { timeout: PROCESS_START_IDENTITY_TIMEOUT_MS }, (error, stdout, stderr) => {
\t\t\tconsole.error('IDENTITY_CALLBACK ' + JSON.stringify({ ...trace, childPid: child.pid, ended: new Date().toISOString(), elapsedMs: performance.now() - start, firstStdoutMs: firstStdoutMs ?? null, firstStderrMs: firstStderrMs ?? null, error: error ? { code: error.code, signal: error.signal, killed: error.killed, message: error.message } : null, stdout, stderr }));
\t\t\tresolve(error ? undefined : normalizeProcessStartIdentity(stdout));
\t\t});
\t\tchild.stdout?.once('data', () => { firstStdoutMs = performance.now() - start; });
\t\tchild.stderr?.once('data', () => { firstStderrMs = performance.now() - start; });`);
  const lock = 'extensions/agent-browser/lib/managed-session-policy-lock.ts';
  replace(lock, 'const POLICY_LOCK_WAIT_MS = 1_000;', `function diagnosticLock(event: string, details: Record<string, unknown>) {
\tconsole.error('LOCK_TRACE ' + JSON.stringify({ event, hostPid: process.pid, at: new Date().toISOString(), ...details }));
}

const POLICY_LOCK_WAIT_MS = 1_000;`);
  replace(lock, '\t\t\tawait mkdir(path, { mode: 0o700 });', '\t\t\tawait mkdir(path, { mode: 0o700 });\n\t\t\tdiagnosticLock("directory-mkdir", { path });');
  replace(lock, '\t\t\tif ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;', '\t\t\tdiagnosticLock("directory-mkdir-error", { path, code: (error as NodeJS.ErrnoException).code, error: String(error) });\n\t\t\tif ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;');
  replace(lock, '\t\tconst entry = await lstat(path);', '\t\tconst entry = await lstat(path);\n\t\tdiagnosticLock("directory-lstat", { path, directory: entry.isDirectory(), symlink: entry.isSymbolicLink(), mode: entry.mode, uid: entry.uid });');
  replace(lock, '\tconst startIdentity = await readProcessStartIdentity(process.pid);\n\tif (!startIdentity) return undefined;', '\tdiagnosticLock("identity-request", { directory, basePath, token });\n\tconst startIdentity = await readProcessStartIdentity(process.pid);\n\tdiagnosticLock("identity-result", { directory, basePath, token, startIdentity: startIdentity ?? null });\n\tif (!startIdentity) return undefined;');
  replace(lock, '\t\tclaimPublished = true;', '\t\tclaimPublished = true;\n\t\tdiagnosticLock("claim-published", { candidatePath, claimPath, token });');
  replace(lock, '\t\t\t\tlockAcquired = true;', '\t\t\t\tlockAcquired = true;\n\t\t\t\tdiagnosticLock("acquired", { claimPath, token });');
  replace(lock, '\t\tawait rm(candidatePath, { force: true, recursive: true }).catch(() => undefined);', '\t\tdiagnosticLock("acquisition-finally", { candidatePath, claimPath, token, claimPublished, lockAcquired });\n\t\tawait rm(candidatePath, { force: true, recursive: true }).catch(() => undefined);');
  return output;
}
