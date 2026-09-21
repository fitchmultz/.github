// One unchanged two-file retry; no identity warmup or test modifications.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [automation, source, outArg] = process.argv.slice(2);
assert.ok(automation && source && outArg);
assert.equal(process.platform, 'win32');
assert.equal(process.version, 'v24.21.0');
const here = dirname(fileURLToPath(import.meta.url)), out = resolve(outArg);
mkdirSync(out, { recursive: true });
const { isolatedEnvironment, run, sha256, stageSource } = await import(pathToFileURL(join(automation, 'scripts/common.mjs')));
const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, 'scripts/hosts.mjs')));
const manifest = JSON.parse(readFileSync(join(here, 'source-hashes.json'), 'utf8'));
const contractTimeoutMs = JSON.parse(readFileSync(join(automation, 'fleet.json'), 'utf8')).find(entry => entry.repo === 'pi-agent-browser-native').contractTimeoutMs[process.platform];
assert.equal(contractTimeoutMs, 900_000);
const automationRef = run('git', ['rev-parse', 'HEAD'], { cwd: automation, quiet: true }).trim();
assert.equal(automationRef, '736c45701fe96157644479a91fe507bea3135d22');
const root = mkdtempSync(join(tmpdir(), 'bcw-')), dev = join(root, 'd'), env = isolatedEnvironment(root);
const report = { automation: automationRef, contractTimeoutMs, helpers: Object.fromEntries(['common', 'hosts'].map(name => [name, sha256(join(automation, `scripts/${name}.mjs`))])), inputs: Object.fromEntries(['check.mjs', 'candidate.patch', 'source-hashes.json'].map(name => [name, sha256(join(here, name))])), node: process.version, platform: process.platform, root, manifest, result: 'running', phase: 'source', runs: {} };
const save = () => writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
save();
async function check(name, command, args, testEnv) {
  const row = { command, args, started: new Date().toISOString(), timeoutMs: contractTimeoutMs };
  report.runs[name] = row; save();
  const stdout = createWriteStream(join(out, name + '.stdout.log'));
  const stderr = createWriteStream(join(out, name + '.stderr.log'));
  const child = spawn(command, args, { cwd: dev, env: testEnv, shell: command === 'npm', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { stdout.write(bytes); process.stdout.write(bytes); });
  child.stderr.on('data', bytes => { stderr.write(bytes); process.stderr.write(bytes); });
  // Same whole-command budget and default SIGTERM as shared common.run.
  const timer = setTimeout(() => { row.timedOut = true; child.kill(); }, contractTimeoutMs);
  await new Promise(resolve => {
    child.once('error', error => { row.error = String(error); });
    child.once('close', (status, signal) => { Object.assign(row, { status, signal, finished: new Date().toISOString() }); resolve(); });
  });
  clearTimeout(timer);
  await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
  save();
  return row;
}
try {
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: source, quiet: true }).trim(), manifest.base);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: source, quiet: true }).trim(), '');
  assert.equal(sha256(join(here, 'candidate.patch')), manifest.patch);
  stageSource(source, dev);
  run('git', ['apply', join(here, 'candidate.patch')], { cwd: dev });
  const hashes = () => Object.fromEntries(Object.keys(manifest.files).map(file => [file, sha256(join(dev, file))]));
  report.sourceHashes = hashes(); assert.deepEqual(report.sourceHashes, manifest.files); save();
  report.npm = run('npm', ['--version'], { cwd: dev, env, quiet: true }).trim();
  assert.equal(report.npm, '11.19.0');
  report.phase = 'install'; save();
  run('npm', ['ci', '--ignore-scripts'], { cwd: dev, env });
  const host = await prepareHost(join(root, 'h'), 'official', '0.86.1', env);
  const selected = selectDevelopmentHost(dev, host, env);
  report.host = host; report.selected = selected; report.phase = 'check:compat'; save();
  const testEnv = { ...env, PI_COMPAT_HOST: 'official', PI_COMPAT_EXPECTED_VERSION: host.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir, PI_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index, PI_HOST_CLI: selected.cli, PI_COMPAT_EVIDENCE_DIR: join(out, 'contracts') };
    for (const [name, command, args] of [
    ['host', process.execPath, ['scripts/compat-host.mjs']],
    ['typecheck', 'npm', ['run', 'typecheck']],
    ['build', process.execPath, ['scripts/build.mjs']],
  ]) { const setup = await check(name, command, args, testEnv); assert.equal(setup.status, 0); }
  const result = await check('two-files', 'npm', ['exec', '--', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
    'test/agent-browser.browser-evidence.test.ts', 'test/agent-browser.chromium-args.test.ts'], testEnv);
  report.finalHashes = hashes(); assert.deepEqual(report.finalHashes, manifest.files);
  report.result = result.status === 0 && !result.timedOut ? 'passed' : 'failed';
  if (report.result !== 'passed') process.exitCode = 1;
} catch (error) {
  report.result = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  // Keep any surviving journals in native artifacts. Never delete a root with journals.
  report.journals = [];
  function preserveJournals(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) preserveJournals(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const rel = relative(root, file), destination = join(out, 'journals', rel);
        mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file, destination); report.journals.push(rel);
      }
    }
  }
  try {
    preserveJournals(root);
    if (report.journals.length) report.cleanup = 'root retained; surviving journals copied to artifacts';
    else { rmSync(root, { recursive: true, force: true }); report.cleanup = 'removed owned journal-free root'; }
  } catch (error) { report.cleanupError = String(error); process.exitCode = 1; }
  save();
}
