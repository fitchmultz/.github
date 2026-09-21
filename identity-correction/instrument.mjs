// Diagnostic-only callback observation and native command phase markers.
// No environment, timeout, cache, output expression or return-value changes.
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
  const mark = phase => `[Console]::Error.WriteLine(("IDENTITY_PHASE ${phase} " + [DateTime]::UtcNow.ToString("O"))); `;
  replace(identity, '`$p = Get-Process', '`' + mark('script-entry') + '$p = Get-Process');
  replace(identity, '-ErrorAction Stop; Write-Output', '-ErrorAction Stop; ' + mark('process-returned') + 'Write-Output');
  replace(identity, '$p.StartTime.ToUniversalTime().Ticks)`', '$p.StartTime.ToUniversalTime().Ticks); ' + mark('output-returned').trimEnd() + '`');
  return output;
}
