// A global Buffer, injected ahead of every module in the bundle. The package's io
// stub (BytesIO, used to read its llm info) and some dependencies use Node's Buffer
// as a global; this is the standard browser implementation of it.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
