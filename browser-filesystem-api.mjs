// Native boundary control for the existing fixture's synchronous versus promise realpath APIs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../automation/scripts/common.mjs';
assert.equal(process.platform,'win32');
if(process.argv[2]!=='child') {
 const root=mkdtempSync(join(tmpdir(),'fs-api-proof-'));
 try{process.stdout.write(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'child'],{env:isolatedEnvironment(root),encoding:'utf8',timeout:30000}));}
 finally{rmSync(root,{recursive:true,force:true});}
} else {
 const root=mkdtempSync(join(tmpdir(),'ad-')),path=join(root,'canonical.png');
 try{
  writeFileSync(path,'fixture-only');
  const sync=realpathSync(path),native=realpathSync.native(path),promise=await realpath(path);
  console.log(JSON.stringify({node:process.version,requested:path,oldFixtureReported:sync,nativeFixtureReported:native,oldTestExpected:promise,syncMatchesPromise:sync===promise,nativeMatchesPromise:native===promise}));
  assert.notEqual(sync,promise,'must reproduce the original fixture API mismatch on the actual short-path ancestry');
  assert.equal(native,promise,'native fixture API must match the existing expected canonical path');
 } finally{rmSync(root,{recursive:true,force:true});}
}
