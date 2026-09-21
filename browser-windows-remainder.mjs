// Diagnostic coverage for the files the first full Windows run never reached.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [automation,source,outArg]=process.argv.slice(2);assert.ok(automation&&source&&outArg);assert.equal(process.platform,'win32');
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(outArg);mkdirSync(out,{recursive:true});
const {isolatedEnvironment,run,sha256,stageSource}=await import(pathToFileURL(join(automation,'scripts/common.mjs')));
const {prepareHost,selectDevelopmentHost}=await import(pathToFileURL(join(automation,'scripts/hosts.mjs')));
const manifest=JSON.parse(readFileSync(join(here,'parent-fixtures-hashes.json'),'utf8'));
const root=mkdtempSync(join(tmpdir(),'bwr-')),dev=join(root,'d'),env=isolatedEnvironment(root);
const report={node:process.version,platform:process.platform,root,manifest,runs:{},result:'failed'};
try {
 assert.equal(sha256(join(here,'parent-fixtures.patch')),manifest.patch);stageSource(source,dev);run('git',['apply',join(here,'parent-fixtures.patch')],{cwd:dev});
 const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(dev,f))]));assert.deepEqual(hashes(),manifest.files);report.sourceHashes=hashes();
 run('npm',['ci','--ignore-scripts'],{cwd:dev,env});const host=await prepareHost(join(root,'h'),'official','0.86.1',env),selected=selectDevelopmentHost(dev,host,env);report.host=host;report.selected=selected;
 const testEnv={...env,PI_COMPAT_HOST:'official',PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 report.files=readdirSync(join(dev,'test')).filter(f=>f.endsWith('.test.ts')&&f>'agent-browser.extension-electron-lifecycle.test.ts'&&f!=='agent-browser.process.test.ts').sort().map(f=>'test/'+f);
 // A diagnostic-only observation ceiling; no shipped test/suite deadline changes.
 for(const [name,args,timeout] of [['types',['node_modules/typescript/bin/tsc','--noEmit'],120000],['build',['scripts/build.mjs'],120000],['tests',['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',...report.files],900000]]) {
  const start=performance.now(),r=spawnSync(process.execPath,args,{cwd:dev,env:testEnv,encoding:'utf8',timeout,maxBuffer:64*1024*1024});
  writeFileSync(join(out,name+'.stdout.log'),r.stdout??'');writeFileSync(join(out,name+'.stderr.log'),r.stderr??'');report.runs[name]={args,elapsedMs:performance.now()-start,status:r.status,signal:r.signal,error:r.error?.message};console.log(name,r.status,report.runs[name].elapsedMs);
 }
 assert.deepEqual(hashes(),manifest.files);report.finalHashes=hashes();assert.ok(Object.values(report.runs).every(r=>r.status===0),'all actual selected checks must pass');report.result='passed';
} catch(e){report.error=String(e);process.exitCode=1;console.error(e);}
finally {writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
