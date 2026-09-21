import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [automation, source, outArg, flavor = 'official', fork, floor] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url)), out = resolve(outArg);
mkdirSync(out, { recursive: true });
const { isolatedEnvironment, run, sha256 } = await import(pathToFileURL(join(automation, 'scripts/common.mjs')));
const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, 'scripts/hosts.mjs')));
const manifest = JSON.parse(readFileSync(join(here, 'source-hashes.json'), 'utf8'));
const automationRef = run('git', ['rev-parse', 'HEAD'], { cwd: automation, quiet: true }).trim();
assert.equal(automationRef, '736c45701fe96157644479a91fe507bea3135d22');
const root = mkdtempSync(join(tmpdir(), 'slf-')), dev = join(root, 'd'), env = isolatedEnvironment(root);
const report = { automation: automationRef, flavor, helpers: Object.fromEntries(['common', 'hosts'].map(name => [name, sha256(join(automation, `scripts/${name}.mjs`))])), inputs: Object.fromEntries(['check.mjs', 'candidate.patch', 'source-hashes.json'].map(name => [name, sha256(join(here, name))])), node: process.version, platform: process.platform, root, manifest, result: 'running', phase: 'source', runs: {} };
const save = () => writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); save();
async function check(name, command, args, testEnv = env) {
  const row = { command, args, started: new Date().toISOString() }; report.runs[name] = row; save();
  const stdout = createWriteStream(join(out, name + '.stdout.log')), stderr = createWriteStream(join(out, name + '.stderr.log'));
  const child = spawn(command, args, { cwd: dev, env: testEnv, shell: process.platform === 'win32' && command === 'npm', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { stdout.write(bytes); process.stdout.write(bytes); });
  child.stderr.on('data', bytes => { stderr.write(bytes); process.stderr.write(bytes); });
  const timer = setTimeout(() => { row.timedOut = true; child.kill(); }, 300_000);
  await new Promise(resolve => {
    child.once('error', error => { row.error = String(error); });
    child.once('close', (status, signal) => { Object.assign(row, { status, signal, finished: new Date().toISOString() }); resolve(); });
  }); clearTimeout(timer);
  await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]); save(); return row;
}
try {
  assert.equal(sha256(join(here, 'candidate.patch')), manifest.patch);
  run('git', ['clone', '--no-hardlinks', '--quiet', source, dev]);
  run('git', ['checkout', '--detach', manifest.base], { cwd: dev });
  run('git', ['apply', join(here, 'candidate.patch')], { cwd: dev });
  const hashes = () => Object.fromEntries(Object.keys(manifest.files).map(file => [file, sha256(join(dev, file))]));
  report.sourceHashes = hashes(); assert.deepEqual(report.sourceHashes, manifest.files); save();
  report.npm = run('npm', ['--version'], { cwd: dev, env, quiet: true }).trim(); assert.equal(report.npm, '11.19.0');
  report.phase = 'install'; save();
  assert.equal((await check('npm-ci', 'npm', ['ci', '--ignore-scripts'])).status, 0);
  const host = await prepareHost(join(root, 'h'), flavor, flavor === 'official' ? '0.86.1' : fork, env);
  const selected = selectDevelopmentHost(dev, host, env);
  report.host = host; report.selected = selected; report.phase = 'checks'; save();
  const testEnv = { ...env, PI_COMPAT_HOST: flavor, PI_COMPAT_EXPECTED_VERSION: host.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir, PI_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index, PI_HOST_CLI: selected.cli };
  if (process.platform === 'win32') {
    assert.equal(process.version, 'v24.21.0');
    const prefix = join(root, 'stock');
    assert.equal((await check('install-stock', 'npm', ['install', '--global', '--prefix', prefix, 'agent-browser@0.38.1'])).status, 0);
    testEnv.PI_AGENT_BROWSER_STOCK_PREFIX = prefix;
    report.stock = {};
    for (const file of ['agent-browser.cmd', 'node_modules/agent-browser/package.json', 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe', 'node_modules/agent-browser/bin/agent-browser.js', 'node_modules/agent-browser/scripts/postinstall.js']) {
      report.stock[file] = sha256(join(prefix, file));
      if (!file.endsWith('.exe')) { const target = join(out, 'stock-source', file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(prefix, file), target); }
    }
    save();
  }
  for (const [name, args] of [
    ['identity', ['scripts/compat-host.mjs']], ['types', ['node_modules/typescript/bin/tsc', '--noEmit']], ['build', ['scripts/build.mjs']],
    ['stock-launcher', ['--import', 'tsx', '--test', '--test-reporter=tap', 'test/agent-browser.windows-stock-launcher.test.ts']],
    ['chromium', ['--import', 'tsx', '--test', '--test-reporter=tap', 'test/agent-browser.chromium-args.test.ts']],
    ['argv-process', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'test/agent-browser.windows-argv.test.ts', 'test/agent-browser.process.test.ts']],
  ]) await check(name, process.execPath, args, testEnv);
  if (floor) {
    report.floor = floor;
    for (const [name, args] of [['floor-types', ['node_modules/typescript/bin/tsc', '--noEmit']], ['floor-build', ['scripts/build.mjs']], ['floor-tests', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'test/agent-browser.windows-stock-launcher.test.ts', 'test/agent-browser.windows-argv.test.ts', 'test/agent-browser.chromium-args.test.ts', 'test/agent-browser.process.test.ts']]]) await check(name, floor, args, { ...testEnv, PATH: `${dirname(floor)}${process.platform === 'win32' ? ';' : ':'}${testEnv.PATH}` });
  }
  report.finalHashes = hashes(); assert.deepEqual(report.finalHashes, manifest.files);
  report.result = Object.values(report.runs).every(row => row.status === 0 && !row.timedOut) ? 'passed' : 'failed';
  if (report.result !== 'passed') process.exitCode = 1;
} catch (error) { report.result = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error); }
finally {
  report.journals = [];
  function preserve(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) preserve(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const rel = relative(root, file), destination = join(out, 'journals', rel);
        mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file, destination); report.journals.push(rel);
      }
    }
  }
  try { preserve(root); report.cleanup = 'owned isolated root retained; surviving journals also copied'; }
  catch (error) { report.cleanupError = String(error); process.exitCode = 1; }
  save();
}
