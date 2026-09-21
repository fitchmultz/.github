import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,writeFileSync} from 'node:fs';
import {win32} from 'node:path';
assert.equal(process.platform,'win32');
mkdirSync('probe/evidence',{recursive:true});
const report={node:process.version,queries:[]};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--','--user-data-dir=C:\\fixture space\\électron'],{stdio:'ignore'});
await once(child,'spawn');
const ps=win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
try{
 for(const kind of ['wmi','cim','wmi','cim']){
 const query=kind==='wmi'?`$p = ([wmisearcher]'SELECT CommandLine FROM Win32_Process WHERE ProcessId = ${child.pid}').Get(); foreach ($process in $p) { [Console]::WriteLine($process.CommandLine) }`:`Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${child.pid}' -ErrorAction Stop | Select-Object -ExpandProperty CommandLine`;
 const script='[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); '+query;
 const start=performance.now();let row={kind,pid:child.pid,script};
 try{row.stdout=execFileSync(ps,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:1000});row.matches=row.stdout.includes('--user-data-dir=C:\\fixture space\\électron')}catch(e){row.error=String(e);row.stdout=e.stdout;row.stderr=e.stderr;row.code=e.code}
 row.ms=performance.now()-start;report.queries.push(row);console.log(JSON.stringify(row));writeFileSync('probe/evidence/command-line-control.json',JSON.stringify(report,null,2));
 }
}finally{const exit=once(child,'exit');child.kill();await exit;report.childExited=true;writeFileSync('probe/evidence/command-line-control.json',JSON.stringify(report,null,2));}
