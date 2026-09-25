// A browser Buffer. The package's io stub (BytesIO, used to read its llm info) and
// some dependencies use Node's Buffer as a global; this is the standard browser
// implementation of it. The build injects it into every module that names Buffer
// (vite.config.mjs), and it is also set on globalThis.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export { Buffer };
