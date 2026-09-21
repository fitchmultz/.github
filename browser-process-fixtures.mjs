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
const manifest=JSON.parse(readFileSync(join(here,'source-hashes.json'),'utf8'));
const root=mkdtempSync(join(process.platform==='win32'?tmpdir():'/tmp','bpfx-')),dev=join(root,'d'),env=isolatedEnvironment(root);
const report={node:process.version,platform:process.platform,flavor,root,manifest,runs:{},result:'failed'};
const focused='socket path preflight reports long configured roots|uses the Pi-scoped socket directory|removes oversized close stdout spill|pins managed restore identity|refuses a changed checkout identity|refuses incompatible environment changes';
try {
 assert.equal(sha256(join(here,'candidate.patch')),manifest.patch);
 assert.equal(sha256(join(here,'process.before.ts')),manifest.oldProcess);
 stageSource(source,dev);
 assert.equal(run('git',['rev-parse','HEAD'],{cwd:dev,quiet:true}).trim(),manifest.base);
 if(!run('git',['status','--porcelain'],{cwd:dev,quiet:true}).trim())run('git',['apply',join(here,'candidate.patch')],{cwd:dev});
 const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(dev,f))]));
 assert.deepEqual(hashes(),manifest.files);report.sourceHashes=hashes();
 run('npm',['ci','--ignore-scripts'],{cwd:dev,env});
 const host=await prepareHost(join(root,'h'),flavor,flavor==='official'?'0.86.1':forkArtifact,env);
 const selected=selectDevelopmentHost(dev,host,env);report.host=host;report.selected=selected;
 const testEnv={...env,PI_COMPAT_HOST:flavor,PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 const check=(name,args)=>{
  const r=spawnSync(process.execPath,args,{cwd:dev,env:testEnv,encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});
  writeFileSync(join(out,name+'.stdout.log'),r.stdout??'');writeFileSync(join(out,name+'.stderr.log'),r.stderr??'');
  report.runs[name]={args,status:r.status,signal:r.signal,error:r.error?.message}; console.log(name,r.status);
  if(r.status!==0){console.log(r.stdout??'');console.error(r.stderr??'');} return r;
 };
 check('types',['node_modules/typescript/bin/tsc','--noEmit']);
 check('build',['scripts/build.mjs']);
 const testArgs=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1'];
 if(process.platform==='win32') {
  const path=join(dev,'test/agent-browser.process.test.ts'),candidate=readFileSync(path);
  try {
   writeFileSync(path,readFileSync(join(here,'process.before.ts')));
   const old=check('old-six',[...testArgs,'--test-name-pattern='+focused,'test/agent-browser.process.test.ts']);
   assert.equal(old.status,1);assert.match(old.stdout,/# fail 6\b/);assert.equal((old.stdout.match(/^not ok /gm)??[]).length,6);
   report.oldControl='six expected fixture failures';
  } finally {writeFileSync(path,candidate);}
 }
 check('focused',[...testArgs,'--test-name-pattern='+focused,'test/agent-browser.process.test.ts']);
 check('full-process',[...testArgs,'test/agent-browser.process.test.ts']);
 assert.deepEqual(hashes(),manifest.files);report.finalHashes=hashes();
 assert.ok(Object.entries(report.runs).filter(([n])=>n!=='old-six').every(([,r])=>r.status===0),'all corrected checks must pass');report.result='passed';
} catch(e){report.error=String(e);process.exitCode=1;console.error(e);}
finally {
 if(report.result==='passed'){rmSync(root,{recursive:true,force:true});report.cleanup='removed owned model-free scratch';}
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
