// One current-head repeat; diagnostic logging only, no warmup or changed budgets/assertions.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,copyFileSync,rmSync,writeFileSync,createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isolatedEnvironment,run,sha256,stageSource} from '../../automation/scripts/common.mjs';
import {prepareHost,selectDevelopmentHost} from '../../automation/scripts/hosts.mjs';
assert.equal(process.platform,'win32');assert.equal(process.version,'v24.21.0');
const here=dirname(fileURLToPath(import.meta.url)),source=resolve(here,'../../browser'),out=resolve(here,'../restored-cleanup-evidence');mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'restored-cleanup-final-')),development=join(root,'development'),env=isolatedEnvironment(root);
const manifest=JSON.parse(readFileSync(join(here,'source-hashes.json'),'utf8'));
const instrumented=JSON.parse(readFileSync(join(here,'instrumented-hashes.json'),'utf8'));
const prior=JSON.parse(readFileSync(join(here,'prior-qualification.json'),'utf8'));
const report={node:process.version,root,development,sourceHead:'3a9adf490883149e7f79ee070d1900877e17b891',diagnosticHead:process.env.GITHUB_SHA,run:process.env.GITHUB_RUN_ID,manifest,runs:{}};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');save();
const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(development,f))]));
async function observe(name,args,timeout=300000,testEnv=env){
 const row={args,timeoutMs:timeout,started:new Date().toISOString()};report.runs[name]=row;save();
 const stdout=createWriteStream(join(out,name+'.stdout.log')),stderr=createWriteStream(join(out,name+'.stderr.log'));
 const child=spawn(process.execPath,args,{cwd:development,env:testEnv,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>{stdout.write(b);process.stdout.write(b)});child.stderr.on('data',b=>{stderr.write(b);process.stderr.write(b)});
 const timer=setTimeout(()=>{row.timeout=true;child.kill()},timeout);
 await new Promise(resolve=>{child.once('error',e=>{row.error=String(e)});child.once('close',(status,signal)=>{Object.assign(row,{status,signal,finished:new Date().toISOString()});resolve()})});clearTimeout(timer);
 await Promise.all([new Promise(r=>stdout.end(r)),new Promise(r=>stderr.end(r))]);save();return row;
}
const cleanupFile='extensions/agent-browser/lib/electron/cleanup.ts';
let originalCleanup;
try{
 report.npm=run('npm',['--version'],{env,quiet:true}).trim();assert.equal(report.npm,'11.19.0');
 report.source=run('git',['rev-parse','HEAD'],{cwd:source,quiet:true}).trim();assert.equal(report.source,report.sourceHead);
 assert.equal(sha256(join(here,'candidate.patch')),manifest.patch);
 report.helpers={common:sha256(resolve(here,'../../automation/scripts/common.mjs')),hosts:sha256(resolve(here,'../../automation/scripts/hosts.mjs'))};
 assert.deepEqual(report.helpers,{common:'0361e967d2f7dee849dce0f24a7cdaab2b9156bd41dff3810f8bc47f25ae3d5b',hosts:'9e7782cdf972864df8897c10449711bbe060e5757102c099d5a50a85fe2f42e0'});
 stageSource(source,development);report.beforeHashes=hashes();assert.deepEqual(report.beforeHashes,manifest.files);save();
 run('npm',['ci','--ignore-scripts'],{cwd:development,env});
 const host=await prepareHost(join(root,'host'),'fork',join(here,'fork-host'),env),selected=selectDevelopmentHost(development,host,env);report.host=host;report.selected=selected;
 assert.equal(host.provenance.ref,'f371064864ef239d66a81ee645a6774dc525be40');
 for(const key of ['indexSha256','cliSha256','cohort','companions'])assert.deepEqual(selected[key],prior.developmentHost[key]);
 const testEnv={...env,PI_COMPAT_HOST:'fork',PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 originalCleanup=readFileSync(join(development,cleanupFile));
 assert.equal(sha256(join(here,'instrumentation.patch')),instrumented.patch);
 run('git',['apply',join(here,'instrumentation.patch')],{cwd:development});
 report.instrumentedHashes=hashes();assert.deepEqual(report.instrumentedHashes,instrumented.files);save();
 const discovery='test/agent-browser.extension-electron-discovery.test.ts';
 // Original prefix/order/limits retained from42dac6; no direct query control before tests.
 await observe('candidate-cold-restored',['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=restores Electron launch records',discovery],60000,testEnv);
 await observe('candidate-reload-primary',['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=reuses only verified tracked Electron connections','test/agent-browser.extension-ref-guards.test.ts'],60000,testEnv);
 await observe('candidate-all-three',['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',discovery,'test/agent-browser.extension-electron-lifecycle.test.ts','test/agent-browser.extension-ref-guards.test.ts'],600000,testEnv);
 for(const [name,args] of [['identity',['scripts/compat-host.mjs']],['typecheck',['node_modules/typescript/bin/tsc','--noEmit']],['build',['scripts/build.mjs']]])await observe(name,args,180000,testEnv);
 report.afterInstrumentedHashes=hashes();assert.deepEqual(report.afterInstrumentedHashes,instrumented.files);
 writeFileSync(join(development,cleanupFile),originalCleanup);report.restoredHashes=hashes();assert.deepEqual(report.restoredHashes,manifest.files);save();
 assert.equal(run('git',['status','--porcelain'],{cwd:source,quiet:true}).trim(),'');
 if(Object.values(report.runs).some(r=>r.status!==0))process.exitCode=1;
}catch(e){report.error=String(e);process.exitCode=1;console.error(e)}finally{
 try{
  if(originalCleanup){writeFileSync(join(development,cleanupFile),originalCleanup);report.finalRestoredHashes=hashes();assert.deepEqual(report.finalRestoredHashes,manifest.files);}
  report.journals=[];report.npmLogs=[];
  function preserve(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
   const file=join(dir,entry.name);
   if(entry.isDirectory()&&!['node_modules','.git'].includes(entry.name))preserve(file);
   else if(entry.isFile()&&(entry.name.endsWith('.jsonl')||(file.includes('_logs')&&entry.name.endsWith('.log')))){
    const rel=relative(root,file),dest=join(out,'retained',rel);mkdirSync(dirname(dest),{recursive:true});copyFileSync(file,dest);(entry.name.endsWith('.jsonl')?report.journals:report.npmLogs).push(rel);
   }
  }}preserve(root);
  // Preserve evidence even if fixture teardown left a profile. Runner itself is disposable.
  report.remainingTempEntries=readdirSync(env.TMPDIR);
  rmSync(root,{recursive:true,force:true});report.cleanup='removed';
 }catch(e){report.cleanupError=String(e);process.exitCode=1}save();
}
