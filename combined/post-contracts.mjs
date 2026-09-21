// Native consumer-phase diagnostic only. Full check:compat remains red and is not rerun or bypassed here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [automation, source, outArg] = process.argv.slice(2);
assert.ok(automation && source && outArg);
assert.equal(process.platform, 'win32'); assert.equal(process.version, 'v24.21.0');
const here = dirname(fileURLToPath(import.meta.url)), out = resolve(outArg);
mkdirSync(out, { recursive: true });
const { isolatedEnvironment, run, sha256, stageSource } = await import(pathToFileURL(join(automation, 'scripts/common.mjs')));
const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, 'scripts/hosts.mjs')));
const { checkResources, probeCli } = await import(pathToFileURL(join(automation, 'scripts/cli-probe.mjs')));
const manifest = JSON.parse(readFileSync(join(here, 'source-hashes.json'), 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'bcp-')), dev = join(root, 'd'), env = isolatedEnvironment(root);
const report = { node: process.version, platform: process.platform, root, manifest, result: 'running', phase: 'source', checks: {}, runs: {}, boundary: 'Consumer phases only; full package contract has known unresolved failures. Not release qualification.' };
const save = () => writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); save();
async function check(name, command, args, cwd, childEnv = env) {
  const row = { command, args, started: new Date().toISOString() }; report.runs[name] = row; report.phase = name; save();
  const stdout = createWriteStream(join(out, name + '.stdout.log')), stderr = createWriteStream(join(out, name + '.stderr.log'));
  const child = spawn(command, args, { cwd, env: childEnv, shell: command === 'npm', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { stdout.write(bytes); process.stdout.write(bytes); });
  child.stderr.on('data', bytes => { stderr.write(bytes); process.stderr.write(bytes); });
  const timer = setTimeout(() => { row.timedOut = true; child.kill(); }, 600000);
  await new Promise(resolve => { child.once('error', error => { row.error = String(error); }); child.once('close', (status, signal) => { Object.assign(row, { status, signal, finished: new Date().toISOString() }); resolve(); }); });
  clearTimeout(timer);
  await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]); save();
  assert.equal(row.status, 0, `${name} failed`); assert.ok(!row.timedOut, `${name} timed out`);
}
try {
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: source, quiet: true }).trim(), manifest.base);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: source, quiet: true }).trim(), '');
  assert.equal(sha256(join(here, 'candidate.patch')), manifest.patch);
  stageSource(source, dev); run('git', ['apply', join(here, 'candidate.patch')], { cwd: dev });
  const hashes = () => Object.fromEntries(Object.keys(manifest.files).map(file => [file, sha256(join(dev, file))]));
  report.sourceHashes = hashes(); assert.deepEqual(report.sourceHashes, manifest.files); save();
  await check('development-install', 'npm', ['ci', '--ignore-scripts'], dev);
  report.phase = 'host-selection'; save();
  const host = await prepareHost(join(root, 'h'), 'official', '0.86.1', env), selected = selectDevelopmentHost(dev, host, env);
  report.host = host; report.selected = selected; save();
  const testEnv = { ...env, PI_COMPAT_HOST: 'official', PI_COMPAT_EXPECTED_VERSION: host.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir, PI_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index, PI_HOST_CLI: selected.cli, PI_COMPAT_EVIDENCE_DIR: join(out, 'contracts') };
  await check('package-verifier', process.execPath, ['scripts/verify-package.mjs', '--smoke-pi'], dev, testEnv);
  report.checks.packageVerifier = 'passed'; save();
  const gitConsumer = join(root, 'git-consumer'); stageSource(source, gitConsumer);
  run('git', ['apply', join(here, 'candidate.patch')], { cwd: gitConsumer });
  await check('git-consumer-install', 'npm', ['install', '--omit=dev'], gitConsumer);
  checkResources(gitConsumer); report.phase = 'git-consumer-cli'; save();
  report.checks.gitCli = probeCli(host, gitConsumer, join(out, 'probes', 'git'), env); save();
  await check('npm-pack', 'npm', ['pack', '--json', '--pack-destination', out], dev);
  const packedJson = JSON.parse(readFileSync(join(out, 'npm-pack.stdout.log'), 'utf8'));
  const packed = Array.isArray(packedJson) ? packedJson[0] : Object.values(packedJson)[0];
  const tarball = join(out, packed.filename), pkg = JSON.parse(readFileSync(join(dev, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'pi-agent-browser-native');
  report.package = { name: pkg.name, version: pkg.version, file: packed.filename, integrity: packed.integrity, sha256: sha256(tarball) }; save();
  const consumer = join(root, 'npm-consumer'); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies: { [pkg.name]: `file:${tarball.replaceAll('\\', '/')}` } }));
  await check('npm-consumer-install', 'npm', ['install', '--omit=dev'], consumer);
  const installed = join(consumer, 'node_modules', pkg.name); checkResources(installed);
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, pkg.version);
  report.phase = 'npm-consumer-cli'; save(); report.checks.npmCli = probeCli(host, installed, join(out, 'probes', 'npm'), env);
  for (const key of ['tools', 'activeTools', 'commands', 'providers']) {
    const names = result => result[key].map(value => typeof value === 'string' ? value : value.name).sort();
    assert.deepEqual(names(report.checks.npmCli), names(report.checks.gitCli), `consumer ${key} mismatch`);
  }
  report.finalHashes = hashes(); assert.deepEqual(report.finalHashes, manifest.files);
  report.result = 'consumer-phases-passed';
} catch (error) { report.result = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error); }
finally {
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
