// vite.config.mjs: builds nsdeploy's adapters over @cognizant-ai-lab/neuro-san-ts-package
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

// WORKAROUND / PORT BACK: the package doesn't export BaseToolFactory, which builds
// every tool an agent can call, and neuro-san-session.mjs wraps what it builds. So
// this adds the export to the package's module as it is bundled (the package on
// disk is never edited). A package without the class exports null instead, and the
// session then leaves its tools as they are. Port back: export it from the package.
const exposeBaseToolFactory = {
  name: "expose-base-tool-factory",
  transform(code, id) {
    if (!/neuro-san-ts-package[\\/]dist[\\/]neuro-san\.mjs$/.test(id)) return null;
    const found = /^class BaseToolFactory \{/m.test(code);
    return `${code}\nexport ${found ? "{ BaseToolFactory as NsdeployBaseToolFactory }" : "const NsdeployBaseToolFactory = null"};\n`;
  },
};

export default defineConfig({
  root,
  publicDir: false,
  logLevel: "info",
  plugins: [exposeBaseToolFactory, minifyPackage],
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
