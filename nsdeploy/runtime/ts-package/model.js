export { normalizeModelName } from "../model.js";

// Whether a model response came from nsdeploy's mock router: the site declared a mock
// router, the router labelled the route mock (X-Nsdeploy-LLM-Route), or the response
// names the mock model.
export function isMockResponse(configuredMock, routeKind, model) {
  return !!configuredMock || routeKind === "mock" || /neuro-san-mock/.test(model || "");
}

// The mock LLM a static bundle runs on, with no server behind it (llm_router base_url
// "browser://mock"). Same decision as the launcher's mock router: call the first tool
// not called yet with the user's request, then summarize what the tools returned.
export const BROWSER_MOCK_ROUTER = "browser://mock";
// The most text the mock puts in a search tool's query, as the launcher's mock.
const MOCK_QUERY_LIMIT = 200;

export function browserMockCompletion(messages = [], tools = []) {
  const called = new Set(messages.filter((m) => m?.role === "tool" && m.name).map((m) => m.name));
  const available = (tools || []).map((tool) => tool?.function).filter((fn) => fn?.name);
  const next = available.find((fn) => !called.has(fn.name));
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const request = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content || "");
  if (next) {
    const args = {};
    const schema = next.parameters || {};
    for (const name of schema.required || []) args[name] = request;
    for (const name of ["request", "inquiry", "search_terms", "query", "input"]) {
      if (schema.properties?.[name] || (schema.required || []).includes(name)) args[name] ??= request;
    }
    // A short search phrase, as the launcher's mock sends.
    for (const name of ["search_terms", "query"]) {
      if (typeof args[name] === "string") args[name] = args[name].slice(0, MOCK_QUERY_LIMIT);
    }
    return {
      content: "",
      toolCalls: [{
        id: `call_${next.name}`,
        type: "function",
        function: { name: next.name, arguments: JSON.stringify(args) },
      }],
      finishReason: "tool_calls",
      usage: null,
      model: "neuro-san-mock-browser",
    };
  }
  const results = messages.filter((m) => m?.role === "tool").map((m) => String(m.content || ""));
  const content = results.length
    ? `(mock summary) Based on the tools I consulted: ${results.join(" ").slice(0, 1200)}`
    : "(mock) I have no grounded tool output to summarize for this request.";
  return { content, toolCalls: [], finishReason: "stop", usage: null, model: "neuro-san-mock-browser" };
}

// A Responses API request's input and tools, in the chat-completions shape
// browserMockCompletion reads, as the launcher's _responses_to_chat does.
const responsesToChat = (body) => {
  const text = (content) => typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => String(part?.text ?? "")).join("") : "";
  const items = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : body.input || [];
  const namesByCall = {};
  const messages = [];
  for (const item of items) {
    const kind = item.type || "message";
    if (kind === "message") messages.push({ role: item.role, content: text(item.content) });
    else if (kind === "function_call") namesByCall[item.call_id] = item.name;
    else if (kind === "function_call_output") messages.push({ role: "tool", name: namesByCall[item.call_id] || "", content: item.output ?? "" });
  }
  const tools = (body.tools || []).filter((t) => t.type === "function").map((t) => ({ function: { name: t.name, parameters: t.parameters || {} } }));
  return { messages, tools };
};

// The mock's answer to one OpenAI request from neuro-san's loop, as the HTTP response
// the launcher's mock router would send: chat completions or the Responses API,
// streamed or not.
export function browserMockResponse(url, body = {}) {
  const responsesApi = /\/responses$/.test(new URL(url).pathname);
  const { messages, tools } = responsesApi ? responsesToChat(body) : { messages: body.messages || [], tools: body.tools || [] };
  const result = browserMockCompletion(messages, tools);
  const call = result.toolCalls[0];
  const id = crypto.randomUUID().replace(/-/g, "");
  const headers = { "X-Nsdeploy-LLM-Route": "mock" };
  const json = (payload) => new Response(JSON.stringify(payload), { headers: { ...headers, "Content-Type": "application/json" } });
  const sse = (events) => new Response(events.join(""), { headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8" } });
  const words = result.content.split(" ");
  if (!responsesApi) {
    if (!body.stream) {
      return json({
        id: `chatcmpl-${id}`, object: "chat.completion", model: result.model,
        choices: [{ index: 0, finish_reason: result.finishReason,
          message: { role: "assistant", content: call ? null : result.content, ...(call ? { tool_calls: [call] } : {}) } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: `chatcmpl-${id}`, model: result.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    // The first delta carries the role, as OpenAI's stream does.
    const deltas = call
      ? [chunk({ role: "assistant", tool_calls: [{ index: 0, ...call }] })]
      : words.map((word, i) => chunk(i ? { content: ` ${word}` } : { role: "assistant", content: word }));
    return sse([...deltas, chunk({}, result.finishReason), "data: [DONE]\n\n"]);
  }
  const item = call
    ? { type: "function_call", id: `fc_${id}`, status: "completed", call_id: call.id, name: call.function.name, arguments: call.function.arguments }
    : { type: "message", id: `msg_${id}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: result.content, annotations: [] }] };
  const response = {
    id: `resp_${id}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed",
    model: result.model, output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  if (!body.stream) return json(response);
  let sequence = 0;
  const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
  const at = { item_id: item.id, output_index: 0 };
  const part = { type: "output_text", text: "", annotations: [] };
  return sse([
    event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
    ...(call ? [
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", arguments: "" } }),
      event("response.function_call_arguments.delta", { ...at, delta: item.arguments }),
      event("response.function_call_arguments.done", { ...at, arguments: item.arguments }),
    ] : [
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
      event("response.content_part.added", { ...at, content_index: 0, part }),
      ...words.map((word, i) => event("response.output_text.delta", { ...at, content_index: 0, delta: i ? ` ${word}` : word })),
      event("response.output_text.done", { ...at, content_index: 0, text: result.content }),
      event("response.content_part.done", { ...at, content_index: 0, part: { ...part, text: result.content } }),
    ]),
    event("response.output_item.done", { output_index: 0, item }),
    event("response.completed", { response }),
  ]);
}
