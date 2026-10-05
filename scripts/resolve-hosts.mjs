import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveHostTargets } from "./hosts.mjs";

const { values } = parseArgs({ options: {
  host: { type: "string" }, "official-version": { type: "string" }, "fork-ref": { type: "string" },
  help: { type: "boolean", short: "h" },
} });
try {
  if (values.help) {
    console.log(`Usage: node scripts/resolve-hosts.mjs [options]\n\nResolve the latest stable official Pi cohort and maintained fork main once.\nExact inputs propagate identities already resolved earlier in the same run.\n\nOptions:\n  --host both|fork          Both hosts (default), or fork only without npm lookups\n  --official-version X.Y.Z  Official identity already resolved for this run\n  --fork-ref SHA            Fork identity already resolved for this run\n  -h, --help                Show this help\n\nExamples:\n  node scripts/resolve-hosts.mjs\n  node scripts/resolve-hosts.mjs --host fork\n\nWrites official-version/fork-ref to GITHUB_OUTPUT when set, and prints JSON.\nExit codes: 0 = resolved, 1 = invalid input or unavailable host/cohort.`);
  } else {
    const targets = await resolveHostTargets({ host: values.host, officialVersion: values["official-version"], forkRef: values["fork-ref"] });
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `official-version=${targets.officialVersion}\nfork-ref=${targets.forkRef}\n`);
    }
    console.log(JSON.stringify(targets, null, 2));
  }
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
