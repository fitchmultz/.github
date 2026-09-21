// One private Windows experiment; not a product qualification or a browser launch.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, sha256, stageSource } from '../automation/scripts/common.mjs';
import { prepareHost, selectDevelopmentHost } from '../automation/scripts/hosts.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const evidence = join(here, 'candidate-evidence');
mkdirSync(evidence, { recursive: true });
assert.equal(process.platform, 'win32');
assert.equal(process.version, 'v24.21.0');
const root = mkdtempSync(join(tmpdir(), 'native-candidate-'));
const env = isolatedEnvironment(root);
const development = join(root, 'browser');
const report = { node: process.version, platform: process.platform, arch: process.arch, root, hashes: {}, checks: [] };
function check(label, args, cwd = development, childEnv = env) {
  const r = spawnSync(process.execPath, args, { cwd, env: childEnv, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(evidence, `${label}.log`), `${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  report.checks.push({ label, args, cwd, status: r.status, signal: r.signal, error: r.error?.message });
  console.log(`${label}: ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ifError(r.error);
  assert.equal(r.status, 0, label);
}
try {
  stageSource(resolve(here, '../browser'), development);
  report.source = '6075283fea803fb5d002700852e591ef7d3a2caa';
  report.isolation = 'a78d00c02fa2f3c05fe53b082f0a338150981a65';
  report.host = await prepareHost(join(root, 'host'), 'official', '0.86.1', env);
  report.developmentHost = selectDevelopmentHost(development, report.host, env);
  for (const name of ['windows-native-command.ts', 'windows-native-command.test.ts']) {
    copyFileSync(join(here, name), join(root, name));
    copyFileSync(join(here, name), join(evidence, name));
    report.hashes[name] = sha256(join(here, name));
  }
  const testPath = join(development, 'test/agent-browser.chromium-args.test.ts');
  const original = readFileSync(testPath, 'utf8');
  const helper = join(development, 'test/helpers/agent-browser-harness.ts');
  report.hashes.originalChromium = sha256(testPath);
  report.hashes.immutableHelper = sha256(helper);
  report.hashes.immutableProcess = sha256(join(development, 'extensions/agent-browser/lib/process.ts'));
  copyFileSync(testPath, join(evidence, 'original-chromium.test.ts'));
  // Existing third parameter selects the Node shebang file; actual process.platform remains win32.
  const needle = "} else process.stdout.write(JSON.stringify({ success: true, data: data(tokens) }));`);";
  assert.equal(original.split(needle).length, 2);
  writeFileSync(testPath, original.replace(needle, needle.replace('`);', '`, "linux");')));
  report.hashes.portableChromium = sha256(testPath);
  copyFileSync(testPath, join(evidence, 'portable-chromium.test.ts'));
  check('native-resolver', ['--test', '--test-reporter=tap', join(root, 'windows-native-command.test.ts')], root, {
    ...env, PROBE_BROWSER_PACKAGE: join(development, 'package.json'), PROBE_OBSERVATIONS: join(evidence, 'native-observations.jsonl'),
  });
  check('candidate-typecheck', [join(development, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', '--typeRoots', join(development, 'node_modules/@types'), join(root, 'windows-native-command.ts')]);
  check('chromium-original-assertions', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'test/agent-browser.chromium-args.test.ts']);
  // Neither the source harness nor the product process was modified in the private checkout.
  assert.equal(sha256(helper), report.hashes.immutableHelper);
  assert.equal(sha256(join(development, 'extensions/agent-browser/lib/process.ts')), report.hashes.immutableProcess);
  report.success = true;
} finally {
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
}
