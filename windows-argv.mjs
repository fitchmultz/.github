// Diagnostic only. No product imports, SDK graph, browser launch, or custom argument quoting.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../automation/scripts/common.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const evidence = join(here, 'evidence');
mkdirSync(evidence, { recursive: true });
assert.equal(process.platform, 'win32');
const root = mkdtempSync(join(tmpdir(), 'argv-proof-'));
const env = isolatedEnvironment(root);
const report = { node: process.version, arch: process.arch, platform: process.platform, versions: process.versions, root, cases: [], hashes: {} };
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
function run(label, command, args, launcher = spawnSync, options = {}) {
  const r = launcher(command, args, { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  const row = { label, command, args, utf8Hex: args.map(a => Buffer.from(a).toString('hex')), status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr };
  report.cases.push(row);
  writeFileSync(join(evidence, `${label}.json`), JSON.stringify(row, null, 2));
  console.log(JSON.stringify(row));
  assert.ifError(r.error);
  return row;
}
try {
  const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const prefix = join(root, 'stock');
  env.npm_config_prefix = prefix;
  assert.equal(run('npm-version', process.execPath, [npm, '--version']).stdout.trim(), '11.19.0');
  assert.equal(run('install-cross-spawn', process.execPath, [npm, 'install', '--prefix', join(root, 'deps'), '--save-exact', 'cross-spawn@7.0.6']).status, 0);
  assert.equal(run('install-stock', process.execPath, [npm, 'install', '--global', '--prefix', prefix, 'agent-browser@0.38.1'], spawnSync, { timeout: 180000 }).status, 0);
  const req = createRequire(join(root, 'deps/package.json'));
  const cross = req('cross-spawn');
  const pkg = join(prefix, 'node_modules/agent-browser');
  const native = join(pkg, 'bin/agent-browser-win32-x64.exe');
  const shim = join(prefix, 'agent-browser.cmd');
  const wrapper = join(pkg, 'bin/agent-browser.js');
  for (const [label, path] of Object.entries({ node: process.execPath, native, shim, wrapper, postinstall: join(pkg, 'scripts/postinstall.js'), package: join(pkg, 'package.json'), crossParse: req.resolve('cross-spawn/lib/parse'), crossEscape: req.resolve('cross-spawn/lib/util/escape'), crossPackage: req.resolve('cross-spawn/package.json') })) {
    report.hashes[label] = { path, sha256: hash(path) };
    if (!['node', 'native'].includes(label)) copyFileSync(path, join(evidence, `${label}.txt`));
  }
  report.stockShim = readFileSync(shim, 'utf8');
  report.crossVersion = req('cross-spawn/package.json').version;
  // Evaluate ONLY the verbatim existing helper function with its original module bindings.
  // No Pi imports and no substitute .cmd implementation.
  const helperPath = resolve(here, '../browser/test/helpers/agent-browser-harness.ts');
  const helper = readFileSync(helperPath, 'utf8');
  const functionSource = helper.slice(helper.indexOf('export async function writeFakeAgentBrowserBinary('), helper.indexOf('\nexport interface InvocationLogEntry'));
  assert.ok(functionSource.startsWith('export async function'));
  writeFileSync(join(evidence, 'existing-helper-function.ts'), functionSource);
  report.hashes.helper = { path: helperPath, sha256: hash(helperPath) };
  const fixtureModule = `import { writeFile, chmod } from 'node:fs/promises';\nimport { join } from 'node:path';\nconst processPlatform = process.platform, nodeExecPath = process.execPath, TARGET_AGENT_BROWSER_VERSION_LABEL = 'agent-browser 0.38.1';\n${stripTypeScriptTypes(functionSource)}`;
  const { writeFakeAgentBrowserBinary } = await import(`data:text/javascript;base64,${Buffer.from(fixtureModule).toString('base64')}`);
  const fixture = join(root, 'fixture with space');
  mkdirSync(fixture);
  const fake = await writeFakeAgentBrowserBinary(fixture, `process.stdout.write(JSON.stringify({argv:process.argv.slice(2),hex:process.argv.slice(2).map(a=>Buffer.from(a).toString('hex'))}));`);
  env.PI_AGENT_BROWSER_TEST_PRESERVE_INTERNAL_LAUNCH_FLAGS = '1';
  const payload = '--no-startup-window,--disable-gpu\n--no-sandbox';
  report.exactPayload = payload;
  const vectors = {
    literal: ['open', 'https://chromium-args.example.test/', '--args', payload],
    controls: ['', 'one two', '"quoted"', 'C:\\path with space\\', '雪', 'one\r\ntwo', '%PATH%', 'a&b', 'a^b'],
  };
  for (const [name, args] of Object.entries(vectors)) {
    for (const [transport, exe, prefixArgs, launch] of [
      ['node', process.execPath, [join(fixture, 'agent-browser-fake.cjs')], spawnSync],
      ['cross-node', process.execPath, [join(fixture, 'agent-browser-fake.cjs')], cross.sync],
      ['cross-cmd', fake, [], cross.sync],
    ]) {
      const row = run(`${name}-${transport}`, exe, [...prefixArgs, ...args], launch);
      row.received = JSON.parse(row.stdout).argv;
      row.exact = JSON.stringify(row.received) === JSON.stringify(args);
      if (transport !== 'cross-cmd') assert.deepEqual(row.received, args);
      if (name === 'literal' && transport === 'cross-cmd') assert.equal(row.exact, false);
    }
  }
  // Rust dashboard argument validation happens before daemon startup and echoes the
  // exact invalid option. This observes a real stock Rust argv element, not a mock.
  const rustArgs = ['--json', 'dashboard', payload];
  for (const [name, exe, prefixArgs, launch] of [
    ['stock-native', native, [], spawnSync],
    ['stock-cross-native', native, [], cross.sync],
    ['stock-cmd', shim, [], cross.sync],
    ['stock-js-wrapper', process.execPath, [wrapper], spawnSync],
    ['stock-ps1', 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(prefix, 'agent-browser.ps1')], spawnSync],
  ]) {
    const version = run(`${name}-version`, exe, [...prefixArgs, '--version'], launch);
    assert.equal(version.status, 0);
    const row = run(`${name}-literal`, exe, [...prefixArgs, ...rustArgs], launch);
    row.expectedError = `Unknown dashboard option: ${payload}`;
    row.receivedError = JSON.parse(row.stdout).error;
    row.exact = row.receivedError === row.expectedError;
    assert.equal(row.status, 1);
    if (['stock-native', 'stock-cross-native', 'stock-js-wrapper'].includes(name)) assert.equal(row.exact, true);
    if (name === 'stock-cmd') assert.equal(row.exact, false);
  }
  // --args grammar acceptance control only: help does not echo its value.
  const help = run('stock-native-args-help', native, ['--args', payload, '--help']);
  assert.equal(help.status, 0);
  run('powershell-version', 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable | ConvertTo-Json -Compress']);
  run('cmd-version', process.env.COMSPEC || 'cmd.exe', ['/d', '/c', 'ver']);
  report.success = true;
} finally {
  // Preserve private fixture and installed-source identities in the disposable job;
  // artifacts include raw logs and source, not credentials or a browser profile.
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
}
