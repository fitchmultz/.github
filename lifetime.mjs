// Actual Node OS lifetime control. No Browser production changes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root=await mkdtemp(join(tmpdir(),'electron-os-'));
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
try {
 for(const detached of [false,true]) {
  const log=join(root,`${detached}.log`),receipt=join(root,`${detached}.json`);
  const script=`const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,ppid:process.ppid}));setInterval(()=>fs.writeSync(1,'writer\\n'),20);`;
  const hostScript=`const {spawn}=require('node:child_process');const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(log)},'wx');const child=spawn(process.execPath,['-e',${JSON.stringify(script)}],{detached:${detached},stdio:['ignore',fd,fd]});fs.closeSync(fd);child.unref();process.on('message',()=>process.disconnect());process.send({pid:child.pid});`;
  const host=spawn(process.execPath,['-e',hostScript],{stdio:['ignore','ignore','inherit','ipc']});
  const [{pid}]=await once(host,'message');
  try {
   for(let i=0;i<100;i++){if(await stat(receipt).catch(()=>false))break;await delay(20)}
   const identity=JSON.parse(await readFile(receipt,'utf8'));assert.equal(identity.pid,pid);
   const pre=await stat(log);await delay(80);const before={alive:alive(pid),growth:(await stat(log)).size-pre.size};
   const exit=once(host,'exit');host.send('exit');const hostExit=await exit;
   const post=await stat(log);await delay(80);const after={alive:alive(pid),growth:(await stat(log)).size-post.size};
   console.log(JSON.stringify({detached,identity,hostPid:host.pid,before,hostExit,after}));
   assert.equal(before.alive,true);assert.ok(before.growth>0);
  } finally {
   if(alive(pid)){process.kill(pid,'SIGKILL');for(let i=0;i<100&&alive(pid);i++)await delay(20)}
   assert.equal(alive(pid),false);
   if(host.exitCode===null)host.kill();
  }
 }
} finally {await rm(root,{recursive:true,force:true});console.log(JSON.stringify({root,cleanup:'removed'}))}
