// A browser `process`, injected ahead of every module in the bundle. The package
// reads its LLM key and base URL from process.env (OPENAI_API_KEY and
// OPENAI_BASE_URL), and LangChain.js reads the same variables, so the runtime sets
// them here from the user's BYOK settings before a session runs. The other fields
// are the ones pythonlib and LangChain read while loading (pythonlib's sys module
// reads execPath, for one); they describe "no Node here" rather than faking one.
if (typeof globalThis.process === "undefined") {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const start = now();
  const hrtime = (previous) => {
    const ms = now() - start;
    const time = [Math.floor(ms / 1000), Math.floor((ms % 1000) * 1e6)];
    return previous ? [time[0] - previous[0], time[1] - previous[1]] : time;
  };
  hrtime.bigint = () => BigInt(Math.floor((now() - start) * 1e6));
  globalThis.process = {
    env: {},
    argv: [],
    execPath: "",
    version: "",
    versions: {},
    platform: "browser",
    arch: "",
    pid: 0,
    browser: true,
    cwd: () => "/",
    exit: () => {},
    on: () => {},
    off: () => {},
    emitWarning: (warning) => console.warn(warning),
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    hrtime,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    uptime: () => (now() - start) / 1000,
  };
}
