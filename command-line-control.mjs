import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,win32} from 'node:path';
assert.equal(process.platform,'win32');mkdirSync('probe/evidence',{recursive:true});
const report={node:process.version,queries:[]};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--','--user-data-dir=C:\\fixture space\\électron'],{stdio:'ignore'});await once(child,'spawn');
const ps=win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const command=pid=>`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $p = [wmi]\"Win32_Process.Handle='${pid}'\"; [Console]::WriteLine($p.CommandLine)`;
try{
 for(const [pid,timeout] of [[child.pid,1000],[child.pid,10000],[child.pid,1000],[2147483647,1000]]){
 const start=performance.now();let row={kind:'direct-wmi',pid,timeout,script:command(pid)};
 try{row.stdout=execFileSync(ps,['-NoProfile','-NonInteractive','-Command',row.script],{encoding:'utf8',timeout});row.matches=row.stdout.includes('--user-data-dir=C:\\fixture space\\électron')}catch(e){row.error=String(e);row.stdout=e.stdout;row.stderr=e.stderr;row.code=e.code}
 row.ms=performance.now()-start;report.queries.push(row);console.log(JSON.stringify(row));writeFileSync('probe/evidence/command-line-control.json',JSON.stringify(report,null,2));
 }
 const scriptFile=resolve('probe/evidence/command-line.js');writeFileSync(scriptFile,'WScript.Echo("HELLO");');
 for(const flags of [['//NoLogo'],['//NoLogo','//E:JScript','//U']]){
  const row={kind:'wsh-stdout-diagnosis',flags};try{const buf=execFileSync(win32.join(process.env.SystemRoot,'System32','cscript.exe'),[...flags,scriptFile],{timeout:10000});row.hex=buf.toString('hex');row.utf8=buf.toString('utf8');row.utf16=buf.toString('utf16le')}catch(e){row.error=String(e)}report.queries.push(row);console.log(JSON.stringify(row));
 }
}finally{const exit=once(child,'exit');child.kill();await exit;report.childExited=true;writeFileSync('probe/evidence/command-line-control.json',JSON.stringify(report,null,2));}
