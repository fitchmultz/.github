import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeJson } from "./common.mjs";
import { prepareHost, selectDevelopmentHost } from "./hosts.mjs";

const help = `Usage: node scripts/select-development-host.mjs --source PATH --directory PATH --version X.Y.Z

Installs the exact official Pi release in DIRECTORY with the canonical host installer, then
selects that complete SDK/CLI graph for the development checkout at SOURCE. SOURCE keeps its
original package.json and package-lock.json. DIRECTORY retains the installed package-lock.json
and receives host.json with the installation provenance and selected identity. The selected
identity is also printed as the last line of stdout.

Options:
  --source PATH     Development checkout whose imports and types use the selected host
  --directory PATH  Host installation directory
  --version X.Y.Z   Exact official version already resolved for this run
  -h, --help        Show this help

Example:
  node scripts/select-development-host.mjs --source "$GITHUB_WORKSPACE/extension" \\
    --directory "$RUNNER_TEMP/extras-host" --version "$OFFICIAL_VERSION"

Exit codes: 0 = host selected, 1 = invalid input or failed installation/selection.`;

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    directory: { type: "string" },
    version: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help === true) {
  console.log(help);
} else {
  const { source, directory } = values;
  const version = values.version ?? "";
  assert.ok(
    source !== undefined && source !== "" && directory !== undefined && directory !== "",
    "Required: --source PATH --directory PATH --version X.Y.Z",
  );
  assert.match(
    version,
    /^\d+\.\d+\.\d+$/,
    "--version must be the exact official X.Y.Z release already resolved for this run",
  );
  const hostDirectory = resolve(directory);
  const host = await prepareHost(hostDirectory, "official", version, process.env);
  const selected = selectDevelopmentHost(resolve(source), host, process.env);
  writeJson(join(hostDirectory, "host.json"), { provenance: host.provenance, ...selected });
  console.log(JSON.stringify(selected));
}
