import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [automation,source,flavor,outArg,forkArtifact]=process.argv.slice(2);
assert.ok(automation&&source&&['official','fork'].includes(flavor)&&outArg);
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(outArg);mkdirSync(out,{recursive:true});
const {isolatedEnvironment,run,sha256,stageSource}=await import(pathToFileURL(join(automation,'scripts/common.mjs')));
const {prepareHost,selectDevelopmentHost}=await import(pathToFileURL(join(automation,'scripts/hosts.mjs')));
const manifest=JSON.parse(readFileSync(join(here,'source-hashes.json'),'utf8'));
const root=mkdtempSync(join(process.platform==='win32'?tmpdir():'/tmp','bmw-')),dev=join(root,'d'),env=isolatedEnvironment(root);
const report={node:process.version,platform:process.platform,flavor,root,manifest,runs:{},result:'running'};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n'); save();
try {
 assert.equal(sha256(join(here,'candidate.patch')),manifest.patch);
 stageSource(source,dev);
 assert.equal(run('git',['rev-parse','HEAD'],{cwd:dev,quiet:true}).trim(),manifest.base);
 if(!run('git',['status','--porcelain'],{cwd:dev,quiet:true}).trim())run('git',['apply',join(here,'candidate.patch')],{cwd:dev});
 const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(dev,f))]));
 assert.deepEqual(hashes(),manifest.files);report.sourceHashes=hashes();save();
 run('npm',['ci','--ignore-scripts'],{cwd:dev,env});
 const host=await prepareHost(join(root,'h'),flavor,flavor==='official'?'0.86.1':forkArtifact,env);
 const selected=selectDevelopmentHost(dev,host,env);report.host=host;report.selected=selected;save();
 const testEnv={...env,PI_COMPAT_HOST:flavor,PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 const check=async(name,args,trace=false)=>{
  const traceDir=join(out,name+'-trace');if(trace)mkdirSync(traceDir,{recursive:true});
  const stdout=openSync(join(out,name+'.stdout.log'),'w'),stderr=openSync(join(out,name+'.stderr.log'),'w');
  report.runs[name]={args,status:'running',started:Date.now()};save();
  const child=spawn(process.execPath,args,{cwd:dev,env:trace?{...testEnv,NODE_OPTIONS:`--require=${JSON.stringify(join(here,'trace.cjs'))}`,PI_MANAGED_TRACE_DIR:traceDir}:testEnv,stdio:['ignore',stdout,stderr]});
  const result=await new Promise(resolve=>{child.once('error',error=>resolve({error:String(error)}));child.once('close',(status,signal)=>resolve({status,signal}));});
  closeSync(stdout);closeSync(stderr);Object.assign(report.runs[name],result,{finished:Date.now()});save(); console.log(name,result);return result;
 };
 const testArgs=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1'];
 if(process.env.MANAGED_TRACE_ONLY==='1') {
  await check('old-locks',[...testArgs,'test/agent-browser.managed-session-policy-lock.test.ts'],true);
  await check('old-contention',[...testArgs,'--test-name-pattern=cross-instance lock contention','test/agent-browser.extension-errors-artifacts.test.ts'],true);
  await check('old-restore',[...testArgs,'test/agent-browser.managed-session-restore.test.ts']);
  report.result='diagnostic-complete';
 } else {
  await check('types',['node_modules/typescript/bin/tsc','--noEmit']);
  await check('build',['scripts/build.mjs']);
  await check('managed',[...testArgs,'test/agent-browser.managed-session-policy-lock.test.ts','test/agent-browser.managed-session-restore.test.ts']);
  await check('extension',[...testArgs,'test/agent-browser.extension-errors-artifacts.test.ts']);
  assert.ok(Object.values(report.runs).every(r=>r.status===0),'all corrected checks must pass');report.result='passed';
 }
 assert.deepEqual(hashes(),manifest.files);report.finalHashes=hashes();
} catch(e){report.result='failed';report.error=String(e);process.exitCode=1;console.error(e);}
finally {if(['passed','diagnostic-complete'].includes(report.result)){rmSync(root,{recursive:true,force:true});report.cleanup='removed owned model-free scratch';}save();}
