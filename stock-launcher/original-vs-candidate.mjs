// Exact entry process.ts and production candidate, same isolated native stock install.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [dev, out] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(process.env.PI_AGENT_BROWSER_STOCK_PREFIX);
const old = await import(pathToFileURL(join(dev, 'extensions/agent-browser/lib/process-original.ts')));
const candidate = await import(pathToFileURL(join(dev, 'extensions/agent-browser/lib/process.ts')));
const cwd = await mkdtemp(join(tmpdir(), 'original-stock-'));
const env = { PATH: process.env.PI_AGENT_BROWSER_STOCK_PREFIX };
const cases = [];
try {
  for (const operand of ['--no-startup-window,--disable-gpu\n--no-sandbox', '--no-startup-window,--disable-gpu\r\n--no-sandbox', '', 'one two', '"quoted"', 'C:\\path with space\\', '雪 🐎', 'one\ntwo', 'one\r\ntwo', '%PATH%', 'a&b', 'a^b']) {
    const args = ['--json', 'dashboard', operand];
    const expected = `${operand.startsWith('-') ? 'Unknown dashboard option' : 'Unknown dashboard subcommand'}: ${operand}`;
    const original = await old.runAgentBrowserProcess({ args, cwd, env });
    const fixed = await candidate.runAgentBrowserProcess({ args, cwd, env });
    const row = { args, hex: Buffer.from(operand).toString('hex'), expected, original, candidate: fixed };
    cases.push(row); console.log(JSON.stringify(row));
    await writeFile(out, JSON.stringify(cases, null, 2));
    assert.equal(original.spawnError, undefined); assert.equal(fixed.spawnError, undefined);
    assert.equal(fixed.exitCode, 1); assert.equal(JSON.parse(fixed.stdout).error, expected);
    if (operand.includes('\n')) assert.notEqual(JSON.parse(original.stdout).error, expected);
  }
} finally { await writeFile(out, JSON.stringify(cases, null, 2)); }
