// Final bounded diagnostic: expose newly observed restored-PID primary failure;
// retain assigned causal proof from prior job, finish types/build and immutable receipts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, run, sha256, stageSource } from '../automation/scripts/common.mjs';
import { prepareHost, selectDevelopmentHost } from '../automation/scripts/hosts.mjs';
assert.equal(process.platform,'win32');assert.equal(process.version,'v24.21.0');
const here=dirname(fileURLToPath(import.meta.url)),source=resolve(here,'../browser'),out=join(here,'evidence');mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'electron-proof-')),development=join(root,'development'),env=isolatedEnvironment(root);
const manifest=JSON.parse(readFileSync(join(here,'candidate-hashes.json'),'utf8'));
const report={node:process.version,npm:run('npm',['--version'],{env,quiet:true}).trim(),source:run('git',['rev-parse','HEAD'],{cwd:source,quiet:true}).trim(),manifest,runs:{}};
try {
 assert.equal(report.npm,'11.19.0');assert.equal(report.source,manifest.base);assert.equal(sha256(join(here,'candidate.patch')),manifest.patch);
 stageSource(source,development);run('git',['apply',join(here,'candidate.patch')],{cwd:development});
 report.actualHashes=Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(development,f))]));assert.deepEqual(report.actualHashes,manifest.files);
 run('npm',['ci','--ignore-scripts'],{cwd:development,env});
 const host=await prepareHost(join(root,'host'),'official','0.86.1',env),selected=selectDevelopmentHost(development,host,env);report.host=host;report.selected=selected;
 const testEnv={...env,PI_COMPAT_HOST:'official',PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 report.hostHashes={index:sha256(selected.index),cli:sha256(selected.cli)};
 function observe(name,args,timeout=60000){const r=spawnSync(process.execPath,args,{cwd:development,env:testEnv,encoding:'utf8',timeout,maxBuffer:32*1024*1024});writeFileSync(join(out,name+'.stdout.log'),r.stdout??'');writeFileSync(join(out,name+'.stderr.log'),r.stderr??'');report.runs[name]={args,status:r.status,signal:r.signal,error:r.error?.message};console.log(JSON.stringify({name,...report.runs[name]}));console.log(r.stdout??'');console.error(r.stderr??'');return r;}
 assert.equal(observe('identity',['scripts/compat-host.mjs']).status,0);
 assert.equal(observe('typecheck',['node_modules/typescript/bin/tsc','--noEmit'],120000).status,0);
 assert.equal(observe('build',['scripts/build.mjs'],120000).status,0);
 const discovery='test/agent-browser.extension-electron-discovery.test.ts',cleanupFile='extensions/agent-browser/lib/electron/cleanup.ts';
 let text=readFileSync(join(development,discovery),'utf8');
 const start=text.indexOf('test("agentBrowserExtension restores Electron launch records'),end=text.indexOf('\ntest(',start+1);
 let block=text.slice(start,end);
 block=block.replace('await assert.rejects(stat(launch.userDataDir));','console.log(JSON.stringify({phase:"restored-pid-cleanup",result:await cleanupElectronLaunchResources({record:(launchResult.details.electron).launch,timeoutMs:1000})})); await assert.rejects(stat(launch.userDataDir));');
 block=block.replace('} finally {\n\t\tawait stopTestPid(launchedPid);','} catch (error) {console.log(JSON.stringify({phase:"restored-primary-error",error:String(error),stack:error.stack}));throw error;} finally {\n\t\tconsole.log(JSON.stringify({phase:"restored-finally",launchedPid})); await stopTestPid(launchedPid);');
 text=text.slice(0,start)+block+text.slice(end);
 const trace='test/electron-restored-diagnostic.test.ts';writeFileSync(join(development,trace),text);
 const args=['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=restores Electron launch records',trace];
 const candidate=readFileSync(join(development,cleanupFile));
 writeFileSync(join(development,cleanupFile),run('git',['show',`HEAD:${cleanupFile}`],{cwd:development,quiet:true}));
 observe('original-restored-primary',args);
 writeFileSync(join(development,cleanupFile),candidate);observe('candidate-restored-primary',args);rmSync(join(development,trace));
 report.finalHashes=Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(development,f))]));assert.deepEqual(report.finalHashes,manifest.files);
 assert.equal(run('git',['status','--porcelain'],{cwd:source,quiet:true}).trim(),'');
} finally {
 try{rmSync(root,{recursive:true,force:true});report.cleanup='removed'}catch(e){report.cleanupError=String(e)}
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
