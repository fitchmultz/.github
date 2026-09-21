// Temporary diagnosis only. Production test deadlines and behavior are unchanged.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [automation,source,outArg]=process.argv.slice(2);
assert.ok(automation&&source&&outArg); assert.equal(process.platform,'win32');
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(outArg);mkdirSync(out,{recursive:true});
const {isolatedEnvironment,run,sha256,stageSource}=await import(pathToFileURL(join(automation,'scripts/common.mjs')));
const {prepareHost,selectDevelopmentHost}=await import(pathToFileURL(join(automation,'scripts/hosts.mjs')));
const manifest=JSON.parse(readFileSync(join(here,'parent-fixtures-hashes.json'),'utf8'));
const root=mkdtempSync(join(tmpdir(),'identity-trace-')),dev=join(root,'d'),env=isolatedEnvironment(root);
const report={node:process.version,platform:process.platform,root,manifest,runs:{},controls:[],result:'failed'};
try {
 assert.equal(sha256(join(here,'parent-fixtures.patch')),manifest.patch);
 stageSource(source,dev);run('git',['apply',join(here,'parent-fixtures.patch')],{cwd:dev});
 const hashes=()=>Object.fromEntries(Object.keys(manifest.files).map(f=>[f,sha256(join(dev,f))]));
 assert.deepEqual(hashes(),manifest.files);report.sourceHashes=hashes();
 run('npm',['ci','--ignore-scripts'],{cwd:dev,env});
 const host=await prepareHost(join(root,'h'),'official','0.86.1',env),selected=selectDevelopmentHost(dev,host,env);
 report.host=host;report.selected=selected;
 const testEnv={...env,PI_COMPAT_HOST:'official',PI_HOST_INDEX:selected.index,PI_HOST_CLI:selected.cli,PI_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_PACKAGE_DIR:selected.packageDir,PI_COMPAT_EXPECTED_VERSION:host.version};
 const identityFile=join(dev,'extensions/agent-browser/lib/process-identity.ts'),original=readFileSync(identityFile,'utf8');
 report.identityOriginalHash=sha256(identityFile);
 const old=`\t\texecFile(command.file, command.args, { timeout: PROCESS_START_IDENTITY_TIMEOUT_MS }, (error, stdout) => {\n\t\t\tresolve(error ? undefined : normalizeProcessStartIdentity(stdout));\n\t\t});`;
 const replacement=`\t\tconst start = performance.now();\n\t\tlet firstByteMs: number | undefined;\n\t\tconst child = execFile(command.file, command.args, { timeout: PROCESS_START_IDENTITY_TIMEOUT_MS }, (error, stdout, stderr) => {\n\t\t\tconsole.error('IDENTITY_TRACE ' + JSON.stringify({ hostPid: process.pid, childPid: child.pid, file: command.file, args: command.args, elapsedMs: performance.now() - start, firstByteMs, error: error ? { code: error.code, signal: error.signal, killed: error.killed, message: error.message } : null, stdout, stderr, environment: Object.fromEntries(['SystemRoot', 'PSModulePath', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].map(key => [key, process.env[key]])) }));\n\t\t\tresolve(error ? undefined : normalizeProcessStartIdentity(stdout));\n\t\t});\n\t\tchild.stdout?.once('data', () => { firstByteMs = performance.now() - start; });`;
 assert.equal(original.split(old).length,2);writeFileSync(identityFile,original.replace(old,replacement));report.instrumentedIdentityHash=sha256(identityFile);
 const args=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1','--test-name-pattern=session info timeout','test/agent-browser.cold-boundaries.test.ts'];
 const r=spawnSync(process.execPath,args,{cwd:dev,env:testEnv,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
 writeFileSync(join(out,'cold.stdout.log'),r.stdout??'');writeFileSync(join(out,'cold.stderr.log'),r.stderr??'');report.runs.cold={args,status:r.status,signal:r.signal,error:r.error?.message};
 writeFileSync(identityFile,original);assert.equal(sha256(identityFile),report.identityOriginalHash);assert.deepEqual(hashes(),manifest.files);
 // Independent native controls. Extended old-command observation is diagnostic,
 // never a production timeout increase or a passing qualification substitute.
 const file=join(env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const prefix='win32-powershell-ticks-v1:';
 const commands={cmdlet:`$p = Get-Process -Id ${process.pid} -ErrorAction Stop; Write-Output ("${prefix}" + $p.StartTime.ToUniversalTime().Ticks)`,dotnet:`$p = [System.Diagnostics.Process]::GetProcessById(${process.pid}); Write-Output ("${prefix}" + $p.StartTime.ToUniversalTime().Ticks)`};
 for(const [label,timeout] of [['cmdlet',15000],['dotnet',5000],['cmdlet',5000],['dotnet',5000]]) {
  const start=performance.now();let firstByteMs;
  const row=await new Promise(resolve=>{const child=execFile(file,['-NoProfile','-NonInteractive','-Command',commands[label]],{env,timeout,encoding:'utf8'},(error,stdout,stderr)=>resolve({label,timeout,elapsedMs:performance.now()-start,firstByteMs,error:error?{code:error.code,signal:error.signal,killed:error.killed,message:error.message}:null,stdout,stderr}));child.stdout?.once('data',()=>{firstByteMs=performance.now()-start;});});report.controls.push(row);console.log(JSON.stringify(row));
 }
 report.result='diagnosis-complete';
} catch(e){report.error=String(e);process.exitCode=1;console.error(e);}
finally {writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
