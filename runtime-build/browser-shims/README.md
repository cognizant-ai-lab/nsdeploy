# browser-shims

Browser stand-ins for the Node builtins and the one Python bridge that
@cognizant-ai-lab/neuro-san-npm reaches. vite.config.mjs swaps them in when it
builds the package for the browser. They stand in for platform services, never
for neuro-san's own logic.

| Module | Why the package reaches it | Stand-in |
|---|---|---|
| `fs` | reads its packaged data files (llm info, toolbox info) | `fs.mjs`: those files embedded at build time |
| `path`, `url` | locates `dist/data` from `import.meta.url` | `path.mjs`, `url.mjs`: POSIX path handling |
| `stubs/pyhocon.js` | parses HOCON by spawning Python | `pyhocon.mjs`: `runtime/hocon.js` |
| `async_hooks` | @langchain/core keeps run context in AsyncLocalStorage | `async_hooks.mjs`: synchronous store |
| `module`, `stream` | coded-tool require(), MCP stdio transport | `module.mjs`, `stream.mjs`: throw if ever used |
| `child_process` | pythonlib's subprocess module | `child_process.mjs`: throws if ever used |
| `cross-spawn` | the MCP SDK's stdio transport | `cross-spawn.mjs`: throws if ever used |
| global `process`, `Buffer` | env vars for the LLM key and base URL; the io stub's BytesIO | `process.mjs`, `buffer.mjs`, injected into every module that names them |
| everything else Node-only | pythonlib modules the loop never calls | `empty.mjs` |
