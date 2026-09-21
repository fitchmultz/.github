// Frozen source, real native Windows processes, no query warmup or budget changes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isolatedEnvironment,run,sha256,stageSource} from '../automation/scripts/common.mjs';
import {prepareHost,selectDevelopmentHost} from '../automation/scripts/hosts.mjs';
assert.equal(process.platform,'win32');assert.equal(process.version,'v24.21.0');
const here=dirname(fileURLToPath(import.meta.url)),source=resolve(here,'../browser'),out=join(here,'evidence');mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'restored-electron-')),development=join(root,'development'),env=isolatedEnvironment(root);
const manifest=JSON.parse(readFileSync(join(here,'candidate-hashes.json'),'utf8'));
const report={node:process.version,root,development,manifest,runs:{}};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');save();
async function observe(name,args,timeout=300000,testEnv=env){
 const row={args,started:new Date().toISOString()};report.runs[name]=row;save();
 const stdout=createWriteStream(join(out,name+'.stdout.log')),stderr=createWriteStream(join(out,name+'.stderr.log'));
 const child=spawn(process.execPath,args,{cwd:development,env:testEnv,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>{stdout.write(b);process.stdout.write(b)});child.stderr.on('data',b=>{stderr.write(b);process.stderr.write(b)});
 const timer=setTimeout(()=>{row.timeout=true;child.kill()},timeout);
 await new Promise(resolve=>{child.once('error',e=>{row.error=String(e)});child.once('close',(status,signal)=>{Object.assign(row,{status,signal,finished:new Date().toISOString()});resolve()})});clearTimeout(timer);
 await Promise.all([new Promise(r=>stdout.end(r)),new Promise(r=>stderr.end(r))]);save();return row;
}
try{
 report.source=run('git',['rev-parse','HEAD'],{cwd:source,quiet:true}).trim();assert.equal(report.source,manifest.base);assert.equal(sha256(join(here,'candidate.patch')),manifest.patch);
 stageSource(source,development);run('git',['apply',join(here,'candidate.patch')],{cwd:development});
 report.actualHashes=Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(development,f))]));assert.deepEqual(report.actualHashes,manifest.files);save();
 run('npm',['ci','--ignore-scripts'],{cwd:development,env});
 const host=await prepareHost(join(root,'host'),'official','0.86.1',env),selected=selectDevelopmentHost(development,host,env);report.host=host;report.selected=selected;
 const testEnv={...env,PI_COMPAT_HOST:'official',PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 report.hostHashes={index:sha256(selected.index),cli:sha256(selected.cli)};save();
 const discovery='test/agent-browser.extension-electron-discovery.test.ts',cleanupFile='extensions/agent-browser/lib/electron/cleanup.ts';
 // Actual restored shutdown is the FIRST candidate test. No preceding query control/warmup.
 await observe('candidate-cold-restored',['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=restores Electron launch records',discovery],60000,testEnv);
 await observe('candidate-all-three',['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',discovery,'test/agent-browser.extension-electron-lifecycle.test.ts','test/agent-browser.extension-ref-guards.test.ts'],600000,testEnv);
 for(const [name,args] of [['identity',['scripts/compat-host.mjs']],['typecheck',['node_modules/typescript/bin/tsc','--noEmit']],['build',['scripts/build.mjs']]])await observe(name,args,180000,testEnv);
 const candidate=readFileSync(join(development,cleanupFile));writeFileSync(join(development,cleanupFile),run('git',['show',`HEAD:${cleanupFile}`],{cwd:development,quiet:true}));
 await observe('original-restored',['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=restores Electron launch records|native command-line profile ownership',discovery],60000,testEnv);
 writeFileSync(join(development,cleanupFile),candidate);
 report.finalHashes=Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(development,f))]));assert.deepEqual(report.finalHashes,manifest.files);
 assert.equal(run('git',['status','--porcelain'],{cwd:source,quiet:true}).trim(),'');
 if(Object.entries(report.runs).some(([n,r])=>n!=='original-restored'&&r.status!==0))process.exitCode=1;
 assert.notEqual(report.runs['original-restored'].status,0,'original must reproduce the native failure');
}catch(e){report.error=String(e);process.exitCode=1;console.error(e)}finally{
 try{rmSync(root,{recursive:true,force:true});report.cleanup='removed'}catch(e){report.cleanupError=String(e);process.exitCode=1}save();
}
