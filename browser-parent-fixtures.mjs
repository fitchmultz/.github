import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [automation,source,flavor,outArg,forkArtifact]=process.argv.slice(2);
assert.ok(automation&&source&&['official','fork'].includes(flavor)&&outArg);
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(outArg);mkdirSync(out,{recursive:true});
const {isolatedEnvironment,run,sha256,stageSource}=await import(pathToFileURL(join(automation,'scripts/common.mjs')));
const {prepareHost,selectDevelopmentHost}=await import(pathToFileURL(join(automation,'scripts/hosts.mjs')));
const manifest=JSON.parse(readFileSync(join(here,'parent-fixtures-hashes.json'),'utf8'));
const root=mkdtempSync(join(process.platform==='win32'?tmpdir():'/tmp','bpf-')),dev=join(root,'d'),env=isolatedEnvironment(root);
const report={node:process.version,platform:process.platform,flavor,root,manifest,runs:{},result:'failed'};
try {
 assert.equal(sha256(join(here,'parent-fixtures.patch')),manifest.patch);
 stageSource(source,dev);
 // The hosted checkout is clean607; local source is an already patched immutable snapshot.
 const dirty=run('git',['status','--porcelain'],{cwd:dev,quiet:true}).trim();
 if(!dirty)run('git',['apply',join(here,'parent-fixtures.patch')],{cwd:dev});
 const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(dev,f))]));
 assert.deepEqual(hashes(),manifest.files);report.sourceHashes=hashes();
 run('npm',['ci','--ignore-scripts'],{cwd:dev,env});
 const host=await prepareHost(join(root,'h'),flavor,flavor==='official'?'0.86.1':forkArtifact,env);const selected=selectDevelopmentHost(dev,host,env);report.host=host;report.selected=selected;
 const testEnv={...env,PI_COMPAT_HOST:flavor,PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 for(const [name,args] of [['types',['node_modules/typescript/bin/tsc','--noEmit']],['build',['scripts/build.mjs']],['tests',['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1','test/agent-browser.process.test.ts','test/agent-browser.artifact-diagnostics.test.ts','test/agent-browser.cold-boundaries.test.ts']]]) {
  const r=spawnSync(process.execPath,args,{cwd:dev,env:testEnv,encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});
  writeFileSync(join(out,name+'.stdout.log'),r.stdout??'');writeFileSync(join(out,name+'.stderr.log'),r.stderr??'');report.runs[name]={args,status:r.status,signal:r.signal,error:r.error?.message};
  console.log(name,r.status);if(r.status!==0){console.log(r.stdout??'');console.error(r.stderr??'');}
 }
 assert.deepEqual(hashes(),manifest.files);report.finalHashes=hashes();
 assert.ok(Object.values(report.runs).every(r=>r.status===0),'all actual checks must pass');report.result='passed';
} catch(e){report.error=String(e);process.exitCode=1;console.error(e);}
finally {
 // These are model-free harness tests; they create no native Pi session journal.
 // Keep the owned root on failure for diagnosis rather than masking a locked-file error.
 if(report.result==='passed'){rmSync(root,{recursive:true,force:true});report.cleanup='removed';}
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
