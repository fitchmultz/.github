// Private two-policy candidate: unchanged default chain FIRST; focused contracts afterward.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
const root = mkdtempSync(join(tmpdir(), 'bfn-')), dev = join(root, 'd'), env = isolatedEnvironment(root);
const report = { diagnosticHead: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, started: new Date().toISOString(), automation: automationRef, contractTimeoutMs, helpers: Object.fromEntries(['common', 'hosts'].map(name => [name, sha256(join(automation, `scripts/${name}.mjs`))])), inputs: Object.fromEntries(['check.mjs', 'candidate.patch', 'source-hashes.json', 'native-identity-parity.mjs'].map(name => [name, sha256(join(here, name))])), node: process.version, platform: process.platform, root, manifest, result: 'running', phase: 'source', runs: {} };
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
  assert.equal((await check('npm-ci', 'npm', ['ci', '--ignore-scripts'], env)).status, 0);
  const host = await prepareHost(join(root, 'h'), 'official', '0.86.1', env);
  const selected = selectDevelopmentHost(dev, host, env);
  for (const identity of [host, selected]) {
    assert.equal(identity.indexSha256, '82cb4ea864f3d8816c06bc8f2f2d9a8d82d883297af179dc69d287d042834844');
    assert.equal(identity.cliSha256, 'e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774');
  }
  report.host = host; report.selected = selected; report.phase = 'check:compat'; save();
  const testEnv = { ...env, PI_COMPAT_HOST: 'official', PI_COMPAT_EXPECTED_VERSION: host.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir, PI_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index, PI_HOST_CLI: selected.cli, PI_COMPAT_EVIDENCE_DIR: join(out, 'contracts') };
  // Installation only: no process identity query or warmup before the full suite.
  report.phase = 'install-stock'; save();
  const prefix = join(root, 'stock');
  assert.equal((await check('install-stock', 'npm', ['install', '--global', '--prefix', prefix, 'agent-browser@0.38.1'], env)).status, 0);
  testEnv.PI_AGENT_BROWSER_STOCK_PREFIX = prefix;
  report.stock = {};
  for (const file of ['agent-browser.cmd', 'node_modules/agent-browser/package.json', 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe', 'node_modules/agent-browser/bin/agent-browser.js', 'node_modules/agent-browser/scripts/postinstall.js']) {
    report.stock[file] = sha256(join(prefix, file));
    if (!file.endsWith('.exe')) { const target = join(out, 'stock-source', file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(prefix, file), target); }
  }
  report.phase = 'check:compat'; save();
  const result = await check('check-compat', 'npm', ['run', 'check:compat'], testEnv);
  report.finalHashes = hashes(); assert.deepEqual(report.finalHashes, manifest.files);
  report.result = result.status === 0 && !result.timedOut ? 'passed' : 'failed';
  if (report.result !== 'passed') process.exitCode = 1;
  else {
    // Retain a distribution artifact only after the complete contract succeeds.
    report.phase = 'retain-package'; save();
    assert.equal((await check('npm-pack', 'npm', ['pack', '--json', '--pack-destination', out], testEnv)).status, 0);
    const packedJson = JSON.parse(readFileSync(join(out, 'npm-pack.stdout.log'), 'utf8'));
    const packed = Array.isArray(packedJson) ? packedJson[0] : Object.values(packedJson)[0];
    report.package = { ...packed, sha256: sha256(join(out, packed.filename)), boundary: 'Retained canonical pack after successful full package consumer contract' };
    report.finalHashes = hashes(); assert.deepEqual(report.finalHashes, manifest.files);
  }
  // No pre-query primer. The first identity request is inside the unchanged default suite.
  for (const [name, args] of [
    ['prefix', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'test/agent-browser.argv-descriptor.test.ts', 'test/agent-browser.artifact-diagnostics.test.ts', 'test/agent-browser.batch-fidelity.test.ts', 'test/agent-browser.browser-evidence.test.ts', 'test/agent-browser.chromium-args.test.ts']],
    ['policy', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'test/agent-browser.managed-session-policy-lock.test.ts']],
    ['daemon-close', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'test/agent-browser.managed-session-daemon-policy.test.ts']],
    ['cross-instance', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-name-pattern=cross-instance lock contention', 'test/agent-browser.extension-errors-artifacts.test.ts']],
    ['native-parity', ['--import', 'tsx', join(dev, 'native-identity-parity.mjs')]],
  ]) {
    if (name === 'native-parity') copyFileSync(join(here, 'native-identity-parity.mjs'), join(dev, 'native-identity-parity.mjs'));
    const focused = await check(name, process.execPath, args, testEnv);
    if (focused.status !== 0 || focused.timedOut) { report.result = 'failed'; process.exitCode = 1; }
  }
  report.finalHashes = hashes(); assert.deepEqual(report.finalHashes, manifest.files);
} catch (error) {
  report.result = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  // Keep any surviving journals in native artifacts. Never delete a root with journals.
  report.journals = []; report.installLogs = [];
  function preserveJournals(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) preserveJournals(file);
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || file.split(sep).join('/').includes('/npm-cache/_logs/'))) {
        const rel = relative(root, file), destination = join(out, 'retained', rel);
        mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file, destination);
        (entry.name.endsWith('.jsonl') ? report.journals : report.installLogs).push(rel);
      }
    }
  }
  try {
    preserveJournals(root);
    report.cleanup = 'owned isolated root retained; surviving journals and npm logs copied to artifacts';
  } catch (error) { report.cleanupError = String(error); process.exitCode = 1; }
  save();
}
