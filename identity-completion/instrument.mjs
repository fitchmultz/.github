import assert from 'node:assert/strict';
export function instrument(originals) {
  const file = 'extensions/agent-browser/lib/process-identity.ts';
  const original = originals[file];
  const before = `\t\texecFile(command.file, command.args, { timeout: PROCESS_START_IDENTITY_TIMEOUT_MS }, (error, stdout) => {
\t\t\tresolve(error ? undefined : normalizeProcessStartIdentity(stdout));
\t\t});`;
  assert.equal(original.split(before).length, 2);
  assert.equal(original.split('const PROCESS_START_IDENTITY_TIMEOUT_MS = 5_000;').length, 2);
  const after = `\t\tconst started = new Date().toISOString(), start = performance.now();
\t\tconst environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PSModulePath', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'].map(key => [key, process.env[key] ?? null]));
\t\tlet firstStdoutMs: number | undefined, firstStderrMs: number | undefined;
\t\tconst trace = { hostPid: process.pid, selectedPid: command.args.at(-1)?.match(/Get-Process -Id (\\d+)/)?.[1], file: command.file, args: command.args, started, timeoutMs: PROCESS_START_IDENTITY_TIMEOUT_MS, originalTimeoutMs: 5_000, environment };
\t\tconsole.error('IDENTITY_START ' + JSON.stringify(trace));
\t\tconst child = execFile(command.file, command.args, { timeout: PROCESS_START_IDENTITY_TIMEOUT_MS }, (error, stdout, stderr) => {
\t\t\tclearTimeout(originalDeadline);
\t\t\tconsole.error('IDENTITY_CALLBACK ' + JSON.stringify({ ...trace, childPid: child.pid, ended: new Date().toISOString(), elapsedMs: performance.now() - start, firstStdoutMs: firstStdoutMs ?? null, firstStderrMs: firstStderrMs ?? null, error: error ? { code: error.code, signal: error.signal, killed: error.killed, message: error.message } : null, stdout, stderr }));
\t\t\tresolve(error ? undefined : normalizeProcessStartIdentity(stdout));
\t\t});
\t\tconst originalDeadline = setTimeout(() => console.error('IDENTITY_ORIGINAL_DEADLINE ' + JSON.stringify({ ...trace, elapsedMs: performance.now() - start })), 5_000);
\t\tchild.stdout?.once('data', () => { firstStdoutMs = performance.now() - start; });
\t\tchild.stderr?.once('data', () => { firstStderrMs = performance.now() - start; });`;
  return { [file]: original.replace('const PROCESS_START_IDENTITY_TIMEOUT_MS = 5_000;', 'const PROCESS_START_IDENTITY_TIMEOUT_MS = 20_000; // Diagnostic only: observe natural completion.').replace(before, after) };
}
