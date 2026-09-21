// Ephemeral diagnostic only: exact uncommitted candidate in a private clone of Browser607.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, run, sha256, stageSource } from '../automation/scripts/common.mjs';
import { prepareHost, selectDevelopmentHost } from '../automation/scripts/hosts.mjs';
assert.equal(process.platform,'win32'); assert.equal(process.version,'v24.21.0');
const here=dirname(fileURLToPath(import.meta.url)),source=resolve(here,'../browser'),out=join(here,'evidence');
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'browser-fix-')),development=join(root,'development'),env=isolatedEnvironment(root);
const manifest=JSON.parse(readFileSync(join(here,'browser-native-fix-hashes.json'),'utf8'));
const report={node:process.version,source:run('git',['rev-parse','HEAD'],{cwd:source,quiet:true}).trim(),manifest,runs:{}};
try {
 assert.equal(report.source,manifest.base); assert.equal(sha256(join(here,'browser-native-fix.patch')),manifest.patch);
 stageSource(source,development);
 run('git',['apply',join(here,'browser-native-fix.patch')],{cwd:development});
 report.actualHashes=Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(development,f))]));assert.deepEqual(report.actualHashes,manifest.files);
 run('npm',['ci','--ignore-scripts'],{cwd:development,env});
 const host=await prepareHost(join(root,'host'),'official','0.86.1',env);
 const selected=selectDevelopmentHost(development,host,env); report.host=host;report.selected=selected;
 const testEnv={...env,PI_COMPAT_HOST:'official',PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 report.hostHashes={index:sha256(selected.index),cli:sha256(selected.cli)};
 function observe(name,args,timeout=60000) {
  const r=spawnSync(process.execPath,args,{cwd:development,env:testEnv,encoding:'utf8',timeout,maxBuffer:32*1024*1024});
  writeFileSync(join(out,name+'.stdout.log'),r.stdout??'');writeFileSync(join(out,name+'.stderr.log'),r.stderr??'');
  report.runs[name]={args,status:r.status,signal:r.signal,error:r.error?.message};
  console.log(JSON.stringify({name,...report.runs[name]}));console.log(r.stdout??'');console.error(r.stderr??'');
  return r;
 }
 const processFile='extensions/agent-browser/lib/process.ts',artifactFile='test/agent-browser.artifact-diagnostics.test.ts';
 const originals=Object.fromEntries([processFile,artifactFile].map(f=>[f,run('git',['show',`HEAD:${f}`],{cwd:development,quiet:true})]));
 const candidates=Object.fromEntries([processFile,artifactFile].map(f=>[f,readFileSync(join(development,f))]));
 const regression=['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=reaps its fixture before returning','test/agent-browser.process.test.ts'];
 const artifact=['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=registered artifacts retain requested and reported paths',artifactFile];
 for(const f of [processFile,artifactFile])writeFileSync(join(development,f),originals[f]);
 observe('red-original-800ms',['--import','tsx',join(here,'browser-abort-observe.mjs'),development]);
 assert.equal(observe('red-regression',regression).status,1);
 assert.equal(observe('red-artifact',artifact).status,1);
 for(const f of [processFile,artifactFile])writeFileSync(join(development,f),candidates[f]);
 const greenControl=observe('green-original-800ms',['--import','tsx',join(here,'browser-abort-observe.mjs'),development]);
 assert.equal(greenControl.status,0);
 const controls=greenControl.stdout.split('\n').filter(s=>s.startsWith('{')).map(s=>JSON.parse(s)).filter(r=>'fixtureAliveAfterReturn' in r);
 assert.equal(controls.length,3);for(const row of controls)assert.equal(row.fixtureAliveAfterReturn,false);
 assert.equal(observe('green-regression',regression).status,0);
 observe('green-artifact',artifact);
 // Preserve the unmodified test result above. This separate diagnostic copy only
 // prints actual result data before the same requested/reported assertions.
 const diagnostic=readFileSync(join(development,artifactFile),'utf8').replace('assert.equal(artifact.requestedPath, requestedPath);', 'console.log(JSON.stringify({ args, result, artifact })); assert.equal(artifact.requestedPath, requestedPath);');
 const diagnosticFile='test/artifact-native-boundary-diagnostic.test.ts';
 writeFileSync(join(development,diagnosticFile),diagnostic);
 observe('artifact-result-trace',[...artifact.slice(0,-1),diagnosticFile]);
 rmSync(join(development,diagnosticFile));
 observe('typecheck',['node_modules/typescript/bin/tsc','--noEmit'],120000);
 observe('build',['scripts/build.mjs'],120000);
 const originalControls=['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=resolveSpawnedChildExitCode|stops a hung|handles closed stdin|handles abort during|resolves after exit|returns timeout exit|removes abort listeners|spills oversized stdout|stops spilling','test/agent-browser.process.test.ts'];
 observe('original-process-controls',originalControls,120000);
 writeFileSync(join(development,processFile),originals[processFile]);
 observe('old-source-process-controls',originalControls,120000);
 writeFileSync(join(development,processFile),candidates[processFile]);
 observe('affected-cleanup',['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1','--test-name-pattern=abort|cancel|timeout|overlap|kill|cleanup|exits|exit','test/agent-browser.cold-boundaries.test.ts','test/agent-browser.destination-cancel.test.ts','test/agent-browser.extension-electron-discovery.test.ts','test/agent-browser.extension-electron-lifecycle.test.ts','test/agent-browser.extension-errors-artifacts.test.ts'],240000);
 report.finalHashes=Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(development,f))]));assert.deepEqual(report.finalHashes,manifest.files);
 report.checkoutUnchanged=run('git',['status','--porcelain'],{cwd:source,quiet:true}).trim()==='';assert.ok(report.checkoutUnchanged);
 if(Object.entries(report.runs).some(([name,r])=>!name.startsWith('red-')&&r.status!==0))process.exitCode=1;
} finally {
 try{rmSync(root,{recursive:true,force:true});report.cleanup='removed';}catch(e){report.cleanupError=String(e);console.log(JSON.stringify({cleanupError:String(e),root}));}
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
