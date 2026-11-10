/**
 * The HOCON connect prompt.
 *
 * These tests pin the exact text on purpose. Four wordings have been tried against a
 * real generator and three failed, and every one of them read perfectly well on the
 * page while producing HOCON that deployed and connected nothing. If an assertion here
 * fails, the question is whether the new wording was tested against a real upload —
 * not whether the test is too fussy.
 *
 * The record, which is what the current shape is assembled from:
 *   1. "add a new agent whose only tool is this web address" -> the address went into
 *      the prose of `description`/`instructions`, no `tools` key at all.
 *   2. the same, plus `"tools": ["<address>"] and nowhere else`, a placeholder ban and
 *      a count self-check -> placement correct, but at NINE peers only four addresses
 *      arrived and one was an invented `https://example.com/`.
 *   3. an operator's terse wording with no field names -> worked at three peers, then
 *      put the addresses back in prose at two.
 *
 * So placement and coverage fail independently. "Find the right place in the agent
 * network" fixed coverage (prescribing a wrapper agent per peer is what broke it); the
 * named `"tools"` field is the only thing that has ever made placement reliable. The
 * current prompt keeps both, which is why the tests below assert the field name is
 * present AND that the coverage-breaking scaffolding is absent.
 *
 * Coverage above a handful of peers is NOT solved — nine at once failed under the most
 * explicit prompt of the four. Link two or three at a time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectPromptFor, oneLiner, peerReference }
  from '../nsdeploy_service/ui/assets/js/components/linkPromptModal.js';

const HOST = 'https://agentic-city.test';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mk = (name, port, description) => ({
  id: name, name, url: `${HOST}:${port}`, network: { description },
});

/** The three peers from the upload that actually linked. */
const hotdog = mk('hot_dog_shop_ops', 8103, 'Sharper shifts. Faster fixes. Better dogs.');
const tyre = mk('tyre_company_ops', 8102, 'Every request routed. Every journey moving.');
const icecream = mk('ice_cream_shop_multi_agent_ops', 8100, 'Sharper shifts. Happier scoops.');
const bare = mk('mystery_network', 8104, '');

const source = { id: 'src', name: 'courier_logistics_ops_network',
                 network: { front_man: 'logistics_orchestrator' } };

const entriesFor = (...deps) => deps.map((dep) => ({ dep, slot: dep.name }));
const promptFor = (...deps) => connectPromptFor(entriesFor(...deps), source);

test('no peers yields no prompt', () => {
  assert.equal(connectPromptFor([], source), '');
});

/** The opening line, pinned once so the shape tests cannot drift apart. */
const OPENING = 'Find the right place in the agent network and connect the following '
  + 'agents as tools. Put each address in that agent\'s "tools" list — '
  + '"tools": ["<address>"] — not in its description or instructions:';

test('reproduces the expected wording exactly, for all three peers', () => {
  assert.equal(promptFor(hotdog, tyre, icecream), [
    OPENING,
    '- For hot_dog_shop_ops, described as “Sharper shifts. Faster fixes. Better dogs”, use:',
    `${HOST}:8103/hot_dog_shop_ops`,
    '- For tyre_company_ops, described as “Every request routed. Every journey moving”, use:',
    `${HOST}:8102/tyre_company_ops`,
    '- For ice_cream_shop_multi_agent_ops, described as “Sharper shifts. Happier scoops”, use:',
    `${HOST}:8100/ice_cream_shop_multi_agent_ops`,
  ].join('\n'));
});

test('the generator still chooses which agent owns the tool', () => {
  // "Find the right place" is what fixed coverage. Prescribing a wrapper agent per
  // peer is what broke it — nine peers produced nine empty shells. The placement rule
  // added alongside it says where the address goes, not which agent must hold it.
  const p = promptFor(hotdog);
  assert.match(p, /^Find the right place in the agent network/m);
  assert.doesNotMatch(p, /add a new agent/i);
});

test('the address is demanded IN the tools list, with prose ruled out', () => {
  // Twice now a generator has written the address into `description`/`instructions`
  // and left the agent with no `tools` key — the network deploys, the agents are
  // reachable from the front-man, and nothing connects. Naming the field is the only
  // thing that has ever made placement reliable, so it is load-bearing: plain English
  // loses here. See connectPromptFor's header for the full record.
  const p = promptFor(hotdog, tyre);
  assert.match(p, /"tools": \["<address>"\]/);
  assert.match(p, /not in its description or instructions/);
});

test('the scaffolding that caused the coverage failure stays out', () => {
  // These all come from the nine-peer attempt, where placement was right and five of
  // nine addresses simply never arrived. They did not help and they cost length.
  const p = promptFor(hotdog, tyre);
  for (const ghost of [
    /add a new agent/i,         // prescribing a wrapper agent per peer broke coverage
    /example\.com/,             // the placeholder ban
    /Before returning/,         // the completeness self-check
    /main agent/,               // naming the front-man
    /Return the complete HOCON/,
    /courier_logistics_ops_network/,  // the source network is never named
  ]) {
    assert.doesNotMatch(p, ghost, `${ghost} reappeared`);
  }
});

test('the URL sits alone on its own line, directly under its agent', () => {
  const lines = promptFor(hotdog, tyre).split('\n');
  for (let i = 1; i < lines.length; i += 2) {
    assert.match(lines[i], /^- For /, `line ${i + 1} should introduce an agent`);
    assert.equal(lines[i + 1], lines[i + 1].trim(), 'the URL line carries no indent');
    assert.match(lines[i + 1], /^https?:\/\/\S+$/, 'the URL line holds only the URL');
  }
});

test('one peer uses the same shape as many — there is no separate single form', () => {
  assert.equal(promptFor(hotdog), [
    OPENING,
    '- For hot_dog_shop_ops, described as “Sharper shifts. Faster fixes. Better dogs”, use:',
    `${HOST}:8103/hot_dog_shop_ops`,
  ].join('\n'));
});

test('every selected peer appears, one bullet and one URL each', () => {
  for (const n of [1, 2, 5, 12]) {
    const deps = Array.from({ length: n }, (_, i) => mk(`peer_${i}`, 8100 + i, `Does job ${i}.`));
    const p = promptFor(...deps);
    assert.equal(p.split('\n').length, 1 + 2 * n, `${n} peers`);
    for (let i = 0; i < n; i += 1) {
      assert.ok(p.includes(`- For peer_${i}, described as “Does job ${i}”, use:`), `peer_${i} bullet missing`);
      assert.ok(p.includes(`${HOST}:${8100 + i}/peer_${i}`), `peer_${i} URL missing`);
    }
  }
});

test('peers keep the order they were ticked in', () => {
  const p = promptFor(tyre, hotdog);
  assert.ok(p.indexOf('- For tyre_company_ops') < p.indexOf('- For hot_dog_shop_ops'));
});

test('the peer URL keeps its network-name path', () => {
  // A bare origin is the "No published network named '<host>:<port>'" error.
  assert.match(promptFor(hotdog), /:8103\/hot_dog_shop_ops$/m);
  assert.equal(peerReference(hotdog), `${HOST}:8103/hot_dog_shop_ops`);
});

/* ── which description ───────────────────────────────────────────────────── */

test('the front-man\'s own purpose wins over the brand tagline', () => {
  // The review this answers: "connection prompt generation is still picking up tag
  // lines instead of agent descriptions. This can confuse the agent network designer
  // as to what the down-chain agent does."
  const dep = {
    id: 'careers', name: 'cognizant_careers_candidate_assistant', url: `${HOST}:8109`,
    network: {
      description: 'Your next role, clearly mapped.',
      front_man_description: 'Top-level orchestrator for the Cognizant careers '
        + 'helper. Clarifies the goal, gathers minimal context, and routes to the '
        + 'right specialist for job search, application materials, status tracking, '
        + 'interview prep, or accommodations.',
    },
  };
  const p = promptFor(dep);
  assert.match(p, /Top-level orchestrator for the Cognizant careers helper/);
  assert.doesNotMatch(p, /Your next role, clearly mapped/);
});

test('the routing detail survives — it is the part a designer needs', () => {
  // At the old 160-char cap oneLiner stopped after the first sentence, which names the
  // network and says nothing about what it can be asked. That reintroduced the exact
  // problem the review raised, so the cap had to clear a real paragraph.
  const dep = {
    id: 'c', name: 'careers', url: `${HOST}:8109`,
    network: {
      description: 'tagline',
      front_man_description: 'Top-level orchestrator for the Cognizant careers '
        + 'helper. Clarifies the candidate goal, gathers minimal context, and routes '
        + 'to the right specialist for job search, job details and fit, application '
        + 'materials, Taleo login help, status tracking, interview prep, or '
        + 'accommodations and compliance.',
    },
  };
  const p = promptFor(dep);
  assert.match(p, /routes to the right specialist/);
  assert.match(p, /accommodations and compliance/);     // the tail, not just sentence 1
});

test('a record with no front-man description falls back to the tagline', () => {
  // `front_man_description` is written at build time, so a network deployed before the
  // field existed has none until _repair_summaries() backfills it at startup. A
  // tagline beats an empty bullet in the meantime.
  const dep = {
    id: 'old', name: 'legacy_network', url: `${HOST}:8104`,
    network: { description: 'Every request routed. Every journey moving.' },
  };
  assert.match(promptFor(dep), /- For legacy_network, described as “Every request routed\. Every journey moving”, use:/);
});

test('the URL still sits alone on its own line under a long description', () => {
  // The whole point of the bullet shape: however long the description runs, the
  // address stays on its own line where it can be copied verbatim.
  const dep = {
    id: 'c', name: 'careers', url: `${HOST}:8109`,
    network: { description: 't', front_man_description: 'x'.repeat(300) },
  };
  const lines = promptFor(dep).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^- For careers, described as “/);
  assert.equal(lines[2], `${HOST}:8109/careers`);
});

test('only the final full stop is dropped, not the internal ones', () => {
  // "Sharper shifts. Faster fixes. Better dogs." is punctuated throughout; losing the
  // inner stops would read as corruption, and keeping the last one breaks ", use:".
  assert.match(promptFor(hotdog), /described as “Sharper shifts\. Faster fixes\. Better dogs”, use:/);
  assert.doesNotMatch(promptFor(hotdog), /Better dogs\.”/);
});

test('a peer with no description still gets a usable bullet', () => {
  const p = promptFor(bare);
  assert.match(p, /^- For mystery_network, use:$/m);   // no double space, no stray comma
  assert.doesNotMatch(p, /mystery_network {2}/);
  assert.match(p, new RegExp(`^${escapeRegExp(HOST)}:8104/mystery_network$`, 'm'));
});

test('oneLiner flattens and cuts without stranding a half word', () => {
  assert.equal(oneLiner('  a\n  b  '), 'a b');
  assert.equal(oneLiner('', 10), '');
  assert.equal(oneLiner(null), '');
  const cut = oneLiner('x'.repeat(30) + ' ' + 'y'.repeat(200), 60);
  assert.ok(cut.endsWith('…'));
  assert.ok(cut.length <= 61, `got ${cut.length}`);
});
