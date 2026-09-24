// stream stand-in. Only the MCP SDK's stdio transport uses it, and a browser MCP
// client only speaks HTTP.
export class PassThrough {
  constructor() {
    throw new Error("stdio streams are not available in the browser");
  }
}
export default { PassThrough };
