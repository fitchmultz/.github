// Temporary native boundary control; no real browser/profile is selected or created.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../automation/scripts/common.mjs';
import { assertNotKnownBrowserUserDataPath, browserUserDataDirsForPlatform, knownBrowserUserDataPathMatch } from '../oracle/extensions/oracle/shared/browser-profile-helpers.mjs';
assert.equal(process.platform, 'win32');
if (process.argv[2] !== 'child') {
  const root = mkdtempSync(join(tmpdir(), 'oracle-profile-control-'));
  try {
    const env = { ...isolatedEnvironment(root), PRIVATE_PROBE_ROOT: root };
    process.stdout.write(execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'child'], { env, encoding: 'utf8', timeout: 30_000 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
} else {
  const root = process.env.PRIVATE_PROBE_ROOT;
  assert.equal(homedir(), join(root, 'home'));
  const oldPath = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? 'C:\\Users\\Default', 'AppData', 'Local'), 'Google', 'Chrome', 'User Data', 'pi-oracle-invalid-runtime-profile');
  const protectedRoot = browserUserDataDirsForPlatform('win32')[0];
  const correctedPath = join(protectedRoot, 'pi-oracle-invalid-runtime-profile');
  for (const path of [oldPath, protectedRoot, correctedPath]) {
    assert.ok(relative(root, path).startsWith('home\\'), 'all paths must remain inside the private HOME');
    assert.equal(existsSync(path), false, 'never touch an existing browser profile');
  }
  assert.equal(knownBrowserUserDataPathMatch(oldPath), undefined);
  assert.doesNotThrow(() => assertNotKnownBrowserUserDataPath(oldPath, 'runtime profile'));
  await rm(oldPath, { recursive: true, force: true });
  assert.equal(knownBrowserUserDataPathMatch(correctedPath), protectedRoot);
  assert.throws(() => assertNotKnownBrowserUserDataPath(correctedPath, 'runtime profile'), /must not point into a real browser user-data directory/);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, home: homedir(), localAppData: process.env.LOCALAPPDATA, oldPath, protectedRoot, correctedPath, oldGuardAccepted: true, oldAbsentRemovalSucceeded: true, correctedRejectedBeforeRemoval: true, browserPathsCreated: false }));
}
