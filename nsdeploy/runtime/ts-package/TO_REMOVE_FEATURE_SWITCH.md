# The runtime on the neuro-san TS package

This folder is the page runtime that runs agents on neuro-san's own loop, from
[`@cognizant-ai-lab/neuro-san-ts-package`](https://github.com/cognizant-ai-lab/neuro-san-ts-package).
The folder above is the original runtime, unchanged from main. Files here import the
parts both runtimes share (`../ui.js`, `../trace.js` and so on) from there.

It is on by default. The launcher redirects `/runtime/index.js` to `ts-package/index.js`,
and a static bundle's copy of `runtime/index.js` re-exports it. `--use-ts-package false`
(`USE_TS_PACKAGE=0` for Cailville) serves the original runtime instead.

## To remove the feature switch

Once the original runtime is no longer needed:

1. Delete the original runtime from `nsdeploy/runtime/`: `kernel.js`, `runner.js`,
   `llm.js`, `mcp.js`, `sandbox.js`, `sandbox-worker.js`, `langchain-runner.mjs`,
   `generated/`, `engine.js` and `index.js`. Its LangChain bundle goes too:
   `scripts/bundle-runner.mjs`, and in the root `package.json` the `build:runner` script
   and the `@langchain/core`, `@langchain/openai` and `esbuild` dev dependencies, then
   update `pnpm-lock.yaml` and the `build:runner` steps in `docs/cruse.md`.
2. Move this folder's files up into `nsdeploy/runtime/` and change their `../` imports to
   `./`. This `model.js` replaces the one there, with `normalizeModelName` moved back into
   it. Delete this file.
3. In `ui.js`, import `ChatMessageType` from `./agent-network.js` and remove the "Drive the
   LLM via LangChain.js" checkbox with the code that reads it (`langchainEl`, the profile's
   `runner` field and the `runner` URL parameter), then remove the line in `index.js` that
   hides it.
4. Remove the feature switch (`--use-ts-package` and `USE_TS_PACKAGE`) and point
   `ts-package/generated` back at `generated`. This lists every place, apart from the hits
   for the package's own name, `neuro-san-ts-package`:

   ```bash
   git grep -n 'ts-package\|ts_package\|TS_PACKAGE' -- ':!*lock*'
   ```

   Only the original runtime has a sandbox worker, so also remove `WORKER_CSP` from
   `launcher.py` and `generate.py`, the `sandbox-worker.js` headers for static hosts and
   `sandboxWorkerUrl` in `generate.py`'s `_STATIC_BOOT`, and the `agent-runner.bundle.js`
   line in `.gitattributes`.
