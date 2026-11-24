import assert from 'node:assert/strict';
import test from 'node:test';

import { Engine } from '../nsdeploy/runtime/engine.js';
import { providerForApiKey } from '../nsdeploy/runtime/ui.js';

// Google AI Studio (Gemini) key cases from ticket #59: the default model against Google's
// "models/..." list, "AQ." keys, thought signatures, and the stream shapes routers use for
// parallel tool calls. A fake Google router streams the replies, so no key is needed.
const MODEL = 'gemini-3.8-flash';
const ROUTER = 'https://google.example/v1beta/openai';

const network = {
  llm_config: { model_name: MODEL },
  tools: [
    { name: 'front', instructions: 'Help.', tools: ['agent_a', 'agent_b'] },
    { name: 'agent_a', function: { description: 'A.' }, instructions: 'Answer A.' },
    { name: 'agent_b', function: { description: 'B.' }, instructions: 'Answer B.' },
  ],
};

function sse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function answer(text) {
  return sse([{ model: MODEL, choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }]);
}

function signature(name) {
  return { google: { thought_signature: `sig-${name}` } };
}

// A Gemini tool call. Google sends extra_content.google.thought_signature with it.
function toolCall(name, index) {
  return {
    ...(index === undefined ? {} : { index }),
    id: `call-${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify({ request: `ask ${name}` }) },
    extra_content: signature(name),
  };
}

// Runs one turn against a fake Google router. Each front agent model call streams the
// next step's tool calls, one per chunk as Gemini does, then answers; sub-agents just answer.
async function runTurn(...steps) {
  const realFetch = globalThis.fetch;
  const frontRequests = [];
  const subAgentRequests = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/chat/completions')) {
      const body = JSON.parse(init.body);
      if (!body.tools?.length) {
        subAgentRequests.push(body);
        return answer('sub-agent answer');
      }
      frontRequests.push(body);
      const calls = steps[frontRequests.length - 1];
      if (!calls) return answer('front answer');
      return sse(calls.map((call, i) => ({
        model: MODEL,
        choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: i === calls.length - 1 ? 'tool_calls' : null }],
      })));
    }
    if (href.endsWith('/agent-manifest.json')) {
      const manifest = { networks: [{ name: 'gemini', hocon: 'gemini.json' }], llm_router: { base_url: ROUTER, byok_router: ROUTER, mock: false } };
      return { ok: true, json: async () => manifest };
    }
    if (href.endsWith('/gemini.json')) return { ok: true, text: async () => JSON.stringify(network) };
    if (href.endsWith('/links.json')) return { ok: false, json: async () => ({}), text: async () => '{}' };
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    const engine = new Engine({ originUrl: 'https://gemini.example', byokKey: 'AIza-fixture' });
    const text = await engine.run('Ask both agents.');
    return { text, frontRequests, subAgentRequests };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('the Google default model is accepted against a models/... list', async () => {
  // The settings panel (ui.js validateConfiguredModel) checks the model with model.js
  // isPublishedModel, so the test calls it directly.
  const { isPublishedModel } = await import('../nsdeploy/runtime/model.js');
  assert.equal(typeof isPublishedModel, 'function', 'model.js has no isPublishedModel check');
  const googleModels = ['models/gemini-3.8-flash', 'models/gemini-2.5-flash'];
  assert.equal(providerForApiKey('AIza-example').model, MODEL);
  assert.equal(isPublishedModel(MODEL, googleModels), true);
  assert.equal(isPublishedModel('models/gemini-3.8-flash', googleModels), true);
  assert.equal(isPublishedModel('gemini-9-unknown', googleModels), false);
});

test('an AQ. key is recognised as a Google AI Studio key', () => {
  // New AI Studio keys start with "AQ."; keys made earlier start with "AIza".
  assert.equal(providerForApiKey('AQ.example')?.name, 'Google AI Studio');
});

test('the next request sends the Gemini thought_signature back', async () => {
  const { frontRequests } = await runTurn([toolCall('agent_a', 0)]);
  const assistant = frontRequests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.deepEqual(assistant.tool_calls[0].extra_content, signature('agent_a'));
});

test('a later step sends the thought_signature of every earlier step back', async () => {
  const { frontRequests } = await runTurn([toolCall('agent_a', 0)], [toolCall('agent_b', 0)]);
  const assistants = frontRequests[2].messages.filter((message) => message.role === 'assistant' && message.tool_calls);
  assert.deepEqual(assistants.map((message) => message.tool_calls[0].extra_content), [signature('agent_a'), signature('agent_b')]);
});

test('2 Gemini calls in one step: the signature goes back on the first call only', async () => {
  // Gemini sends each parallel call with no index and signs only the first one.
  const unsigned = toolCall('agent_b');
  delete unsigned.extra_content;
  const { frontRequests } = await runTurn([toolCall('agent_a'), unsigned]);
  const assistant = frontRequests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.deepEqual(assistant.tool_calls.map((call) => call.extra_content), [signature('agent_a'), undefined]);
});

// Checks that both agents ran and each got its own tool result.
async function assertBothRun(calls) {
  const { text, subAgentRequests, frontRequests } = await runTurn(calls);
  assert.match(text, /front answer/);
  assert.equal(subAgentRequests.length, 2);
  const results = frontRequests[1].messages.filter((message) => message.role === 'tool');
  assert.deepEqual(results.map((message) => message.tool_call_id), ['call-agent_a', 'call-agent_b']);
}

test('2 tool calls in one step with index both run', async () => {
  await assertBothRun([toolCall('agent_a', 0), toolCall('agent_b', 1)]);
});

test('2 tool calls in one step without index both run', async () => {
  await assertBothRun([toolCall('agent_a'), toolCall('agent_b')]);
});

test('2 tool calls in one step with index null both run', async () => {
  await assertBothRun([toolCall('agent_a', null), toolCall('agent_b', null)]);
});

test('2 tool calls in one step from a router that numbers every call 0 both run', async () => {
  await assertBothRun([toolCall('agent_a', 0), toolCall('agent_b', 0)]);
});

test('1 tool call split across chunks runs once with all its arguments', async () => {
  const args = JSON.stringify({ request: 'ask agent_a' });
  const { subAgentRequests, frontRequests } = await runTurn([
    { index: 0, id: 'call-agent_a', type: 'function', function: { name: 'agent_a', arguments: '' } },
    { index: 0, function: { arguments: args.slice(0, 10) } },
    { index: 0, function: { arguments: args.slice(10) } },
  ]);
  assert.equal(subAgentRequests.length, 1);
  const assistant = frontRequests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.deepEqual(assistant.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), [['call-agent_a', 'agent_a', args]]);
});

test('1 tool call with no index, split across chunks, runs once with all its arguments', async () => {
  const args = JSON.stringify({ request: 'ask agent_a' });
  const { subAgentRequests, frontRequests } = await runTurn([
    { id: 'call-agent_a', type: 'function', function: { name: 'agent_a', arguments: args.slice(0, 10) } },
    { function: { arguments: args.slice(10) } },
  ]);
  assert.equal(subAgentRequests.length, 1);
  const assistant = frontRequests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.deepEqual(assistant.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), [['call-agent_a', 'agent_a', args]]);
});

const ARGS_A = JSON.stringify({ request: 'ask agent_a' });
const ARGS_B = JSON.stringify({ request: 'ask agent_b' });

test('1 numbered tool call whose name is split across chunks runs once under its whole name', async () => {
  const { subAgentRequests, frontRequests } = await runTurn([
    { index: 0, id: 'call-agent_a', type: 'function', function: { name: 'agent_', arguments: '' } },
    { index: 0, function: { name: 'a', arguments: ARGS_A } },
  ]);
  assert.equal(subAgentRequests.length, 1);
  const assistant = frontRequests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.deepEqual(assistant.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), [['call-agent_a', 'agent_a', ARGS_A]]);
});

// Runs one step and returns how many agents ran, and each call the next request sends
// back as [id, name, arguments, signature].
async function callsSentBack(pieces) {
  const { subAgentRequests, frontRequests } = await runTurn(pieces);
  const assistant = frontRequests[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
  const calls = assistant.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments, call.extra_content]);
  return { ran: subAgentRequests.length, calls };
}

// 2 Gemini calls with no index, the first split across chunks. id is '' or undefined
// (left out); with no id to go by, the second function name starts the second call.
function callsWithoutIds(id) {
  const withId = id === undefined ? {} : { id };
  return [
    { ...withId, type: 'function', function: { name: 'agent_a', arguments: ARGS_A.slice(0, 10) }, extra_content: signature('agent_a') },
    { function: { arguments: ARGS_A.slice(10) } },
    { ...withId, type: 'function', function: { name: 'agent_b', arguments: ARGS_B }, extra_content: signature('agent_b') },
  ];
}

test('2 calls with empty ids and no index keep their own names, arguments and signatures', async () => {
  const { ran, calls } = await callsSentBack(callsWithoutIds(''));
  assert.equal(ran, 2);
  assert.deepEqual(calls, [['', 'agent_a', ARGS_A, signature('agent_a')], ['', 'agent_b', ARGS_B, signature('agent_b')]]);
});

test('2 calls with no ids and no index keep their own names, arguments and signatures', async () => {
  const { ran, calls } = await callsSentBack(callsWithoutIds(undefined));
  assert.equal(ran, 2);
  assert.deepEqual(calls, [[undefined, 'agent_a', ARGS_A, signature('agent_a')], [undefined, 'agent_b', ARGS_B, signature('agent_b')]]);
});

// Pieces of 2 calls that interleave as ids a, b, a. index is 0 on every piece, or left out.
function interleavedCalls(index) {
  const withIndex = index === undefined ? {} : { index };
  return [
    { ...withIndex, id: 'call-agent_a', type: 'function', function: { name: 'agent_a', arguments: ARGS_A.slice(0, 10) } },
    { ...withIndex, id: 'call-agent_b', type: 'function', function: { name: 'agent_b', arguments: ARGS_B } },
    { ...withIndex, id: 'call-agent_a', function: { arguments: ARGS_A.slice(10) } },
  ];
}

test('pieces of 2 calls that interleave, all with index 0, stay 2 calls', async () => {
  const { ran, calls } = await callsSentBack(interleavedCalls(0));
  assert.equal(ran, 2);
  assert.deepEqual(calls, [['call-agent_a', 'agent_a', ARGS_A, undefined], ['call-agent_b', 'agent_b', ARGS_B, undefined]]);
});

test('pieces of 2 calls that interleave, with no index, stay 2 calls', async () => {
  const { ran, calls } = await callsSentBack(interleavedCalls(undefined));
  assert.equal(ran, 2);
  assert.deepEqual(calls, [['call-agent_a', 'agent_a', ARGS_A, undefined], ['call-agent_b', 'agent_b', ARGS_B, undefined]]);
});
