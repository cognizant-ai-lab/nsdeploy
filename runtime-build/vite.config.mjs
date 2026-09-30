// vite.config.mjs: builds nsdeploy's adapters over @cognizant-ai-lab/neuro-san-npm
// into nsdeploy/runtime/generated/, which is build output and not checked in:
//   browser/     our code from runtime-build/, unminified: browser/neuro-san.mjs (the
//                entry the runtime imports) and the network and session adapters
//   neuro-san/   the package, which is already built for the browser: its own Node
//                stand-ins and third-party code are bundled into it
// Run `npm install && npm run build` here after updating the package. DEBUG=1 leaves
// the package unminified, for tracing a browser error.

import { defineConfig, transformWithEsbuild } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const generated = path.resolve(root, "..", "nsdeploy", "runtime", "generated");
const DEBUG = !!process.env.DEBUG;

function chunkFor(id) {
  if (id.includes(`${path.sep}node_modules${path.sep}`)) return "neuro-san/neuro-san";
  return `browser/${path.basename(id).replace(/\.m?js$/, "")}`;
}

// Minify the package only. Class names are kept: the transpiled code checks types by
// class name.
const minifyPackage = {
  name: "minify-package",
  async renderChunk(code, chunk) {
    if (DEBUG || !chunk.fileName.startsWith("neuro-san/")) return null;
    const result = await transformWithEsbuild(code, chunk.fileName, {
      minify: true, keepNames: true, format: "esm", target: "es2022", legalComments: "none",
    });
    return { code: result.code, map: null };
  },
};

export default defineConfig({
  root,
  publicDir: false,
  logLevel: "info",
  plugins: [minifyPackage],
  build: {
    outDir: generated,
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    sourcemap: DEBUG ? "inline" : false,
    reportCompressedSize: false,
    lib: {
      entry: path.join(root, "neuro-san.mjs"),
      formats: ["es"],
      fileName: () => "browser/neuro-san.mjs",
    },
    rollupOptions: {
      // Our files import the package, never the other way, so these can't cycle.
      output: {
        manualChunks: chunkFor,
        chunkFileNames: "[name].mjs",
        // Real names on the imports between files, so a reader can follow them.
        minifyInternalExports: false,
      },
      // Everything in our files and the package is reached by name at run time.
      treeshake: false,
    },
  },
});
