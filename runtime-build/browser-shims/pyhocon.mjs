// pyhocon stand-in. The package's stubs/pyhocon.js parses HOCON by spawning Python,
// which a browser cannot do, so this parses with the runtime's own HOCON parser and
// keeps the stub's ConfigFactory / ConfigTree surface.
// On every file the loop reads, and on the demo networks, runtime/hocon.js output
// is identical to real pyhocon's. The one known difference: pyhocon expands tabs
// inside triple-quoted strings to spaces, hocon.js keeps the tabs.
import { parseHocon } from "../../nsdeploy/runtime/hocon.js";
import { readFileSync } from "./fs.mjs";

export class ConfigTree {
  constructor(obj) {
    Object.assign(this, obj || {});
  }
  put(key, value) {
    this[key] = value;
  }
  as_plain_ordered_dict() {
    const out = {};
    for (const [k, v] of Object.entries(this)) {
      if (typeof v === "function") continue;
      out[k] = v && typeof v.as_plain_ordered_dict === "function" ? v.as_plain_ordered_dict() : v;
    }
    return out;
  }
}

function tree(plain) {
  return Object.assign(new ConfigTree(plain), plain);
}

export class ConfigFactory {
  static parse_string(hoconString) {
    return tree(parseHocon(hoconString));
  }
  static parse_String(hoconString) {
    return ConfigFactory.parse_string(hoconString);
  }
  static parse_file(filePath) {
    return tree(parseHocon(readFileSync(String(filePath).trim())));
  }
}

export default { ConfigFactory, ConfigTree };
