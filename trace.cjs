// Diagnostic only: observe native calls without changing results, retries, or deadlines.
const cp = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
const dest = path.join(process.env.PI_MANAGED_TRACE_DIR, `trace-${process.pid}.jsonl`);
const emit = (row) => fs.appendFileSync(dest, JSON.stringify({ time: Date.now(), pid: process.pid, ...row }) + '\n');
emit({ event: 'start', argv: process.argv });
const execFile = cp.execFile;
cp.execFile = function(file,args,...rest) {
 const started=Date.now(); const cb=rest.at(-1);
 if(typeof cb==='function') rest[rest.length-1]=function(error,stdout,stderr){
  emit({event:'execFile',file,args,elapsed:Date.now()-started,error:error&&{message:error.message,code:error.code,killed:error.killed,signal:error.signal},stdout,stderr});
  return cb.apply(this,arguments);
 };
 return execFile.call(this,file,args,...rest);
};
for (const name of ['mkdir','rename','writeFile','readFile','lstat','rm']) {
 const original=fsp[name];
 fsp[name]=async function(...args){
  const traced=String(args[0]).includes('pi-agent-browser-policy'); const started=Date.now();
  try {const result=await original.apply(this,args);if(traced)emit({event:name,path:String(args[0]),target:name==='rename'?args[1]:undefined,content:name==='writeFile'?String(args[1]):name==='readFile'?String(result):undefined,elapsed:Date.now()-started});return result;}
  catch(error){if(traced)emit({event:name,path:String(args[0]),error:error.code,elapsed:Date.now()-started});throw error;}
 };
}
syncBuiltinESMExports();
