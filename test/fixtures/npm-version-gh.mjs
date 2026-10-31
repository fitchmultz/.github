#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "setup-git") process.exit(0);
if (args[0] === "pr" && args[1] === "create") {
  const state = JSON.parse(readFileSync(process.env.FAKE_GITHUB_STATE, "utf8"));
  const number = state.nextPull++;
  state.open.push({ number, branch: args[args.indexOf("--head") + 1], body: args[args.indexOf("--body") + 1] });
  writeFileSync(process.env.FAKE_GITHUB_STATE, JSON.stringify(state));
  console.log(`https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${number}`);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "merge") {
  appendFileSync(process.env.FAKE_GITHUB_LOG, `merge ${args.join(" ")}\n`);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "checks") process.exit(0);
throw new Error(`Unexpected gh arguments: ${args.join(" ")}`);
