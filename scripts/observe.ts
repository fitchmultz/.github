import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("compatibility-probe-internal", {
    description: "Record compatibility fixture provenance and shut down the fixture",
    handler: async (_args, ctx) => {
      const packageDir = getPackageDir();
      const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      writeFileSync(process.env.PI_COMPAT_OBSERVATION!, JSON.stringify({
        packageDir,
        version: VERSION,
        indexSha256: hash(join(packageDir, "dist/index.js")),
        cliSha256: hash(join(packageDir, manifest.bin.pi)),
        tools: pi.getAllTools().map(({ name, sourceInfo }) => ({ name, sourceInfo })),
        activeTools: pi.getActiveTools(),
        commands: pi.getCommands(),
        providers: [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider))].sort(),
      }, null, 2));
      ctx.shutdown();
    },
  });
}
