import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["nsdeploy/runtime/langchain-runner.mjs"],
  outfile: "nsdeploy/runtime/generated/agent-runner.bundle.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "inline",
  logLevel: "info",
});
