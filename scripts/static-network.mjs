import { parseHocon } from "../nsdeploy/runtime/hocon.js";
import { AgentNetwork, validateNetwork } from "../nsdeploy/runtime/kernel.js";

/** Compile self-contained HOCON into the browser runtime's static data contract. */
export class StaticNetwork {
  /** Validate the supported HOCON subset and return public network data and metadata. */
  static compile(text, name, mock = false) {
    // Reject unsupported syntax before the tolerant browser parser can misinterpret it.
    const syntax = text.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g, " ");
    if (/\binclude\b|\$\{|\+=|[\w-]+\.[\w-]+\s*[:={]/.test(syntax)) {
      throw new Error("Use self-contained HOCON (no includes, substitutions, dotted keys or +=), or --bundle DIR.");
    }
    const config = parseHocon(text);
    if (!Array.isArray(config.tools) || !config.tools.length) {
      throw new Error("The HOCON must contain a nonempty tools array.");
    }
    const omitted = [];
    const agents = [];
    // Python/toolbox definitions cannot execute on a static host.
    for (const entry of config.tools) {
      if (entry.class || entry.toolbox) {
        omitted.push(entry.name);
      } else if (typeof entry.instructions === "string") {
        agents.push(entry);
      } else {
        throw new Error(`Unsupported tool definition: ${entry.name || JSON.stringify(entry)}. Use --bundle DIR.`);
      }
    }
    config.tools = agents;
    config.llm_config = { model_name: "gpt-4o-mini", ...(config.llm_config || {}) };
    config.cruse = { version: 1 };
    config.link_slots = config.link_slots || {};
    const names = new Set(agents.map(StaticNetwork.name));
    // Preserve external URLs and expose unresolved network references to the runtime's link UI.
    for (const agent of agents) {
      const references = [];
      // Remove omitted Python tools from callers without fabricating replacement capabilities.
      for (const reference of agent.tools || []) {
        if (typeof reference !== "string") {
          throw new Error(`Unsupported tool reference in ${agent.name}; use --bundle DIR.`);
        }
        if (omitted.includes(reference)) {
          continue;
        }
        const target = config.links?.[reference] || reference;
        references.push(target);
        if (!names.has(target) && !/^https?:\/\//.test(target)) {
          config.link_slots[target] = { callers: [agent.name] };
        }
      }
      agent.tools = references;
      agent.instructions += "\n\n" + StaticNetwork.PRESENTATION;
    }
    config.deployment = { mode: "static", omitted_python_tools: omitted,
      external_mcp_transport: "direct-cors", link_persistence: "browser-local" };
    const network = new AgentNetwork(config, name);
    const validation = validateNetwork(network);
    if (validation.errors.length) {
      throw new Error(`Invalid network: ${validation.errors.join("; ")}`);
    }
    const router = "https://api.openai.com/v1";
    const manifest = {
      brand: name.replaceAll("_", " "),
      networks: [{ name, front_man: network.findFrontMan(), hocon: `./${name}.network.json`,
        description: config.metadata?.description || name }],
      llm_router: { base_url: mock ? "browser://mock" : router, byok_router: router, mock },
      deployment: { mode: "static", self_contained_runtime: true, browser_mock: mock,
        direct_byok: true, direct_mcp_requires_cors: true, public_mcp_facade: false },
      peer_policy: { mode: "open", deny_origins: [] },
      agent_mcp: { available: false, reason: "Static bundle: no inbound MCP server." },
    };
    return { config, manifest, omitted, warnings: validation.warnings };
  }

  /** Return an agent's public name for reference validation. */
  static name(agent) {
    return agent.name;
  }

  static PRESENTATION = `GENERATIVE UI (CRUSE): Answer naturally in chat. When useful, add one
fenced cruse-ui JSON block: {"version":1,"components":[...]}. Components may include
{"kind":"report","id":"summary","title":"Summary","markdown":"..."},
{"kind":"table","id":"options","title":"Options","columns":["Name"],"rows":[["Example"]]},
or {"kind":"form","id":"details","title":"Details","schema":{"type":"object",
"properties":{"request":{"type":"string","title":"Request"}},"required":["request"]}}.
Only request missing information. Plain chat can answer or amend forms. Consolidate child
presentations into one response. Never invent facts or claim website actions are connected.
Follow the runtime's supplied action catalog and require its confirmation flow for actions.`;
}
