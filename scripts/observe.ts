import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, getPackageDir, SettingsManager, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("compatibility-probe-internal", {
    description: "Record compatibility fixture provenance and shut down the fixture",
    handler: async (_args, ctx) => {
      // RPC has no theme UI. Load package themes after the CLI installs its native validator.
      const resources = new DefaultResourceLoader({
        cwd: process.cwd(), agentDir: join(process.cwd(), "theme-profile"),
        settingsManager: SettingsManager.inMemory({ packages: [process.env.PI_COMPAT_PACKAGE_DIR!] }),
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      });
      await resources.reload();
      const { themes, diagnostics } = resources.getThemes();
      assert.deepEqual(diagnostics, [], `Packaged theme acceptance failed: ${JSON.stringify(diagnostics)}`);
      const packageDir = getPackageDir();
      const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const model = ctx.model;
      writeFileSync(process.env.PI_COMPAT_OBSERVATION!, JSON.stringify({
        packageDir,
        version: VERSION,
        indexSha256: hash(join(packageDir, "dist/index.js")),
        cliSha256: hash(join(packageDir, manifest.bin.pi)),
        tools: pi.getAllTools().map(({ name, sourceInfo }) => ({ name, sourceInfo })),
        activeTools: pi.getActiveTools(),
        commands: pi.getCommands(),
        providers: [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider))].sort(),
        selectedModel: model ? { provider: model.provider, id: model.id } : null,
        availableModels: ctx.modelRegistry.getAvailable().map(({ provider, id }) => ({ provider, id })),
        selectedModelConfiguredAuth: model ? ctx.modelRegistry.hasConfiguredAuth(model) : null,
        modelRegistryErrorPresent: ctx.modelRegistry.getError() !== undefined,
        themes: themes.map(({ name, sourcePath }) => ({ name, sourcePath })),
      }, null, 2));
      ctx.shutdown();
    },
  });
}
