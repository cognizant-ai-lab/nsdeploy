import { environ, AgentNetwork, MasterLlmFactory, MasterToolboxFactory, StorageClass, ExpiringAgentNetworkStorage, SessionInvocationContext, AsyncioExecutorPool, DirectAgentReservationist, DirectAgentSession, LangChainMcpAdapter, BaseToolFactory, ExternalAgentSessionFactory, ChatMessageType, AsyncDirectAgentSession } from "../neuro-san/neuro-san.mjs";
import { parseExternalAgent } from "./external-agent-parsing.mjs";
const hooks = {
  // async ({ url }) => boolean. Runs before anything is sent to an MCP server
  // (initialize, tools/list), so declining means the server is never contacted and
  // the agent carries on without its tools.
  mcpConsent: null,
  // async ({ url, tool, args, caller, callId }) => string | null. Runs before each MCP
  // tool call. A string is returned to the agent as the tool's output instead of making
  // the call (e.g. the user declined); null lets the call go ahead. `caller` is the
  // agent making the call, as for toolCall, or null when that isn't known, and
  // `callId` is the same for this call's mcpResult.
  mcpCall: null,
  // ({ url, tool, result, error, callId }) => void. After an MCP tool call returns or fails.
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
  // ({ url, message }) => void. Each message a partner network's agents stream, so
  // the runtime can show the partner's own agents in the trace.
  peerMessage: null,
  // ({ url, text }) => string. A partner network's final answer before it goes back
  // to its caller, so the runtime can take the ```cruse-ui``` widgets out of it and
  // show them, as it does for the top network's answer. Returns the text to pass on.
  peerAnswer: null,
  // (agentUrl) => function spec | null. What to advertise for a partner before it is
  // contacted, e.g. the contract nsdeploy published for the leaf it replaced.
  peerFunction: null,
  // async ({ caller: { agent, network, origin }, tool, ref, run }) => result. Runs each
  // tool call an agent makes, so the runtime decides how many of its sibling calls run
  // at once and knows which agent made each one. `origin` is the calling agent's
  // origin path, `ref` the name or URL its network lists the tool by, and `run` makes
  // the call.
  toolCall: null
};
function setHooks(values) {
  Object.assign(hooks, values);
}
function setEnv(values) {
  Object.assign(environ, values);
}
function createSession(config, name) {
  const network = new AgentNetwork(config, name);
  const llmFactory = MasterLlmFactory.create_llm_factory(config);
  llmFactory.load();
  const toolboxFactory = MasterToolboxFactory.create_toolbox_factory(config);
  toolboxFactory.load();
  const storage = { [StorageClass.TEMP]: new ExpiringAgentNetworkStorage() };
  const context = new SessionInvocationContext(
    name,
    new PeerSessionFactory(),
    new AsyncioExecutorPool(),
    llmFactory,
    toolboxFactory,
    null,
    new DirectAgentReservationist(/* @__PURE__ */ new Set([storage[StorageClass.TEMP]]))
  );
  context.start();
  return new DirectAgentSession(network, context, null, null, null);
}
const getMcpTools = LangChainMcpAdapter.prototype.get_mcp_tools;
let mcpCalls = 0;
LangChainMcpAdapter.prototype.get_mcp_tools = async function(serverUrl, allowedTools = null, headers = null) {
  if (hooks.mcpConsent && !await hooks.mcpConsent({ kind: "mcp", url: serverUrl })) {
    this.client_allowed_tools = allowedTools;
    return [];
  }
  const mcpTools = await getMcpTools.call(this, serverUrl, allowedTools, headers);
  for (const tool of mcpTools) {
    if (typeof tool.func !== "function") continue;
    const call = tool.func;
    tool.func = async (args, ...rest) => {
      const caller = typeof tool.nsdeployCaller === "function" ? tool.nsdeployCaller() : null;
      const callId = ++mcpCalls;
      const instead = hooks.mcpCall ? await hooks.mcpCall({ url: serverUrl, tool: tool.name, args, caller, callId }) : null;
      if (instead != null) return instead;
      try {
        const result = await call(args, ...rest);
        hooks.mcpResult?.({ url: serverUrl, tool: tool.name, result, callId });
        return result;
      } catch (error) {
        hooks.mcpResult?.({ url: serverUrl, tool: tool.name, error, callId });
        throw error;
      }
    };
  }
  return mcpTools;
};
if (BaseToolFactory) {
  const createBaseTool = BaseToolFactory.prototype.create_base_tool;
  BaseToolFactory.prototype.create_base_tool = async function(name) {
    const created = await createBaseTool.call(this, name);
    const toolCaller = this.tool_caller;
    const callerOf = () => {
      const origin = typeof toolCaller.get_origin === "function" ? toolCaller.get_origin() : null;
      return {
        agent: toolCaller.get_name(),
        network: toolCaller.get_inspector().get_network_name(),
        origin: Array.isArray(origin) ? origin.map((o) => ({ tool: o.tool, instantiation_index: o.instantiation_index })) : []
      };
    };
    const ref = typeof name === "string" ? name : name?.url;
    for (const tool of Array.isArray(created) ? created : created ? [created] : []) {
      tool.nsdeployCaller = callerOf;
      const invoke = tool.invoke.bind(tool);
      tool.invoke = (input, config) => hooks.toolCall ? hooks.toolCall({ caller: callerOf(), tool: tool.name, ref, run: () => invoke(input, config) }) : invoke(input, config);
    }
    return created;
  };
}
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
  // parameter on the calling side (ExternalAgentToolCreator.ensure_external_parameters).
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
      yield { response: { type: ChatMessageType.AGENT_FRAMEWORK, text: resolved.answer, origin: [] } };
      return;
    }
    const network = new AgentNetwork(resolved.config, resolved.name);
    const context = await this.invocationContext.safe_shallow_copy(this.invocation);
    context.nsdeploy_peer_chain = [...chain, this.agentUrl];
    const metadata = this.invocationContext.get_metadata ? this.invocationContext.get_metadata() : null;
    const session = new AsyncDirectAgentSession(network, context, metadata, null, null);
    const callerSeesAll = String(request?.chat_filter?.chat_filter_type ?? "").toUpperCase() === "MAXIMAL";
    const traced = { ...request, chat_filter: { chat_filter_type: "MAXIMAL" } };
    let error = null;
    try {
      for await (const chatResponse of session.streaming_chat(traced)) {
        const message = chatResponse?.response;
        if (message) hooks.peerMessage?.({ url: this.agentUrl, message });
        if (!callerSeesAll && !(message?.type === ChatMessageType.AGENT_FRAMEWORK && message.chat_context != null)) continue;
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
const neuroSanSession = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  createSession,
  setEnv,
  setHooks
}, Symbol.toStringTag, { value: "Module" }));
export {
  neuroSanSession
};
