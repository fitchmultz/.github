import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [browserArg,outArg]=process.argv.slice(2),browser=resolve(browserArg),out=resolve(outArg),here=dirname(fileURLToPath(import.meta.url));mkdirSync(out,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex'),manifest=JSON.parse(readFileSync(join(here,'source-hashes.json'),'utf8'));
const original=readFileSync(join(browser,'scripts/doctor.mjs'));assert.equal(sha(original),'37d7baf613d8db4cee034b1fea863ee51f1379d9a1de5ef71317c9900143103c');
const report={node:process.version,platform:process.platform,manifest,runs:{},result:'failed'};
function check(name){const args=['--experimental-strip-types','--test','--test-reporter=tap','test/doctor.test.ts'];const r=spawnSync(process.execPath,args,{cwd:browser,encoding:'utf8',timeout:60000});writeFileSync(join(out,name+'.stdout.log'),r.stdout??'');writeFileSync(join(out,name+'.stderr.log'),r.stderr??'');report.runs[name]={args,status:r.status,signal:r.signal,error:r.error?.message};console.log(name,r.status);return r;}
try {
 for(const [f,h] of Object.entries(manifest)){const bytes=readFileSync(join(here,f.endsWith('.test.ts')?'doctor.test.ts':'doctor.mjs'));assert.equal(sha(bytes),h);writeFileSync(join(browser,f),bytes);}
 writeFileSync(join(browser,'scripts/doctor.mjs'),original);const old=check('old-runtime');assert.equal(old.status,1);assert.match(old.stdout,/# fail 1\b/);assert.match(old.stdout,/not ok \d+ - doctor reports duplicate package and checkout sources with remediation/);
 writeFileSync(join(browser,'scripts/doctor.mjs'),readFileSync(join(here,'doctor.mjs')));const current=check('candidate');assert.equal(current.status,0,current.stdout);assert.match(current.stdout,/# fail 0\b/);
 for(const [f,h] of Object.entries(manifest))assert.equal(sha(readFileSync(join(browser,f))),h);report.result='passed';
} catch(e){report.error=String(e);process.exitCode=1;console.error(e);}
finally {writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
