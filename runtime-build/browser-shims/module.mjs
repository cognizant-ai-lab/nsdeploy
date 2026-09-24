// module stand-in. The package's importlib stub builds a require() for loading
// coded tools from disk, which a browser never does (coded tools are MCP-only here).
export function createRequire() {
  return (id) => {
    throw new Error(`require('${id}') is not available in the browser`);
  };
}
export default { createRequire };
