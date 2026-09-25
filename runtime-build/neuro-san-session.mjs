// neuro-san-session.mjs: the package's agent loop (DirectAgentSession) for the browser.
//
// The loop is neuro-san's own, from @cognizant-ai-lab/neuro-san-npm. Where the
// package's transpiled code does not work yet, this module replaces that one method
// from here (the package on disk is never edited) and says what to fix in the
// transpiling source. Each is marked WORKAROUND / PORT BACK.
import {
  AgentNetwork,
  AsyncioExecutorPool,
  StorageClass,
  ExpiringAgentNetworkStorage,
  DirectAgentReservationist,
  MasterToolboxFactory,
  MasterLlmFactory,
  DirectAgentSession,
  ExternalAgentSessionFactory,
  SessionInvocationContext,
  LangChainMcpAdapter,
  McpToolErrorHandler,
  ChatMessageType,
  AsyncDirectAgentSession,
} from "@cognizant-ai-lab/neuro-san-npm";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
// Imported for its side effect too: it makes the package's ExternalAgentParsing work.
import { parseExternalAgent } from "./external-agent-parsing.mjs";

// --- hooks the runtime sets ------------------------------------------------------

const hooks = {
  // async ({ url }) => boolean. Runs before anything is sent to an MCP server
  // (initialize, tools/list), so declining means the server is never contacted and
  // the agent carries on without its tools.
  mcpConsent: null,
  // async ({ url, tool, args }) => string | null. Runs before each MCP tool call. A
  // string is returned to the agent as the tool's output instead of making the call
  // (e.g. the user declined); null lets the call go ahead.
  mcpCall: null,
  // ({ url, tool, result, error }) => void. After an MCP tool call returns or fails.
  mcpResult: null,
  // async (agentUrl, { chain, request }) => { config, name } | { answer }. Turns a
  // partner network's URL into its published network, after the runtime's consent and
  // policy checks. `chain` lists the partner URLs already running above this call, and
  // `request` is the chat request about to be sent (for the consent card). Returning
  // { answer } does not run the partner: that text is the partner's answer (a declined
  // consent, a skipped cycle). Throwing fails the call.
  resolvePeer: null,
  // ({ url, error }) => void. After a partner network's run ends.
  peerDone: null,
  // ({ url, text }) => string. A partner network's final answer before it goes back
  // to its caller, so the runtime can take the ```cruse-ui``` widgets out of it and
  // show them, as it does for the top network's answer. Returns the text to pass on.
  peerAnswer: null,
  // (agentUrl) => function spec | null. What to advertise for a partner before it is
  // contacted, e.g. the contract nsdeploy published for the leaf it replaced.
  peerFunction: null,
};

export function setHooks(values) {
  Object.assign(hooks, values);
}

export function setEnv(values) {
  Object.assign(globalThis.process.env, values);
}

export function createSession(config, name) {
  const network = new AgentNetwork(config, name);
  const llmFactory = MasterLlmFactory.create_llm_factory(config);
  llmFactory.load();
  const toolboxFactory = MasterToolboxFactory.create_toolbox_factory(config);
  toolboxFactory.load();
  const storage = { [StorageClass.TEMP]: new ExpiringAgentNetworkStorage() };
  const context = new SessionInvocationContext(name, new PeerSessionFactory(),
    new AsyncioExecutorPool(), llmFactory, toolboxFactory, null,
    new DirectAgentReservationist(new Set([storage[StorageClass.TEMP]])));
  context.start();
  return new DirectAgentSession(network, context, null, null, null);
}

// --- MCP ---------------------------------------------------------------------------

// LangChainMcpAdapter.get_mcp_tools, line for line as in python, plus the runtime's
// hooks: consent before any contact with the server, and before and after each tool
// call. The package's own method gives no place for those, which is why this
// replaces it rather than wrapping it.
LangChainMcpAdapter.prototype.get_mcp_tools = async function getMcpTools(serverUrl, allowedTools = null, headers = null) {
  if (LangChainMcpAdapter._mcp_servers_info == null) {
    this._load_mcp_servers_info();
  }
  const serversInfo = LangChainMcpAdapter._mcp_servers_info || {};
  const serverInfo = serversInfo[serverUrl] || {};

  if (hooks.mcpConsent && !(await hooks.mcpConsent({ kind: "mcp", url: serverUrl }))) {
    this.client_allowed_tools = allowedTools;
    return [];
  }

  const connection = { url: serverUrl, transport: "http" };
  const headersDict = headers || serverInfo.http_headers;
  if (headersDict) {
    if (typeof headersDict === "object" && !Array.isArray(headersDict)) {
      connection.headers = { ...headersDict };
    } else {
      this.logger.error("MCP client headers for server %s must be a dictionary.", serverUrl);
    }
  }
  const client = new MultiServerMCPClient({
    mcpServers: { server: connection },
    // The Python client names tools exactly as the server does.
    prefixToolNameWithServerName: false,
    additionalToolNamePrefix: "",
  });
  let mcpTools = await client.getTools();

  let clientAllowedTools = allowedTools;
  if (clientAllowedTools == null) {
    clientAllowedTools = serverInfo.tools || [];
  }
  if (clientAllowedTools && clientAllowedTools.length) {
    mcpTools = mcpTools.filter((tool) => clientAllowedTools.includes(tool.name));
  }
  this.client_allowed_tools = clientAllowedTools;

  for (const tool of mcpTools) {
    tool.tags = ["langchain_tool"];
    if (typeof tool.func === "function") {
      const handler = new McpToolErrorHandler(tool);
      handler.original_coroutine = tool.func.bind(tool);
      tool.func = async (args, ...rest) => {
        const instead = hooks.mcpCall ? await hooks.mcpCall({ url: serverUrl, tool: tool.name, args }) : null;
        if (instead != null) return instead;
        try {
          const result = await handler.async_invoke(args, ...rest);
          hooks.mcpResult?.({ url: serverUrl, tool: tool.name, result });
          return result;
        } catch (error) {
          hooks.mcpResult?.({ url: serverUrl, tool: tool.name, error });
          throw error;
        }
      };
    }
  }
  return mcpTools;
};

// --- partner networks --------------------------------------------------------------

// A partner network is another site's published network, fetched and run in this
// browser. neuro-san already runs an external agent this way when it lives on the
// same server (ExternalAgentSessionFactory with use_direct: an
// AsyncDirectAgentSession over its AgentNetwork, in a safe_shallow_copy of the
// caller's invocation context). A browser has to fetch the network first, and only
// after the user consents, while create_session is synchronous. So this factory
// returns a session that advertises the partner without contacting it and resolves
// it on the first chat, then hands off to neuro-san's own AsyncDirectAgentSession.
class PeerSessionFactory extends ExternalAgentSessionFactory {
  constructor() {
    super(false, null);
  }

  create_session(agentUrl, invocationContext = null, invocation = null) {
    return new PeerSession(agentUrl, invocationContext, invocation);
  }
}

class PeerSession {
  constructor(agentUrl, invocationContext, invocation) {
    this.agentUrl = agentUrl;
    this.invocationContext = invocationContext;
    this.invocation = invocation;
    this.session = null;
  }

  // Advertise the partner without contacting it. With no published contract, the
  // description alone is enough: neuro-san then synthesizes a single "inquiry"
  // parameter on the calling side (BaseToolFactory.ensure_external_parameters).
  async function() {
    const published = hooks.peerFunction ? hooks.peerFunction(this.agentUrl) : null;
    const location = parseExternalAgent(this.agentUrl);
    const name = location ? location.agent_name : this.agentUrl;
    return { function: published || { description: `The partner network "${name}" at ${this.agentUrl}.` } };
  }

  async connectivity() {
    return { connectivity_info: [] };
  }


  // The partner URLs running above this session, carried on the invocation context
  // each partner's session gets, so the runtime can refuse a cycle.
  chain() {
    return this.invocationContext?.nsdeploy_peer_chain || [];
  }

  async *streaming_chat(request) {
    if (!hooks.resolvePeer) throw new Error(`No partner resolver is set, so ${this.agentUrl} cannot be run.`);
    const chain = this.chain();
    const resolved = await hooks.resolvePeer(this.agentUrl, { chain, request });
    if (resolved.answer != null) {
      // Shaped like the final message a partner's own session streams back.
      yield { response: { type: ChatMessageType.AGENT_FRAMEWORK, text: resolved.answer, origin: [] } };
      return;
    }
    const network = new AgentNetwork(resolved.config, resolved.name);
    const context = await this.invocationContext.safe_shallow_copy(this.invocation);
    context.nsdeploy_peer_chain = [...chain, this.agentUrl];
    const metadata = this.invocationContext.get_metadata ? this.invocationContext.get_metadata() : null;
    const session = new AsyncDirectAgentSession(network, context, metadata, null, null);
    let error = null;
    try {
      for await (const chatResponse of session.streaming_chat(request)) {
        const message = chatResponse?.response;
        if (hooks.peerAnswer && message?.type === ChatMessageType.AGENT_FRAMEWORK && typeof message.text === "string") {
          message.text = hooks.peerAnswer({ url: this.agentUrl, text: message.text });
        }
        yield chatResponse;
      }
    } catch (err) {
      error = err;
      throw err;
    } finally {
      hooks.peerDone?.({ url: this.agentUrl, error });
    }
  }
}

