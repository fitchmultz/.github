import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [automation,source,flavor,outArg,forkArtifact,mode='final']=process.argv.slice(2);
assert.ok(automation&&source&&['official','fork'].includes(flavor)&&outArg);
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(outArg);mkdirSync(out,{recursive:true});
const {isolatedEnvironment,run,sha256,stageSource}=await import(pathToFileURL(join(automation,'scripts/common.mjs')));
const {prepareHost,selectDevelopmentHost}=await import(pathToFileURL(join(automation,'scripts/hosts.mjs')));
const manifest=JSON.parse(readFileSync(join(here,'source-hashes.json'),'utf8'));
const root=mkdtempSync(join(process.platform==='win32'?tmpdir():'/tmp','bmr-')),dev=join(root,'d'),env=isolatedEnvironment(root);
const report={node:process.version,platform:process.platform,flavor,mode,root,manifest,automation:run('git',['rev-parse','HEAD'],{cwd:automation,quiet:true}).trim(),helpers:Object.fromEntries(['common','hosts'].map(n=>[n,sha256(join(automation,`scripts/${n}.mjs`))])),inputs:Object.fromEntries(['check.mjs','candidate.patch','policy.before.ts','source-hashes.json'].map(f=>[f,sha256(join(here,f))])),runs:{},result:'running'};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');save();
try {
 assert.equal(report.automation,'736c45701fe96157644479a91fe507bea3135d22');
 assert.equal(sha256(join(here,'candidate.patch')),manifest.patch);
 stageSource(source,dev);
 assert.equal(run('git',['rev-parse','HEAD'],{cwd:dev,quiet:true}).trim(),manifest.base);
 if(!run('git',['status','--porcelain'],{cwd:dev,quiet:true}).trim())run('git',['apply',join(here,'candidate.patch')],{cwd:dev});
 const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(dev,f))]));
 assert.equal(Object.keys(manifest.files).length,236);
 assert.deepEqual(hashes(),manifest.files);report.sourceHashes=hashes();save();
 report.npm=run('npm',['--version'],{cwd:dev,env,quiet:true}).trim();save();
 assert.equal(report.node,'v24.21.0');assert.equal(report.npm,'11.19.0');
 run('npm',['ci','--ignore-scripts'],{cwd:dev,env});
 const host=await prepareHost(join(root,'h'),flavor,flavor==='official'?'0.86.1':forkArtifact,env);
 const selected=selectDevelopmentHost(dev,host,env);report.host=host;report.selected=selected;save();
 const testEnv={...env,PI_COMPAT_HOST:flavor,PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 const check=async(name,args)=>{
  const stdout=openSync(join(out,name+'.stdout.log'),'w'),stderr=openSync(join(out,name+'.stderr.log'),'w');
  report.runs[name]={args,status:'running',started:Date.now()};save();
  const child=spawn(process.execPath,args,{cwd:dev,env:testEnv,stdio:['ignore',stdout,stderr]});
  const result=await new Promise(resolve=>{child.once('error',error=>resolve({error:String(error)}));child.once('close',(status,signal)=>resolve({status,signal}));});
  closeSync(stdout);closeSync(stderr);Object.assign(report.runs[name],result,{finished:Date.now()});save();console.log(name,result);return result;
 };
 const testArgs=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1'];
 const policy=join(dev,'extensions/agent-browser/lib/managed-session-policy-lock.ts'),candidate=readFileSync(policy);
 assert.equal(sha256(join(here,'policy.before.ts')),manifest.oldPolicy);
 try {
  writeFileSync(policy,readFileSync(join(here,'policy.before.ts')));
  await check('old-production-open-reader',[...testArgs,'--test-name-pattern=native open-file rename conflict','test/agent-browser.managed-session-policy-lock.test.ts']);
 } finally {writeFileSync(policy,candidate);}
 const oldLog=readFileSync(join(out,'old-production-open-reader.stdout.log'),'utf8');
 assert.equal(report.runs['old-production-open-reader'].status,process.platform==='win32'?1:0);
 assert.match(oldLog,process.platform==='win32'?/# fail 1\b/:/# fail 0\b/);
 if(process.platform==='win32') {
  assert.match(oldLog,/not ok \d+ - managed session policy lock releases after a native open-file rename conflict after its acquisition wait/);
  assert.match(oldLog,/\nok \d+ - managed session policy lock releases after a native open-file rename conflict within its acquisition wait/);
 }
 if(mode==='final') {
  await check('types',['node_modules/typescript/bin/tsc','--noEmit']);
  await check('build',['scripts/build.mjs']);
  await check('policy',[...testArgs,'test/agent-browser.managed-session-policy-lock.test.ts']);
  await check('cross-instance',[...testArgs,'--test-name-pattern=cross-instance lock contention','test/agent-browser.extension-errors-artifacts.test.ts']);
  await check('close-grace',[...testArgs,'--test-name-pattern=default cleanup allows the native five-second browser shutdown grace','test/agent-browser.managed-session-daemon-policy.test.ts']);
 }
 assert.deepEqual(hashes(),manifest.files);report.finalHashes=hashes();save();
 assert.ok(Object.entries(report.runs).filter(([name])=>name!=='old-production-open-reader').every(([,r])=>r.status===0),'all corrected checks must pass');report.result='passed';
} catch(e){report.result='failed';report.error=String(e);process.exitCode=1;console.error(e);}
finally {if(report.result==='passed'){rmSync(root,{recursive:true,force:true});report.cleanup='removed owned model-free scratch';}save();}
