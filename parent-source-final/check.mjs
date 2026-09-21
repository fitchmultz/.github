import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [automation,source,flavor,outArg,forkArtifact]=process.argv.slice(2);assert.ok(automation&&source&&['official','fork'].includes(flavor)&&outArg);
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(outArg);mkdirSync(out,{recursive:true});
const {isolatedEnvironment,run,sha256,stageSource}=await import(pathToFileURL(join(automation,'scripts/common.mjs')));
const {prepareHost,selectDevelopmentHost}=await import(pathToFileURL(join(automation,'scripts/hosts.mjs')));
const manifest=JSON.parse(readFileSync(join(here,'source-hashes.json'),'utf8'));
const root=mkdtempSync(join(process.platform==='win32'?tmpdir():'/tmp','bpt-')),dev=join(root,'d'),env=isolatedEnvironment(root);
const report={node:process.version,platform:process.platform,flavor,root,manifest,runs:{},result:'failed'};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
try {
 assert.equal(sha256(join(here,'candidate.patch')),manifest.patch);
 for(const [f,h] of Object.entries(manifest.beforeHashes))assert.equal(sha256(join(here,'before',f)),h);
 stageSource(source,dev);assert.equal(run('git',['rev-parse','HEAD'],{cwd:dev,quiet:true}).trim(),manifest.base);
 if(!run('git',['status','--porcelain'],{cwd:dev,quiet:true}).trim())run('git',['apply',join(here,'candidate.patch')],{cwd:dev});
 const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(dev,f))]));assert.deepEqual(hashes(),manifest.files);report.sourceHashes=hashes();save();
 run('npm',['ci','--ignore-scripts'],{cwd:dev,env});const host=await prepareHost(join(root,'h'),flavor,flavor==='official'?'0.86.1':forkArtifact,env),selected=selectDevelopmentHost(dev,host,env);report.host=host;report.selected=selected;save();
 const testEnv={...env,PI_COMPAT_HOST:flavor,PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 function check(name,args){
  report.runs[name]={args,status:'running'};save();const stdout=openSync(join(out,name+'.stdout.log'),'w'),stderr=openSync(join(out,name+'.stderr.log'),'w');let r;const start=performance.now();
  try {r=spawnSync(process.execPath,args,{cwd:dev,env:testEnv,stdio:['ignore',stdout,stderr],timeout:300000});} finally{closeSync(stdout);closeSync(stderr);}
  report.runs[name]={args,status:r.status,signal:r.signal,error:r.error?.message,elapsedMs:performance.now()-start};save();console.log(name,r.status,report.runs[name].elapsedMs);return r;
 }
 check('types',['node_modules/typescript/bin/tsc','--noEmit']);check('build',['scripts/build.mjs']);
 const testArgs=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1'];
 check('source-lookup',[...testArgs,'test/agent-browser.extension-source-lookup.test.ts']);
 assert.deepEqual(hashes(),manifest.files);report.finalHashes=hashes();assert.ok(Object.values(report.runs).every(r=>r.status===0),'all corrected checks must pass');report.result='passed';
} catch(e){report.error=String(e);process.exitCode=1;console.error(e);}
finally {if(report.result==='passed'){rmSync(root,{recursive:true,force:true});report.cleanup='removed owned model-free scratch';}save();}
