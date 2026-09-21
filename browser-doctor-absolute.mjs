// Diagnose the real doctor API's handling of supported native absolute settings sources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [browser,outArg]=process.argv.slice(2);assert.equal(process.platform,'win32');
const out=resolve(outArg);mkdirSync(out,{recursive:true});
const originalPath=join(browser,'scripts/doctor.mjs'),candidatePath=join(browser,'scripts/doctor-candidate.mjs'),original=readFileSync(originalPath,'utf8');
const oldImport='import { dirname, resolve, sep } from "node:path";',oldPredicate='return source.startsWith("/") || source.startsWith("./") || source.startsWith("../") || source.startsWith("~");';
assert.equal(original.split(oldImport).length,2);assert.equal(original.split(oldPredicate).length,2);
const candidate=original.replace(oldImport,'import { dirname, isAbsolute, resolve, sep } from "node:path";').replace(oldPredicate,'return isAbsolute(source) || source.startsWith("./") || source.startsWith("../") || source.startsWith("~");');writeFileSync(candidatePath,candidate);
const sha=s=>createHash('sha256').update(s).digest('hex'),root=mkdtempSync(join(tmpdir(),'doctor-absolute-')),cwd=join(root,'repo'),agentDir=join(root,'agent');
const {TARGET_AGENT_BROWSER_VERSION}=await import(pathToFileURL(join(browser,'scripts/agent-browser-target.mjs')));
const report={node:process.version,platform:process.platform,originalHash:sha(original),candidateHash:sha(candidate),root,rows:[],result:'failed'};
try {
 for(const [label,modulePath] of [['original',originalPath],['candidate',candidatePath]]) {
  const {evaluateDoctor}=await import(pathToFileURL(modulePath));
  for(const [kind,extensions] of [['native-absolute',[join(cwd,'extensions/agent-browser/index.ts')]],['settings-relative',['../extensions/agent-browser/index.ts']],['npm-only',[]]]) {
   const settings=new Map([[join(agentDir,'settings.json'),JSON.stringify({packages:['npm:pi-agent-browser-native']})],[join(cwd,'.pi/settings.json'),JSON.stringify({extensions})]]);
   const result=await evaluateDoctor({cwd,agentDir,pathExists:async p=>settings.has(p),readText:async p=>settings.get(p),runAgentBrowser:async()=>`agent-browser ${TARGET_AGENT_BROWSER_VERSION}\n`,runPi:async()=>'0.86.1\n'});
   const row={label,kind,cwd,extensions,failures:result.failures,checks:result.checks};report.rows.push(row);console.log(JSON.stringify(row));
   const expected=kind==='npm-only'||(label==='original'&&kind==='native-absolute')?0:1;assert.equal(result.failures.length,expected,`${label}/${kind}`);
   if(expected)assert.ok(result.failures.some(f=>f.title.includes('Duplicate')));
  }
 }
 report.result='confirmed-original-misses-native-absolute-candidate-detects';
} catch(error){report.error=String(error);process.exitCode=1;console.error(error);}
finally {rmSync(candidatePath,{force:true});rmSync(root,{recursive:true,force:true});writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');}
