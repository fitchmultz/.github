// Ephemeral diagnostic only. No production policy or final qualification waiver.
import assert from 'node:assert/strict';
import { chownSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedEnvironment, run, sha256, stageSource, writeJson } from '../automation/scripts/common.mjs';
import { prepareHost, selectDevelopmentHost } from '../automation/scripts/hosts.mjs';

const automation = 'a78d00c02fa2f3c05fe53b082f0a338150981a65';
const sourceRef = '0f90560e9ea4dfe7377cf103b2142336d8141162';
const forkRef = 'f371064864ef239d66a81ee645a6774dc525be40';
const workspace = resolve(process.env.GITHUB_WORKSPACE ?? '.');
const output = join(workspace, 'evidence');
mkdirSync(output, { recursive: true });
const root = mkdtempSync('/tmp/pc-');
chownSync(root, process.getuid(), process.getgid());
const env = isolatedEnvironment(root);
const source = join(workspace, 'extension');
const development = join(root, 'development');
const target = join(process.env.RUNNER_TEMP, 'fork-package');
const git = (cwd, args) => run('git', args, { cwd, quiet: true }).trim();
const tracked = directory => Object.fromEntries(git(directory, ['ls-files', '-z']).split('\0').filter(Boolean).map(file => [file, sha256(join(directory, file))]));
const report = { diagnosticOnly: true, automation, source: sourceRef, fork: forkRef,
  diagnosticRef: git(join(workspace, 'diagnostic'), ['rev-parse', 'HEAD']),
  node: process.version, npm: run('npm', ['--version'], { env, quiet: true }).trim(),
  platform: process.platform, arch: arch(), osRelease: release(), availableParallelism: availableParallelism(),
  nativeConcurrency: Math.min(4, Math.max(1, availableParallelism() - 1)), root, checks: {}, startedAt: new Date().toISOString() };
let phase = 'prepare';
try {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.version, 'v24.21.0');
  assert.equal(report.npm, '11.19.0');
  assert.equal(report.nativeConcurrency, 2);
  for (const [directory, ref] of [['automation', automation], ['extension', sourceRef], ['fork', forkRef]]) {
    assert.equal(git(join(workspace, directory), ['rev-parse', 'HEAD']), ref);
    assert.equal(git(join(workspace, directory), ['diff', 'HEAD', '--']), '');
  }
  assert.equal(git(source, ['status', '--porcelain']), '');
  const baseline = tracked(source);
  writeJson(join(output, 'source-before.json'), baseline);
  writeJson(join(output, 'automation-hashes.json'), tracked(join(workspace, 'automation')));
  const data = join(workspace, 'fork/packages/ai/src/providers/data');
  cpSync(data, join(output, 'model-data'), { recursive: true });
  report.catalogHashes = Object.fromEntries(readdirSync(data).filter(file => file.endsWith('.json')).map(file => [file, sha256(join(data, file))]));
  const receipt = JSON.parse(readFileSync(join(target, 'receipt.json'), 'utf8'));
  assert.equal(receipt.ref, forkRef);
  assert.equal(receipt.modelDataManifestSha256, sha256(join(data, '.manifest.json')));
  assert.equal(receipt.lockSha256, sha256(join(workspace, 'fork/package-lock.json')));
  cpSync(join(target, 'receipt.json'), join(output, 'fork-receipt.json'));
  stageSource(source, development);
  run('npm', [existsSync(join(development, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts'], { cwd: development, env });
  report.host = await prepareHost(join(root, 'host'), 'fork', target, env);
  report.developmentHost = selectDevelopmentHost(development, report.host, env);
  assert.deepEqual(tracked(development), baseline);
  phase = 'exact-two-literal-patch';
  const file = join(development, 'scripts/compat-native.mjs');
  const before = readFileSync(file, 'utf8');
  const replacements = [['"--timeout-ms", "360000"', '"--timeout-ms", "900000"'], ['timeout: 390_000', 'timeout: 930_000']];
  let after = before;
  for (const [old, replacement] of replacements) {
    assert.equal(before.split(old).length - 1, 1);
    assert.equal(before.includes(replacement), false);
    after = after.replace(old, replacement);
  }
  assert.equal(replacements.reduce((text, [old, replacement]) => text.replace(replacement, old), after), before);
  writeFileSync(join(output, 'compat-native.before.mjs'), before);
  writeFileSync(file, after);
  writeFileSync(join(output, 'compat-native.after.mjs'), after);
  report.patch = { beforeSha256: sha256(join(output, 'compat-native.before.mjs')), afterSha256: sha256(file), replacements };
  const expected = { ...baseline, 'scripts/compat-native.mjs': sha256(file) };
  assert.deepEqual(tracked(development), expected);
  writeFileSync(join(output, 'diagnostic.diff'), git(development, ['diff', '--', 'scripts/compat-native.mjs']) + '\n');
  run(process.execPath, ['--check', file], { env });
  report.integrationFiles = readdirSync(join(development, 'test/integration')).filter(f => f.endsWith('.test.ts')).sort();
  assert.equal(report.integrationFiles.length, 48);
  console.log(JSON.stringify({ ...report, host: undefined, developmentHost: report.developmentHost }));
  phase = 'check:compat';
  const selected = report.developmentHost;
  const checkEnv = { ...env, PI_COMPAT_HOST: 'fork', PI_COMPAT_EXPECTED_VERSION: report.host.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir, PI_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index, PI_HOST_CLI: selected.cli, PI_COMPAT_EVIDENCE_DIR: join(root, 'probes', 'contracts') };
  writeJson(join(output, 'check-environment.json'), checkEnv);
  const stdout = openSync(join(output, 'check.stdout.log'), 'w');
  const stderr = openSync(join(output, 'check.stderr.log'), 'w');
  report.checkStartedAt = new Date().toISOString();
  const start = performance.now();
  try {
    run('npm', ['run', 'check:compat'], { cwd: development, env: checkEnv, timeout: 1_200_000, stdio: ['ignore', stdout, stderr] });
    report.checks.contracts = 'passed';
  } finally {
    report.checkDurationMs = performance.now() - start;
    report.checkEndedAt = new Date().toISOString();
    closeSync(stdout); closeSync(stderr);
    process.stdout.write(readFileSync(join(output, 'check.stdout.log')));
    process.stderr.write(readFileSync(join(output, 'check.stderr.log')));
    writeJson(join(output, 'development-after.json'), tracked(development));
    writeJson(join(output, 'source-after.json'), tracked(source));
    assert.deepEqual(tracked(source), baseline);
    assert.deepEqual(tracked(development), expected);
    assert.equal(git(source, ['status', '--porcelain']), '');
    report.trackedIntegrity = 'all tracked source/development files unchanged except exact two literals';
  }
  phase = 'complete-count-verification';
  const text = readFileSync(join(output, 'check.stdout.log'), 'utf8');
  const values = key => [...text.matchAll(new RegExp(`(?:#|ℹ) ${key} ([0-9.]+)`, 'g'))].map(m => Number(m[1]));
  report.suiteSummaries = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'duration_ms'].map(key => [key, values(key)]));
  assert.equal(values('tests').at(-1), 1097);
  assert.equal(values('pass').at(-1), 1097);
  for (const key of ['fail', 'cancelled', 'skipped']) assert.equal(values(key).at(-1), 0);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.phase = phase; report.error = error.stack;
  console.error(error); process.exitCode = 1;
} finally {
  report.endedAt = new Date().toISOString();
  if (existsSync(join(root, 'probes'))) cpSync(join(root, 'probes'), join(output, 'probes'), { recursive: true });
  writeJson(join(output, 'qualification.json'), report);
  console.log(JSON.stringify(report));
  // Disposable hosted runner retains the private stage until job teardown; no forced test exit.
}
