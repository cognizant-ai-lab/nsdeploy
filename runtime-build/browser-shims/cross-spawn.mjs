// cross-spawn stand-in. The MCP SDK's stdio transport spawns a local server
// process; a browser MCP client only speaks HTTP, so spawning always fails.
export default function spawn() {
  throw new Error("spawning processes is not available in the browser");
}
