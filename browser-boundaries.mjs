// Temporary native evidence only; the product checkout stays at immutable 6075283.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, run, sha256, stageSource } from '../automation/scripts/common.mjs';
import { prepareHost, selectDevelopmentHost } from '../automation/scripts/hosts.mjs';
assert.equal(process.platform,'win32');
const here=dirname(fileURLToPath(import.meta.url)),source=resolve(here,'../browser'),out=join(here,'evidence');
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'browser-boundaries-')),development=join(root,'development'),env=isolatedEnvironment(root);
const report={node:process.version,source:run('git',['rev-parse','HEAD'],{cwd:source,quiet:true}).trim(),runs:{}};
try {
 stageSource(source,development);
 run('npm',['ci','--ignore-scripts'],{cwd:development,env});
 const host=await prepareHost(join(root,'host'),'official','0.86.1',env);
 const selected=selectDevelopmentHost(development,host,env);
 report.host=host;report.selected=selected;
 const testEnv={...env,PI_COMPAT_HOST:'official',PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 function observe(name,args,timeout=60000) {
  const r=spawnSync(process.execPath,args,{cwd:development,env:testEnv,encoding:'utf8',timeout,maxBuffer:16*1024*1024});
  writeFileSync(join(out,name+'.stdout.log'),r.stdout??'');writeFileSync(join(out,name+'.stderr.log'),r.stderr??'');
  report.runs[name]={args,status:r.status,signal:r.signal,error:r.error?.message};
  console.log(JSON.stringify({name,...report.runs[name]}));console.log(r.stdout??'');console.error(r.stderr??'');
 }
 observe('actual-abort-timeout',['--import','tsx',join(here,'browser-abort-observe.mjs'),development]);
 observe('artifact-path',['--import','tsx','--test','--test-reporter=tap','--test-name-pattern=registered artifacts retain requested and reported paths','test/agent-browser.artifact-diagnostics.test.ts']);
 observe('chromium-args',['--import','tsx','--test','--test-reporter=tap','test/agent-browser.chromium-args.test.ts']);
 report.productProcessSha256=sha256(join(development,'extensions/agent-browser/lib/process.ts'));
 report.checkoutUnchanged=run('git',['status','--porcelain'],{cwd:source,quiet:true}).trim()==='';assert.ok(report.checkoutUnchanged);
} finally {
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 try{rmSync(root,{recursive:true,force:true});}catch(e){console.log(JSON.stringify({cleanupError:String(e),root}));}
}
