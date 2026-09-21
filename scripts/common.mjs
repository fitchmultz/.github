import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export const codingAgent = "@earendil-works/pi-coding-agent";
export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function run(command, args, { quiet = false, ...options } = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32" && command === "npm",
    ...options,
  });
  if (!quiet || result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status} (${result.signal ?? "no signal"})`);
  return result.stdout;
}

export function isolatedEnvironment(root) {
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const env = {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    USER: "pi-compatibility", LOGNAME: "pi-compatibility", USERNAME: "pi-compatibility",
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    TERM: "xterm-256color", CI: "true", GIT_TERMINAL_PROMPT: "0",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_cache: process.env.npm_config_cache ?? join(root, "npm-cache"),
    npm_config_audit: "false", npm_config_fund: "false",
    npm_config_userconfig: join(root, "user.npmrc"),
    npm_config_globalconfig: join(root, "global.npmrc"),
  };
  // Leave agentDir HOME-derived: several tests deliberately substitute HOME.
  writeFileSync(env.npm_config_userconfig, "");
  writeFileSync(env.npm_config_globalconfig, "");
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

export function stageSource(source, target) {
  run("git", ["clone", "--no-hardlinks", "--quiet", source, target]);
  const paths = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: source, quiet: true });
  for (const file of paths.split("\0").filter(Boolean)) {
    const destination = resolve(target, file);
    if (!existsSync(join(source, file))) {
      rmSync(destination, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(source, file), destination, { recursive: true });
  }
}
