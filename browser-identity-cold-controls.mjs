// Native OS-only controls; no Pi/package installation or production mutation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [automation,browser,outArg]=process.argv.slice(2);assert.equal(process.platform,'win32');
const out=resolve(outArg);mkdirSync(out,{recursive:true});
const {isolatedEnvironment,sha256}=await import(pathToFileURL(join(automation,'scripts/common.mjs')));
const identityPath=join(browser,'extensions/agent-browser/lib/process-identity.ts');
const {buildProcessStartIdentityCommand,normalizeProcessStartIdentity}=await import(pathToFileURL(identityPath));
const report={node:process.version,platform:process.platform,identitySourceHash:sha256(identityPath),pid:process.pid,rows:[],result:'diagnosis-complete'};
function commandFor(label,pid){const command=buildProcessStartIdentityCommand(pid);assert.ok(command);if(label==='dotnet'){command.args=[...command.args];const last=command.args.length-1;assert.ok(command.args[last].includes(`Get-Process -Id ${pid} -ErrorAction Stop`));command.args[last]="$ErrorActionPreference = 'Stop'; "+command.args[last].replace(`Get-Process -Id ${pid} -ErrorAction Stop`,`[System.Diagnostics.Process]::GetProcessById(${pid})`);}return command;}
async function observe(label,pid,env,control){const command=commandFor(label,pid),start=performance.now();let firstByteMs;return await new Promise(resolve=>{const child=execFile(command.file,command.args,{env,timeout:5000,encoding:'utf8'},(error,stdout,stderr)=>resolve({label,control,pid,command,elapsedMs:performance.now()-start,firstByteMs,error:error?{code:error.code,signal:error.signal,killed:error.killed,message:error.message}:null,stdout,stderr,identity:error?null:normalizeProcessStartIdentity(stdout)??null}));child.stdout?.once('data',()=>{firstByteMs=performance.now()-start;});});}
try {
 for(const [pair,order] of [['old-first',['cmdlet','dotnet']],['new-first',['dotnet','cmdlet']],['old-first-second',['cmdlet','dotnet']]]) {
  for(const label of order) {
   const root=mkdtempSync(join(tmpdir(),'identity-cold-')),env=isolatedEnvironment(root);
   try {const row=await observe(label,process.pid,env,`${pair}/fresh-private-home-and-appdata`);row.environment=Object.fromEntries(['SystemRoot','PSModulePath','HOME','USERPROFILE','APPDATA','LOCALAPPDATA'].map(k=>[k,env[k]??null]));report.rows.push(row);console.log(JSON.stringify(row));writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
   finally {rmSync(root,{recursive:true,force:true});}
  }
 }
 // Absent PID semantics are essential for stale-lock and temp-owner correctness.
 const absent=2147483647;assert.throws(()=>process.kill(absent,0),{code:'ESRCH'});
 for(const label of ['cmdlet','dotnet']) {
  const root=mkdtempSync(join(tmpdir(),'identity-missing-')),env=isolatedEnvironment(root);
  try {const row=await observe(label,absent,env,'absent-pid');report.rows.push(row);console.log(JSON.stringify(row));assert.equal(row.identity,null);assert.ok(row.error,'absent PID must fail the native command');}
  finally {rmSync(root,{recursive:true,force:true});}
 }
 const identities=report.rows.filter(r=>r.pid===process.pid&&r.identity).map(r=>r.identity);assert.ok(identities.length);assert.equal(new Set(identities).size,1,'same live PID must retain exact serialized ticks across APIs');
} catch(error){report.error=String(error);report.result='diagnostic-error';process.exitCode=1;console.error(error);}
finally {writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
