// Temporary hosted diagnostic; never a compatibility gate or runtime workaround.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../automation/scripts/common.mjs';
import { buildProcessStartIdentityCommand, readProcessStartIdentity } from '../browser/extensions/agent-browser/lib/process-identity.ts';

if (process.platform !== 'win32') throw new Error('Native Windows diagnostic only');
const output = (value) => console.log(JSON.stringify(value));
if (process.argv[2] !== 'child') {
  let failed = false;
  for (const label of ['runner-environment', 'isolated-environment']) {
    const root = mkdtempSync(join(tmpdir(), 'process-query-probe-'));
    const env = label === 'runner-environment' ? process.env : isolatedEnvironment(root);
    const child = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url), 'child', label], {
      env, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    output({ label, childStatus: child.status, childSignal: child.signal, childError: child.error?.code });
    failed ||= child.status !== 0;
  }
  process.exitCode = failed ? 1 : 0;
} else {
  const environment = process.argv[3];
  const records = [];
  output({ environment, node: process.version, platform: process.platform,
    present: Object.fromEntries(['SystemRoot','SYSTEMDRIVE','USERDOMAIN','USERPROFILE','APPDATA','LOCALAPPDATA','PSModulePath'].map(k => [k, Boolean(process.env[k])])) });
  const command = buildProcessStartIdentityCommand(process.pid);
  const start = performance.now();
  const identity = await readProcessStartIdentity(process.pid);
  records.push({ case: 'actual-browser-helper-5000ms', ok: Boolean(identity), elapsedMs: performance.now() - start, identity });
  output({ environment, ...records.at(-1) });

  async function browserControl(label, endStdin) {
    const start = performance.now();
    let firstByteMs;
    return await new Promise(resolve => {
      const child = execFile(command.file, command.args, { timeout: endStdin ? 5_000 : 20_000, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ case: label, ok: !error && stdout.trim().startsWith('win32-powershell-ticks-v1:'),
          elapsedMs: performance.now() - start, firstByteMs, code: error?.code, signal: error?.signal,
          stdout: stdout.trim().slice(0, 500), stderr: stderr.trim().slice(0, 500) });
      });
      child.stdout?.once('data', () => { firstByteMs = performance.now() - start; });
      if (endStdin) child.stdin?.end();
    });
  }
  for (const [label, endStdin] of [['browser-same-command-observe-20000ms', false], ['browser-same-command-closed-stdin-5000ms', true]]) {
    const row = await browserControl(label, endStdin); records.push(row); output({ environment, ...row });
  }

  // Same native command and execFileSync API as Oracle; only this diagnostic adds a bound.
  const oracleArgs = ['-NoLogo','-NoProfile','-Command', `$p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`];
  for (const ignoreStdin of [false, true]) {
    const start = performance.now();
    let stdout = '', stderr = '', error;
    try {
      stdout = execFileSync('powershell.exe', oracleArgs, { encoding: 'utf8', timeout: 20_000,
        ...(ignoreStdin ? { stdio: ['ignore', 'pipe', 'pipe'] } : {}) });
    } catch (caught) { error = caught; stdout = String(caught.stdout ?? ''); stderr = String(caught.stderr ?? ''); }
    const row = { case: ignoreStdin ? 'oracle-command-ignored-stdin' : 'oracle-same-command-default-stdin',
      ok: !error && /^\d{4}-\d{2}-\d{2}T/.test(stdout.trim()), elapsedMs: performance.now() - start,
      code: error?.code, signal: error?.signal, stdout: stdout.trim().slice(0, 500), stderr: stderr.trim().slice(0, 500) };
    records.push(row); output({ environment, ...row });
  }
  process.exitCode = records.every(row => row.ok) ? 0 : 1;
}
