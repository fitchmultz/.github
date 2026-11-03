import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readArray, readJson, readRecord } from "./common.mjs";

// Node and the compiler can report the same directory through different aliases, for example
// /private/tmp and /tmp on macOS, so owned paths are compared canonically.
const root = realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
// The strict scope is these entrypoints and every owned module the compiler resolves from them.
const entrypoints = ["scripts/select-development-host.mjs", "scripts/check-quality.mjs"];
const standard = "docs/strict-quality-standard.md";
const records = [".oxfmtrc.json", ".oxlintrc.json", "tsconfig.json", standard];
const categories = [
  "correctness",
  "suspicious",
  "perf",
  "pedantic",
  "style",
  "restriction",
  "nursery",
];
const strictFamily = [
  "alwaysStrict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictBuiltinIteratorReturn",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
];
// Nested configurations and ignore files would otherwise relax or drop explicitly selected files.
const lintSelection = ["--disable-nested-config", "--no-ignore", "--deny-warnings"];
const configMessage = "Invalid tsc --showConfig output";
/**
 * @param {string} name
 * @param {string} [bin]
 */
const tool = (name, bin = name) => join(root, "node_modules", name, "bin", bin);
const tsc = tool("typescript", "tsc");
const oxlint = tool("oxlint");

/**
 * Runs one native check from the repository root and reports its actual exit.
 * @param {string} label
 * @param {string} script
 * @param {readonly string[]} args
 * @param {boolean} [quiet] Return stdout without printing it.
 * @returns {{ passed: boolean, stdout: string }}
 */
function check(label, script, args, quiet = false) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (!quiet) {
    process.stdout.write(stdout);
  }
  const exit = result.error === undefined ? String(result.status) : result.error.message;
  console.log(`${label}: exit ${exit}${result.signal === null ? "" : ` (${result.signal})`}`);
  return { passed: result.status === 0, stdout };
}

/**
 * @param {string} file
 * @returns {boolean}
 */
const ownedSource = (file) =>
  file !== "" &&
  !isAbsolute(file) &&
  !file.startsWith("..") &&
  !file.split(sep).includes("node_modules");

/**
 * Lints `files` with every rule off, so Oxlint reports each directive it would honor as unused.
 * The strict scope has no recorded quality exception that could authorize a directive.
 * @param {readonly string[]} files
 * @returns {boolean}
 */
function directivesAbsent(files) {
  const directory = mkdtempSync(join(tmpdir(), "strict-quality-"));
  const config = join(directory, "directives.json");
  try {
    writeFileSync(
      config,
      JSON.stringify({
        categories: Object.fromEntries(categories.map((category) => [category, "off"])),
        options: { reportUnusedDisableDirectives: "error", respectEslintDisableDirectives: true },
      }),
    );
    return check("directives", oxlint, ["-c", config, ...lintSelection, ...files]).passed;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Checks formatting and confirms that Oxfmt selected every file: an ignore file excludes
 * explicitly listed paths without failing.
 * @param {readonly string[]} files
 * @returns {boolean}
 */
function formatted(files) {
  const result = check("format", tool("oxfmt"), [
    "--check",
    "-c",
    ".oxfmtrc.json",
    "--disable-nested-config",
    ...files,
  ]);
  const selected = /\bon (\d+) files?\b/.exec(result.stdout)?.[1];
  if (selected === String(files.length)) {
    return result.passed;
  }
  console.log(`format: checked ${selected ?? "no"} of ${files.length} selected files`);
  return false;
}

/**
 * The JSON blocks of one section of the adopted standard.
 * @param {string} text
 * @param {string} heading
 * @returns {unknown[]}
 */
function standardBlocks(text, heading) {
  const [, rest = ""] = text.split(`\n${heading}\n`);
  const next = rest.search(/^#{1,6} /m);
  /** @type {unknown[]} */
  const blocks = [];
  for (const [, block = ""] of rest
    .slice(0, next === -1 ? undefined : next)
    .matchAll(/^```json\n([\s\S]*?)^```$/gm)) {
    blocks.push(JSON.parse(block));
  }
  assert.ok(blocks.length > 0, `${standard} lacks the configuration of ${heading}`);
  return blocks;
}

/**
 * Differences between the effective policy and the adopted standard.
 * @param {Record<string, unknown>} options Effective compiler options
 * @param {readonly string[]} owned
 * @returns {string[]}
 */
function policyViolations(options, owned) {
  const text = readFileSync(join(root, standard), "utf8");
  /** @type {string[]} */
  const violations = [];
  const [oxlintBaseline] = standardBlocks(text, "## Appendix A: Base Oxlint configuration");
  if (!isDeepStrictEqual(readJson(join(root, ".oxlintrc.json")), oxlintBaseline)) {
    violations.push(`.oxlintrc.json differs from Appendix A of ${standard}`);
  }
  const [oxfmtBaseline] = standardBlocks(text, "### 7.1 Formatter ownership");
  if (!isDeepStrictEqual(readJson(join(root, ".oxfmtrc.json")), oxfmtBaseline)) {
    violations.push(`.oxfmtrc.json differs from Section 7.1 of ${standard}`);
  }
  for (const block of standardBlocks(text, "### 4.2 Compiler settings")) {
    const message = `Invalid Section 4.2 configuration in ${standard}`;
    const required = readRecord(readRecord(block, message).compilerOptions, message);
    for (const [name, value] of Object.entries(required)) {
      if (options[name] !== value) {
        violations.push(`tsconfig.json must set ${name} to ${JSON.stringify(value)}`);
      }
    }
  }
  for (const name of strictFamily.filter((option) => options[option] === false)) {
    violations.push(`tsconfig.json must not disable ${name}`);
  }
  for (const file of entrypoints.filter((entrypoint) => !owned.includes(entrypoint))) {
    violations.push(`${file} is outside the compiler program`);
  }
  return violations;
}

const compiler = check("compiler", tsc, ["-p", "tsconfig.json"]);
// The compiler's resolved program defines the strict scope, so every imported owned module is
// linted and formatted without a second hand-maintained file list.
const membership = check(
  "compiler membership",
  tsc,
  ["-p", "tsconfig.json", "--listFilesOnly"],
  true,
);
const owned = (membership.passed ? membership.stdout : "")
  .split(/\r?\n/)
  .filter((line) => line !== "")
  .map((file) => relative(root, realpathSync.native(file)))
  .filter(ownedSource);
console.log(`strict scope: ${owned.join(" ")}`);
const shown = check("compiler config", tsc, ["-p", "tsconfig.json", "--showConfig"], true);
const effective = shown.passed ? readRecord(JSON.parse(shown.stdout), configMessage) : {};
// Semantic lint receives compiler types only for root files of the project, not for files that
// the program reaches through imports.
const roots = new Set(
  readArray(effective.files ?? [], configMessage).map((file) =>
    typeof file === "string" ? relative(root, resolve(root, file)) : "",
  ),
);
const unrooted = owned.filter((file) => !roots.has(file));
if (unrooted.length > 0) {
  console.log(`tsconfig.json must list the strict scope in files: ${unrooted.join(" ")}`);
}
const lint =
  owned.length > 0 &&
  check("lint", oxlint, ["-c", ".oxlintrc.json", ...lintSelection, ...owned]).passed;
const directives = owned.length > 0 && directivesAbsent(owned);
const format = owned.length > 0 && formatted([...owned, ...records]);
if (owned.length === 0) {
  console.log("lint, directives, format: blocked (no compiler-resolved owned source)");
}
const violations = policyViolations(
  readRecord(effective.compilerOptions ?? {}, configMessage),
  owned,
);
for (const violation of violations) {
  console.log(`policy: ${violation}`);
}
console.log(`policy: ${violations.length === 0 ? "ok" : `${violations.length} violation(s)`}`);
const passed = [
  compiler.passed,
  membership.passed,
  shown.passed,
  unrooted.length === 0,
  lint,
  directives,
  format,
  violations.length === 0,
];
if (passed.includes(false)) {
  process.exitCode = 1;
}
