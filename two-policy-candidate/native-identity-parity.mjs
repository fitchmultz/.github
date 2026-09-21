// Native API/token parity and fail-closed behavior; run after the cold contract, never as warmup.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
assert.equal(process.platform, 'win32');
const dev = process.cwd();
const identityUrl = pathToFileURL(join(dev, 'extensions/agent-browser/lib/process-identity.ts')).href;
const lockUrl = pathToFileURL(join(dev, 'extensions/agent-browser/lib/managed-session-policy-lock.ts')).href;
const { buildProcessStartIdentityCommand, normalizeProcessStartIdentity, readProcessStartIdentity } = await import(identityUrl);
const { acquireManagedSessionPolicyLock, getManagedSessionPolicyLockPath } = await import(lockUrl);
const run = promisify(execFile);
const rows = [];
async function legacy(pid) {
 const command = buildProcessStartIdentityCommand(pid);
 const args = ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ("win32-powershell-ticks-v1:" + $p.StartTime.ToUniversalTime().Ticks)`];
 const result = await run(command.file, args, { timeout: 10000 });
 return normalizeProcessStartIdentity(result.stdout);
}
const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
const childExit = once(child, 'exit');
await once(child.stdout, 'data');
const sessionName = `piab-native-parity-${process.pid}`;
let lock, recovered;
try {
 for (const pid of [process.pid, child.pid]) {
  const actual = await readProcessStartIdentity(pid), old = await legacy(pid);
  assert.match(actual, /^win32-powershell-ticks-v1:\d+$/);
  assert.equal(actual, old);
  rows.push({ pid, actual, old });
 }
 const absent = 2147483647;
 assert.throws(() => process.kill(absent, 0), error => error.code === 'ESRCH');
 assert.equal(await readProcessStartIdentity(absent), undefined);
 await assert.rejects(legacy(absent), error => error.code === 1 && error.stdout === '');
 child.stdin.end(); await childExit;
 assert.equal(await readProcessStartIdentity(child.pid), undefined);
 lock = await acquireManagedSessionPolicyLock({ sessionName }); assert.ok(lock);
 const base = getManagedSessionPolicyLockPath(sessionName);
 const claims = (await readdir(dirname(base))).filter(name => name.startsWith(`${basename(base)}.claim-`));
 assert.equal(claims.length, 1);
 const ownerPath = join(dirname(base), claims[0], 'owner.json');
 const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
 const old = await legacy(process.pid);
 await writeFile(ownerPath, JSON.stringify({ ...owner, startIdentity: old }));
 assert.equal(await acquireManagedSessionPolicyLock({ sessionName, timeoutMs: 25 }), undefined, 'persisted old token must exclude live owner');
 await writeFile(ownerPath, JSON.stringify({ ...owner, startIdentity: old + '-mismatch' }));
 recovered = await acquireManagedSessionPolicyLock({ sessionName }); assert.ok(recovered);
 await assert.rejects(readFile(ownerPath), error => error.code === 'ENOENT');
 const failure = `import assert from 'node:assert/strict'; import { readProcessStartIdentity } from ${JSON.stringify(identityUrl)}; import { acquireManagedSessionPolicyLock } from ${JSON.stringify(lockUrl)}; assert.equal(await readProcessStartIdentity(process.pid), undefined); assert.equal(await acquireManagedSessionPolicyLock({ sessionName: 'piab-query-unavailable-' + process.pid }), undefined); console.log('query unavailable: fail closed');`;
 const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', failure], { cwd: dev, env: { ...process.env, SystemRoot: join(dev, 'nonexistent-system-root') }, timeout: 10000 });
 console.log(JSON.stringify({ rows, absentPid: absent, exitedChild: child.pid, oldTokenExclusion: true, mismatchedTokenReclaimed: true, failClosed: result.stdout.trim() }, null, 2));
} finally {
 child.stdin.end(); await childExit;
 await recovered?.release(); await lock?.release();
}
