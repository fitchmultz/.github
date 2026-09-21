import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchElectronApp } from './extensions/agent-browser/lib/electron/launch.ts';
import { cleanupElectronLaunchResources } from './extensions/agent-browser/lib/electron/cleanup.ts';
import { writeFakeLaunchableElectronApp, isTestPidAlive, stopTestPid } from './test/helpers/extension-validation-fixtures.ts';
const root=await mkdtemp(join(tmpdir(),'direct-cleanup-'));
try {
 for(let i=0;i<8;i++) {
  const dir=join(root,String(i));
  const app=await writeFakeLaunchableElectronApp({applicationsDir:dir,bundleId:'com.example.NativeCleanup',name:'Cleanup Control',launchLogPath:join(root,`${i}.json`)});
  const result=await launchElectronApp({appPath:app.appPath,appArgs:app.appArgs});assert.equal(result.ok,true);if(!result.ok)throw Error(JSON.stringify(result));
  const {child,record}=result.value,events:unknown[]=[];const start=performance.now();
  child.on('exit',(code,signal)=>events.push({phase:'exit',code,signal,at:performance.now()-start}));
  child.on('close',(code,signal)=>events.push({phase:'close',code,signal,at:performance.now()-start}));
  try {
   const cleanup=await cleanupElectronLaunchResources({child,record});
   const state={alive:isTestPidAlive(record.pid),exitCode:child.exitCode,signalCode:child.signalCode,at:performance.now()-start};
   let removal='removed';try{await rm(dir,{recursive:true,force:true})}catch(e){removal=String(e)}
   console.log(JSON.stringify({i,pid:record.pid,events,state,cleanup,removal}));
  } finally {await stopTestPid(record.pid);assert.equal(isTestPidAlive(record.pid),false)}
 }
} finally {await rm(root,{force:true,recursive:true})}
