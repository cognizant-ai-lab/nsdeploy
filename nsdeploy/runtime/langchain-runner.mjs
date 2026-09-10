// langchain-runner.mjs — the AgentRunner intrinsic built on LangChain.js ONLY.
//
// neuro-san-web owns the agent graph and the loop; LangChain.js provides just the
// model + tool-binding interface (ChatOpenAI.bindTools) and message types. There is
// no LangGraph here — the multi-agent orchestration (peer agents, fetch-and-run
// remote networks, sandboxed coded tools, MCP) is neuro-san-web's job, driven by the
// shared buildToolTable()/dispatchToolCall() helpers. Bundled for the browser by
// build/bundle-runner.mjs.

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || "?"; }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p.text || "")).join("");
  return "";
}

export async function runAgentLangChain(ctx, agentName, userText, parentSpan, chain, helpers) {
  const { trace, network } = ctx;
  const spec = network.getAgentSpec(agentName);
  if (!spec) throw new Error(`agent '${agentName}' not found`);

  const origin = ctx.displayOrigin;
  const isTopFrontMan = ctx.isTop && agentName === ctx.frontMan;
  const agentSpan = trace.start("agent", {
    parent: parentSpan, origin, agent: agentName, network: network.name,
    displayAs: spec.class ? "coded_tool" : "llm_agent", runner: "langchain",
  });

  try {
    const { toolByName, toolSchemas } = await helpers.buildToolTable(ctx, spec, chain, agentSpan);

    // LangChain tool specs (schema only — we execute tool calls ourselves below).
    const lcTools = toolSchemas.map((s) =>
      tool(async () => "", { name: s.function.name, description: s.function.description, schema: s.function.parameters }),
    );

    const sysParts = [];
    if (spec.instructions) sysParts.push(spec.instructions.trim());
    if (spec.command) sysParts.push(spec.command.trim());
    const prompt = sysParts.join("\n\n") || "You are a helpful agent.";

    const model = ctx.modelOverride || spec.llm_config?.model_name || network.config.llm_config?.model_name || ctx.defaultModel;
    // A real (non-mock) router with no API key: refuse rather than forward the
    // placeholder "demo" to a live provider (which returns a confusing 401, e.g.
    // when a shared/reloaded URL keeps the proxy router but the per-tab key is gone).
    if (!ctx.mock && (!ctx.apiKey || ctx.apiKey === "demo")) {
      throw new Error(`The selected LLM router (${hostOf(ctx.routerBaseUrl) || "a real provider"}) needs your API key. Open ⚙ BYOK settings and enter it — or switch the router back to the mock to run without a key.`);
    }
    const keySource = ctx.apiKey ? "local BYOK (not shown)" : "none";

    const llm = new ChatOpenAI({
      model,
      apiKey: ctx.apiKey || "none",
      streaming: true,
      temperature: 0,
      configuration: { baseURL: ctx.routerBaseUrl, dangerouslyAllowBrowser: true },
    });
    const chat = lcTools.length ? llm.bindTools(lcTools) : llm;

    const messages = [new SystemMessage(prompt)];
    if (isTopFrontMan && ctx.history?.length) {
      for (const m of ctx.history) {
        messages.push(m.role === "assistant" ? new AIMessage(m.content) : new HumanMessage(m.content));
      }
    }
    messages.push(new HumanMessage(userText));
    const maxSteps = spec.max_steps || network.config.max_steps || 12;

    let finalText = "";
    for (let step = 0; step < maxSteps; step++) {
      const span = trace.start("model_call", {
        parent: agentSpan, origin, model, mock: ctx.mock,
        routerHost: hostOf(ctx.routerBaseUrl), keySource, runner: "langchain",
      });
      let ai = null;
      try {
        const stream = await chat.stream(messages);
        for await (const chunk of stream) {
          ai = ai ? ai.concat(chunk) : chunk;
          const piece = textOf(chunk.content);
          if (piece) { if (isTopFrontMan) ctx.onAnswerDelta?.(piece); trace.update(span, { streamChunk: piece }); }
        }
        const respModel = ai?.response_metadata?.model_name || ai?.response_metadata?.model || ai?.lc_kwargs?.response_metadata?.model_name;
        const respMock = ctx.mock || /neuro-san-mock/.test(respModel || "");
        trace.end(span, { usage: ai?.usage_metadata, toolCalls: (ai?.tool_calls || []).map((t) => t.name), mock: respMock, respModel });
      } catch (err) {
        trace.fail(span, err);
        throw err;
      }

      messages.push(ai);
      const toolCalls = ai?.tool_calls || [];
      if (toolCalls.length === 0) {
        finalText = textOf(ai?.content);
        break;
      }
      for (const tc of toolCalls) {
        const entry = toolByName.get(tc.name);
        const result = entry
          ? await helpers.dispatchToolCall(ctx, entry, tc.args || {}, agentSpan, chain)
          : `Error: unknown tool '${tc.name}'`;
        const content = typeof result === "string" ? result : JSON.stringify(result);
        messages.push(new ToolMessage({ content, tool_call_id: tc.id, name: tc.name }));
        trace.note("tool_result", { parent: agentSpan, origin, tool: tc.name, preview: content.slice(0, 200) });
      }
    }

    // Contribute any agent-generated widgets up the chain (consolidated by the UI).
    if (helpers.extractWidgets) finalText = helpers.extractWidgets(finalText, ctx, agentName);

    trace.end(agentSpan, { answerChars: finalText.length });
    return finalText;
  } catch (err) {
    trace.fail(agentSpan, err);
    throw err;
  }
}

export default runAgentLangChain;
