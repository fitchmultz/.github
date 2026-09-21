import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [automation,source,flavor,outArg,forkArtifact]=process.argv.slice(2);
assert.ok(automation&&source&&['official','fork'].includes(flavor)&&outArg);
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(outArg);mkdirSync(out,{recursive:true});
const {isolatedEnvironment,run,sha256}=await import(pathToFileURL(join(automation,'scripts/common.mjs')));
const {prepareHost,selectDevelopmentHost}=await import(pathToFileURL(join(automation,'scripts/hosts.mjs')));
const manifest=JSON.parse(readFileSync(join(here,'source-hashes.json'),'utf8'));
const root=mkdtempSync(join(process.platform==='win32'?tmpdir():'/tmp','bnpf-')),dev=join(root,'d'),env=isolatedEnvironment(root);
const files=['test/agent-browser.presentation-artifacts-batch.test.ts','test/agent-browser.snapshot-presentation.test.ts','test/doctor.test.ts','test/verify-lifecycle.test.ts'];
const report={node:process.version,platform:process.platform,flavor,root,manifest,files,runs:{},result:'running'};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');save();
try {
 assert.equal(sha256(join(here,'candidate.patch')),manifest.patch);assert.equal(sha256(join(here,'owned.patch')),manifest.ownedPatch);
 run('git',['clone','--no-hardlinks','--quiet',source,dev]);run('git',['checkout','--detach',manifest.base],{cwd:dev});run('git',['apply',join(here,'candidate.patch')],{cwd:dev});
 const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(dev,f))]));assert.deepEqual(hashes(),manifest.files);report.sourceHashes=hashes();save();
 run('npm',['ci','--ignore-scripts'],{cwd:dev,env});
 const host=await prepareHost(join(root,'h'),flavor,flavor==='official'?'0.86.1':forkArtifact,env),selected=selectDevelopmentHost(dev,host,env);report.host=host;report.selected=selected;save();
 const testEnv={...env,PI_COMPAT_HOST:flavor,PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 const check=async(name,args)=>{
  report.runs[name]={args,status:'running'};save();
  const stdout=join(out,name+'.stdout.log'),stderr=join(out,name+'.stderr.log');writeFileSync(stdout,'');writeFileSync(stderr,'');
  const start=performance.now();const r=await new Promise(resolveRun=>{
   const child=spawn(process.execPath,args,{cwd:dev,env:testEnv,stdio:['ignore','pipe','pipe'],timeout:240000});
   child.stdout.on('data',d=>{appendFileSync(stdout,d);process.stdout.write(d);});child.stderr.on('data',d=>{appendFileSync(stderr,d);process.stderr.write(d);});
   child.on('error',e=>resolveRun({status:null,error:String(e)}));child.on('close',(status,signal)=>resolveRun({status,signal}));
  });
  report.runs[name]={args,...r,elapsedMs:performance.now()-start};save();return r;
 };
 await check('types',['node_modules/typescript/bin/tsc','--noEmit']);await check('build',['scripts/build.mjs']);
 const args=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',...files];
 if(process.platform==='win32'){
  run('git',['apply','--reverse',join(here,'owned.patch')],{cwd:dev});
  try{const old=await check('old-four-files',args);assert.equal(old.status,1);assert.match(readFileSync(join(out,'old-four-files.stdout.log'),'utf8'),/# fail 14\b/);report.oldControl='14 original native failures reproduced';}
  finally{run('git',['apply',join(here,'owned.patch')],{cwd:dev});}
 }
 await check('four-files',args);
 assert.deepEqual(hashes(),manifest.files);report.finalHashes=hashes();assert.ok(Object.entries(report.runs).filter(([n])=>n!=='old-four-files').every(([,r])=>r.status===0),'all corrected checks must pass');report.result='passed';
} catch(e){report.result='failed';report.error=String(e);process.exitCode=1;console.error(e);}
finally {if(report.result==='passed'){rmSync(root,{recursive:true,force:true});report.cleanup='removed owned model-free scratch; no live profiles or journals touched';}save();}
