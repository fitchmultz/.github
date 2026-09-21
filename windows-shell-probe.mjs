// Ephemeral diagnostic: preserve exact production builders and capture OS-only paths.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment } from '../automation/scripts/common.mjs';
const keys = ['PSModulePath', 'ProgramFiles', 'ProgramW6432', 'CommonProgramFiles', 'SystemRoot'];
const output = (value) => console.log(JSON.stringify(value));
output({ shell: process.argv[2], node: process.version, paths: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null])) });
const query = `$p = Get-Process -Id ${process.pid} -ErrorAction Stop; $p.Id; $p.StartTime.ToUniversalTime().ToString('o')`;
for (const [label, restored] of [['ambient', null], ['candidate', []], ['program-files', ['ProgramFiles']], ['program-w6432', ['ProgramW6432']], ['common-program-files', ['CommonProgramFiles']], ['all-three', ['ProgramFiles', 'ProgramW6432', 'CommonProgramFiles']]]) {
  const root = mkdtempSync(join(tmpdir(), 'shell-query-'));
  const env = restored === null ? { ...process.env } : isolatedEnvironment(root);
  for (const key of restored ?? []) if (process.env[key]) env[key] = process.env[key];
  const start = performance.now();
  try {
    const result = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', query], { env, encoding: 'utf8', timeout: label === 'ambient' ? 30_000 : 5_000 });
    output({ label, ok: true, elapsedMs: performance.now() - start, result: result.trim(), modulePath: env.PSModulePath ?? null });
  } catch (error) {
    output({ label, ok: false, elapsedMs: performance.now() - start, code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), modulePath: env.PSModulePath ?? null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
