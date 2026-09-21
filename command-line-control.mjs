import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,win32} from 'node:path';
assert.equal(process.platform,'win32');
mkdirSync('probe/evidence',{recursive:true});
const report={node:process.version,queries:[]};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--','--user-data-dir=C:\\fixture space\\électron'],{stdio:'ignore'});
await once(child,'spawn');
const scriptFile=resolve('probe/evidence/command-line.js');
const script='var p = GetObject("winmgmts:root/cimv2").Get("Win32_Process.Handle=\'" + WScript.Arguments(0) + "\'"); WScript.Echo(p.CommandLine);';
writeFileSync(scriptFile,script);
try{
 for(const pid of [child.pid,child.pid,2147483647]){
 const start=performance.now();let row={kind:'cscript-wmi',pid,script};
 try{row.stdout=execFileSync(win32.join(process.env.SystemRoot,'System32','cscript.exe'),['//NoLogo','//E:JScript','//U',scriptFile,String(pid)],{encoding:'utf16le',timeout:1000});row.matches=row.stdout.includes('--user-data-dir=C:\\fixture space\\électron')}catch(e){row.error=String(e);row.stdout=e.stdout;row.stderr=e.stderr;row.code=e.code}
 row.ms=performance.now()-start;report.queries.push(row);console.log(JSON.stringify(row));writeFileSync('probe/evidence/command-line-control.json',JSON.stringify(report,null,2));
 }
}finally{const exit=once(child,'exit');child.kill();await exit;report.childExited=true;writeFileSync('probe/evidence/command-line-control.json',JSON.stringify(report,null,2));}
