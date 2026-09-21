// Reuse the authorized external callback trace; add only missing lock observations.
import assert from 'node:assert/strict';
import { instrument as original } from './original-instrument.mjs';
export function instrument(files) {
 const output = original(files);
 const lock = 'extensions/agent-browser/lib/managed-session-policy-lock.ts';
 function replace(before, after) {
  assert.equal(output[lock].split(before).length, 2, `unique lock anchor: ${before}`);
  output[lock] = output[lock].replace(before, after);
 }
 replace('import { createHash, randomUUID }', 'import { appendFileSync } from "node:fs";\nimport { createHash, randomUUID }');
 replace("\tconsole.error('LOCK_TRACE ' + JSON.stringify({ event, hostPid: process.pid, at: new Date().toISOString(), ...details }));", "\tconst line = 'LOCK_TRACE ' + JSON.stringify({ event, hostPid: process.pid, at: new Date().toISOString(), ...details });\n\tconsole.error(line);\n\ttry { if (process.env.POLICY_TRACE_FILE) appendFileSync(process.env.POLICY_TRACE_FILE + '.' + process.pid, line + '\\n'); } catch {}");
 replace('try { names = await readdir(directory); } catch { return undefined; }', 'try { names = await readdir(directory); } catch (error) { diagnosticLock("readClaims-readdir-error", { basePath, error: String(error) }); return undefined; }');
 replace('\t\t\treturn undefined;\n\t\t}\n\t\tif (name !== `${prefix}${claim.owner.token}`) return undefined;', '\t\t\tdiagnosticLock("readClaims-invalid-existing", { path });\n\t\t\treturn undefined;\n\t\t}\n\t\tif (name !== `${prefix}${claim.owner.token}`) { diagnosticLock("readClaims-token-mismatch", { path, token: claim.owner.token }); return undefined; }');
 replace('\tconst current = await readProcessStartIdentity(owner.pid);\n\treturn current', '\tdiagnosticLock("owner-query-start", { owner });\n\tconst current = await readProcessStartIdentity(owner.pid);\n\tdiagnosticLock("owner-query-end", { owner, current: current ?? null });\n\treturn current');
 replace('\t\t} catch (error) {\n\t\t\treturn (error as NodeJS.ErrnoException).code === "ENOENT" ? { owner, path, ticket: null } : undefined;\n\t\t}\n\t} catch {\n\t\treturn undefined;\n\t}\n}\n\nasync function readClaims', '\t\t} catch (error) {\n\t\t\tif ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnosticLock("readClaim-ticket-error", { path, error: String(error) });\n\t\t\treturn (error as NodeJS.ErrnoException).code === "ENOENT" ? { owner, path, ticket: null } : undefined;\n\t\t}\n\t} catch (error) {\n\t\tdiagnosticLock("readClaim-error", { path, error: String(error) });\n\t\treturn undefined;\n\t}\n}\n\nasync function readClaims');
 replace('\t\t\tconst code = (error as NodeJS.ErrnoException).code;\n\t\t\tif (code === "ENOENT") return true;', '\t\t\tconst code = (error as NodeJS.ErrnoException).code;\n\t\t\tdiagnosticLock("remove-rename-error", { path, token, deadline, code, error: String(error) });\n\t\t\tif (code === "ENOENT") return true;');
 replace('async function cleanDeadPolicyArtifacts(directory: string): Promise<void> {', 'async function cleanDeadPolicyArtifacts(directory: string): Promise<void> {\n\tdiagnosticLock("cleanup-start", { directory });');
 replace('\t\tif (claim && await ownerAlive(claim.owner) === false) await rm(path, { force: true, recursive: true }).catch(() => undefined);\n\t}\n}', '\t\tdiagnosticLock("cleanup-read", { path, owner: claim?.owner });\n\t\tif (claim && await ownerAlive(claim.owner) === false) await rm(path, { force: true, recursive: true }).catch(() => undefined);\n\t\tdiagnosticLock("cleanup-read-done", { path });\n\t}\n\tdiagnosticLock("cleanup-end", { directory });\n}');
 replace('\tif (!await ensureCoordinationDirectory(directory, platform)) return undefined;', '\tif (!await ensureCoordinationDirectory(directory, platform)) { diagnosticLock("return-directory", { directory }); return undefined; }');
 replace('\tif (!startIdentity) return undefined;', '\tif (!startIdentity) { diagnosticLock("return-identity", { token }); return undefined; }');
 replace('\t\tif (!initialClaims) return undefined;', '\t\tif (!initialClaims) { diagnosticLock("return-initialClaims", { token }); return undefined; }');
 replace('\t\tif (!Number.isSafeInteger(maxTicket + 1)) return undefined;', '\t\tif (!Number.isSafeInteger(maxTicket + 1)) { diagnosticLock("return-ticket-overflow", { token, maxTicket }); return undefined; }');
 replace('\t\t\tif (!claims) return undefined;', '\t\t\tif (!claims) { diagnosticLock("return-readClaims", { token }); return undefined; }');
 replace('\t\t\tif (!ownClaim || ownClaim.ticket !== ticket.ticket) return undefined;', '\t\t\tif (!ownClaim || ownClaim.ticket !== ticket.ticket) { diagnosticLock("return-ownClaim", { token, ownClaim, ticket }); return undefined; }');
 replace('\t\t\t\tblocked = true;', '\t\t\t\tdiagnosticLock("blocked", { token, claim, alive, deadline });\n\t\t\t\tblocked = true;');
 replace('\t\t\tif (Date.now() >= deadline) return undefined;', '\t\t\tif (Date.now() >= deadline) { diagnosticLock("return-deadline", { token, deadline }); return undefined; }');
 replace('\t\treturn undefined;\n\t} catch {\n\t\treturn undefined;\n\t} finally {', '\t\tdiagnosticLock("return-abort", { token });\n\t\treturn undefined;\n\t} catch (error) {\n\t\tdiagnosticLock("return-catch", { token, error: String(error), stack: (error as Error).stack });\n\t\treturn undefined;\n\t} finally {');
 return output;
}
