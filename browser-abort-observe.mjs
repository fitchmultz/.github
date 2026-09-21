// Native Windows controls: original production cancellation and ordered native taskkill.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
assert.equal(process.platform,'win32');
const source=process.argv[2];
const {runAgentBrowserProcess}=await import(pathToFileURL(join(source,'extensions/agent-browser/lib/process.ts')));
const {writeFakeAgentBrowserBinary,withPatchedEnv}=await import(pathToFileURL(join(source,'test/helpers/agent-browser-harness.ts')));
const {spawn:crossSpawn}=await import(pathToFileURL(join(source,'node_modules/cross-spawn/index.js')));
const alive=pid=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch{return false;}};
for(const mode of ['timeout','abort','ordered-taskkill']) {
 const root=await mkdtemp(join(tmpdir(),'abort-proof-')),pidPath=join(root,'pid.json');let identity;
 try {
  await writeFakeAgentBrowserBinary(root,`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({pid:process.pid,ppid:process.ppid,cwd:process.cwd()}));setInterval(()=>{},1000);`);
  await withPatchedEnv({PATH:`${root}${delimiter}${process.env.PATH??''}`,PI_AGENT_BROWSER_SOCKET_DIR:join(root,'s')},async()=>{
   const controller=new AbortController();let child,closed,pending;
   if(mode==='ordered-taskkill') {child=crossSpawn('agent-browser',['get','url'],{cwd:root,env:process.env,stdio:'pipe'});closed=once(child,'close');}
   else pending=runAgentBrowserProcess({args:['--session','diagnostic','get','url'],cwd:root,signal:controller.signal,timeoutMs:800});
   for(let i=0;i<100;i++){try{identity=JSON.parse(await readFile(pidPath,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,5));}}
   let result;
   if(mode==='ordered-taskkill') {
    assert.ok(identity,'control must observe the fixture');
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'pipe'});let stdout='',stderr='';killer.stdout.on('data',b=>stdout+=b);killer.stderr.on('data',b=>stderr+=b);
    const killed=await once(killer,'close');const exit=await closed;result={killerExit:killed,childExit:exit,stdout,stderr};
   } else {if(mode==='abort')controller.abort();result=await pending;}
   const stillAlive=alive(identity?.pid);
   console.log(JSON.stringify({mode,node:process.version,identity,result,fixtureAliveAfterReturn:stillAlive}));
   if(stillAlive){try{const output=execFileSync('taskkill.exe',['/PID',String(identity.pid),'/T','/F'],{encoding:'utf8',timeout:5000});console.log(JSON.stringify({mode,ownedCleanup:output}));}catch(e){console.log(JSON.stringify({mode,cleanupKillError:String(e)}));}}
  });
 } finally {
  try{await rm(root,{recursive:true,force:true});console.log(JSON.stringify({mode,cleanup:'removed'}));}
  catch(e){console.log(JSON.stringify({mode,cleanupError:String(e),root}));process.exitCode=1;}
 }
}
