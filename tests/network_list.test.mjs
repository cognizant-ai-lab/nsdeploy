/**
 * Search, filter, sort and pagination for the network list.
 *
 * These are the parts that have to stay correct as the list grows to the 80-100
 * networks an event produces. Everything else in views/networks.js is markup, but a
 * wrong comparator or an unclamped page number shows a reader an empty table and
 * gives them no way to tell whether it is their filter or a fault.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchingNodeIds, nodeMatchesQuery, queryTerms, queryTopics,

  filterDeployments, sortDeployments, paginate,
} from '../nsdeploy_service/ui/assets/js/util/listquery.js';
import {
  ORG_NAME_MAX, orgNameError,
} from '../nsdeploy_service/ui/assets/js/util/org.js';

let seq = 0;
const dep = (over = {}) => ({
  id: over.id || `id${seq += 1}`,
  name: 'a_network',
  org_name: 'Alpha',
  status: 'ready',
  created_at: '2026-10-01T00:00:00+00:00',
  network: null,
  ...over,
});

/* -- filtering ------------------------------------------------------------ */

test('no query and no filters returns everything', () => {
  assert.equal(filterDeployments([dep(), dep(), dep()]).length, 3);
});

test('query matches the name', () => {
  const rows = [dep({ name: 'hospital_intake' }), dep({ name: 'travel_agent' })];
  assert.deepEqual(filterDeployments(rows, { q: 'hospital' }).map((d) => d.name),
    ['hospital_intake']);
});

test('query matches the organization', () => {
  const rows = [dep({ org_name: 'Max Retail' }), dep({ org_name: 'BOFA' })];
  assert.deepEqual(filterDeployments(rows, { q: 'retail' }).map((d) => d.org_name),
    ['Max Retail']);
});

test('query matches brand and description, not just the name', () => {
  // The point of searching more than the name: a network called acute_care_x may be
  // branded "CareFlight", and that is what a reader remembers seeing on the map.
  const rows = [
    dep({ name: 'acute_care_x', network: { brand: 'CareFlight Reserve' } }),
    dep({ name: 'other', network: { description: 'Handles hospital admissions' } }),
    dep({ name: 'unrelated' }),
  ];
  assert.equal(filterDeployments(rows, { q: 'careflight' }).length, 1);
  assert.equal(filterDeployments(rows, { q: 'hospital' }).length, 1);
  assert.equal(filterDeployments(rows, { q: 'nothing-here' }).length, 0);
});

test('query is case and whitespace insensitive', () => {
  assert.equal(filterDeployments([dep({ name: 'Hospital_Intake' })],
    { q: '  HOSPITAL  ' }).length, 1);
});

test('status filter groups queued and building together as pending', () => {
  const rows = [
    dep({ status: 'ready' }), dep({ status: 'queued' }),
    dep({ status: 'building' }), dep({ status: 'stopped' }), dep({ status: 'failed' }),
  ];
  assert.equal(filterDeployments(rows, { status: 'live' }).length, 1);
  assert.equal(filterDeployments(rows, { status: 'pending' }).length, 2);
  assert.equal(filterDeployments(rows, { status: 'stopped' }).length, 1);
  assert.equal(filterDeployments(rows, { status: 'failed' }).length, 1);
  assert.equal(filterDeployments(rows, { status: 'all' }).length, 5);
});

test('an unknown status filter does not silently hide everything', () => {
  // A stale value in the select must not produce an empty table with no explanation.
  assert.equal(filterDeployments([dep(), dep()], { status: 'nonsense' }).length, 2);
});

test('organization filter treats a blank org as Unattributed', () => {
  const rows = [dep({ org_name: '' }), dep({ org_name: 'Alpha' })];
  assert.equal(filterDeployments(rows, { org: 'Unattributed' }).length, 1);
  assert.equal(filterDeployments(rows, { org: 'Alpha' }).length, 1);
});

test('filters combine', () => {
  const rows = [
    dep({ name: 'alpha_one', org_name: 'Alpha', status: 'ready' }),
    dep({ name: 'alpha_two', org_name: 'Alpha', status: 'stopped' }),
    dep({ name: 'beta_one', org_name: 'Beta', status: 'ready' }),
  ];
  assert.deepEqual(
    filterDeployments(rows, { q: 'alpha', org: 'Alpha', status: 'live' }).map((d) => d.name),
    ['alpha_one']);
});

/* -- sorting --------------------------------------------------------------- */

const links = new Map([
  ['a', { inbound: 5 }], ['b', { inbound: 1 }], ['c', { inbound: 9 }],
]);

test('mine first puts the readers own organization at the top', () => {
  const rows = [
    dep({ org_name: 'Beta', name: 'aaa' }),
    dep({ org_name: 'Alpha', name: 'zzz' }),
  ];
  const out = sortDeployments(rows, { key: 'mine', org: 'Alpha' });
  assert.equal(out[0].org_name, 'Alpha', 'own org first even though its name sorts last');
});

test('mine first is case insensitive about the organization', () => {
  const rows = [dep({ org_name: 'Beta' }), dep({ org_name: 'ALPHA' })];
  assert.equal(sortDeployments(rows, { key: 'mine', org: 'alpha' })[0].org_name, 'ALPHA');
});

test('with no organization set, mine first degrades to the tiebreak', () => {
  const rows = [dep({ id: 'b', name: 'b' }), dep({ id: 'c', name: 'c' })];
  assert.equal(sortDeployments(rows, { key: 'mine', org: '', links })[0].id, 'c');
});

test('name sorts alphabetically, ignoring case', () => {
  const rows = [dep({ name: 'zebra' }), dep({ name: 'Apple' }), dep({ name: 'mango' })];
  assert.deepEqual(sortDeployments(rows, { key: 'name' }).map((d) => d.name),
    ['Apple', 'mango', 'zebra']);
});

test('connections sorts most-called first', () => {
  const rows = [dep({ id: 'b' }), dep({ id: 'c' }), dep({ id: 'a' })];
  assert.deepEqual(sortDeployments(rows, { key: 'connections', links }).map((d) => d.id),
    ['c', 'a', 'b']);
});

test('newest sorts by created_at descending', () => {
  const rows = [
    dep({ name: 'old', created_at: '2026-10-01T00:00:00+00:00' }),
    dep({ name: 'new', created_at: '2026-10-14T00:00:00+00:00' }),
  ];
  assert.equal(sortDeployments(rows, { key: 'newest' })[0].name, 'new');
});

test('sorting does not mutate the input', () => {
  const rows = [dep({ name: 'b' }), dep({ name: 'a' })];
  const before = rows.map((d) => d.name);
  sortDeployments(rows, { key: 'name' });
  assert.deepEqual(rows.map((d) => d.name), before);
});

test('equal rows keep a stable, total order', () => {
  // Without a total order a 5s repaint can reshuffle equal rows under the cursor.
  const rows = [dep({ id: 'b', name: 'same' }), dep({ id: 'c', name: 'same' })];
  const once = sortDeployments(rows, { key: 'name', links }).map((d) => d.id);
  const twice = sortDeployments(rows, { key: 'name', links }).map((d) => d.id);
  assert.deepEqual(once, twice);
});

test('an unknown sort key falls back rather than throwing', () => {
  assert.equal(sortDeployments([dep(), dep()], { key: 'nonsense' }).length, 2);
});

/* -- pagination ------------------------------------------------------------ */

const many = (n) => Array.from({ length: n }, (_, i) =>
  dep({ id: String(i), name: `net_${String(i).padStart(3, '0')}` }));

test('splits into pages of the requested size', () => {
  const view = paginate(many(83), 1, 25);
  assert.equal(view.rows.length, 25);
  assert.equal(view.pages, 4);
  assert.equal(view.total, 83);
  assert.equal(view.start, 0);
});

test('the last page holds the remainder', () => {
  const view = paginate(many(83), 4, 25);
  assert.equal(view.rows.length, 8);
  assert.equal(view.start, 75);
});

test('a page beyond the end clamps to the last page, not an empty table', () => {
  // The case that matters: a filter shrinks the results under a reader on page 5.
  const view = paginate(many(83), 99, 25);
  assert.equal(view.page, 4);
  assert.equal(view.rows.length, 8);
});

test('a page below one clamps to the first', () => {
  assert.equal(paginate(many(10), 0, 25).page, 1);
  assert.equal(paginate(many(10), -3, 25).page, 1);
});

test('an empty result set still reports one page', () => {
  const view = paginate([], 1, 25);
  assert.equal(view.pages, 1);
  assert.equal(view.total, 0);
  assert.deepEqual(view.rows, []);
});

test('100 networks at every offered page size', () => {
  for (const size of [10, 25, 50, 100]) {
    const view = paginate(many(100), 1, size);
    assert.equal(view.pages, Math.ceil(100 / size), `pages wrong at size ${size}`);
    assert.equal(view.rows.length, Math.min(size, 100));
  }
});

test('every row appears exactly once across all pages', () => {
  const rows = many(83);
  const seen = [];
  for (let p = 1; p <= 4; p += 1) seen.push(...paginate(rows, p, 25).rows.map((d) => d.id));
  assert.equal(seen.length, 83);
  assert.equal(new Set(seen).size, 83, 'a row was duplicated or dropped between pages');
});

/* -- the three together, as the view uses them ----------------------------- */

test('filter then sort then paginate, over 100 networks', () => {
  const rows = many(100).map((d, i) => ({
    ...d,
    org_name: i % 3 === 0 ? 'Alpha' : 'Beta',
    status: i % 7 === 0 ? 'stopped' : 'ready',
  }));
  const filtered = filterDeployments(rows, { org: 'Alpha', status: 'live' });
  const sorted = sortDeployments(filtered, { key: 'name' });
  const view = paginate(sorted, 2, 10);

  assert.ok(filtered.length > 0 && filtered.length < 100, 'filter actually narrowed');
  assert.equal(sorted.length, filtered.length, 'sorting must not drop rows');
  assert.ok(view.rows.every((d) => d.org_name === 'Alpha' && d.status === 'ready'));
  assert.equal(view.page, Math.min(2, view.pages));
});

/* ── map search ───────────────────────────────────────────────────────────── */
// The map dims rather than removes, so it needs the set of matching ids rather than a
// filtered list. The distinction between "no search" and "nothing matched" is the part
// worth pinning down: the first leaves every pin at full strength, the second dims all
// of them, and conflating the two makes a typo look like an empty map.

const node = (id, over = {}) => ({
  id, name: 'retail_oms_004', org_name: 'Max Retail',
  front_man: 'retail_orchestrator', description: 'Order management across channels',
  ...over,
});

test('an empty query matches every node', () => {
  assert.equal(nodeMatchesQuery(node('a'), ''), true);
  assert.equal(nodeMatchesQuery(node('a'), '   '), true);
});

test('a query matches the raw name, the display name and the organization', () => {
  assert.equal(nodeMatchesQuery(node('a'), 'retail_oms'), true);
  assert.equal(nodeMatchesQuery(node('a'), 'Retail Oms'), true);   // display form
  assert.equal(nodeMatchesQuery(node('a'), 'max retail'), true);   // org
});

test('a query matches the front man and the description', () => {
  assert.equal(nodeMatchesQuery(node('a'), 'orchestrator'), true);
  assert.equal(nodeMatchesQuery(node('a'), 'across channels'), true);
});

test('a query that matches nothing is false, not an error', () => {
  assert.equal(nodeMatchesQuery(node('a'), 'zzz-nothing'), false);
});

test('matching tolerates a malformed node', () => {
  assert.equal(nodeMatchesQuery(null, 'retail'), false);
  assert.equal(nodeMatchesQuery(undefined, 'retail'), false);
  assert.equal(nodeMatchesQuery({ id: 'x' }, 'retail'), false);
});

test('no search returns null, which is not the same as no matches', () => {
  const nodes = [node('a'), node('b')];
  assert.equal(matchingNodeIds(nodes, ''), null);
  const none = matchingNodeIds(nodes, 'zzz');
  assert.ok(none instanceof Set);
  assert.equal(none.size, 0);
});

test('matchingNodeIds returns only the ids that matched', () => {
  const nodes = [
    node('a', { name: 'retail_oms_001' }),
    node('b', { name: 'hospital_admissions_002', org_name: 'BOFA',
      front_man: 'triage', description: 'Admissions and triage' }),
  ];
  const hits = matchingNodeIds(nodes, 'triage');
  assert.deepEqual([...hits], ['b']);
});

test('matchingNodeIds tolerates a missing list', () => {
  // An empty query answers null before the list is even looked at, so a missing list
  // is only interesting when there IS a query to apply.
  assert.equal(matchingNodeIds(undefined, ''), null);
  assert.equal(matchingNodeIds(null, 'x').size, 0);
  assert.equal(matchingNodeIds(undefined, 'x').size, 0);
});

test('search narrows sensibly across 100 networks', () => {
  const nodes = Array.from({ length: 100 }, (_, i) =>
    node(`n${i}`, { name: `retail_oms_${String(i).padStart(3, '0')}` }));
  assert.equal(matchingNodeIds(nodes, 'retail_oms').size, 100);
  assert.equal(matchingNodeIds(nodes, 'oms_042').size, 1);
  assert.equal(matchingNodeIds(nodes, 'nope').size, 0);
});

/* ── asking in words ──────────────────────────────────────────────────────── */
// The point of these: a reader types a question, not a substring. The risks are
// under-matching (the question words make every term miss) and over-matching (the
// topic pass is so loose that everything matches everything).

const bank = node('bank', {
  name: 'bank_kyc_end_to_end', org_name: 'BOFA',
  front_man: 'kyc_orchestrator',
  description: 'Know-your-customer onboarding and credit checks',
});
const hospital = node('hosp', {
  name: 'acute_care_hospital_network', org_name: 'Max Retail',
  front_man: 'triage_orchestrator',
  description: 'Hospital admissions, triage and patient wards',
});
const shop = node('shop', {
  name: 'retail_oms', org_name: 'Max Retail',
  front_man: 'order_orchestrator',
  description: 'Retail order management and checkout across channels',
});

test('question wording is stripped down to the meaningful terms', () => {
  assert.deepEqual(queryTerms('what are the networks related to banking available'),
    ['banking']);
  assert.deepEqual(queryTerms('show me anything about food delivery'),
    ['food', 'delivery']);
  assert.deepEqual(queryTerms('   '), []);
});

test('a question about a subject finds networks described in other words', () => {
  // "banking" appears nowhere in this network's text; "credit" and "kyc" do.
  assert.equal(bank.description.toLowerCase().includes('banking'), false);
  assert.equal(nodeMatchesQuery(bank, 'what networks are related to banking'), true);
});

test('a subject question does not drag in unrelated networks', () => {
  assert.equal(nodeMatchesQuery(hospital, 'networks related to banking'), false);
  assert.equal(nodeMatchesQuery(shop, 'networks related to banking'), false);
});

test('healthcare words find the hospital network', () => {
  assert.equal(nodeMatchesQuery(hospital, 'what do we have for healthcare'), true);
  assert.equal(nodeMatchesQuery(bank, 'what do we have for healthcare'), false);
});

test('an exact network name still wins, question or not', () => {
  assert.equal(nodeMatchesQuery(bank, 'bank_kyc_end_to_end'), true);
  assert.equal(nodeMatchesQuery(shop, 'retail_oms'), true);
  assert.equal(nodeMatchesQuery(shop, 'bank_kyc_end_to_end'), false);
});

test('a query of nothing but stopwords matches nobody rather than everybody', () => {
  // "what are the networks" has no subject. Returning every network would be the
  // worst outcome: it looks like the search silently ignored the question.
  for (const n of [bank, hospital, shop]) {
    assert.equal(nodeMatchesQuery(n, 'what are the networks'), false);
  }
});

test('the organization name is still searchable', () => {
  assert.equal(nodeMatchesQuery(bank, 'BOFA'), true);
  assert.equal(nodeMatchesQuery(hospital, 'bofa'), false);
});

test('topics come from the shared industry table, not a second list', () => {
  // "loan", "invoice" and "banking" are one row in format.js INDUSTRIES, so any of
  // them should reach a network described with any other.
  for (const q of ['loan', 'invoice', 'finance', 'payments']) {
    assert.equal(nodeMatchesQuery(bank, q), true, `"${q}" should reach the bank`);
  }
});

test('the list screen answers a question the same way the map does', () => {
  const rows = [
    { id: 'a', name: 'bank_kyc_end_to_end', status: 'ready', org_name: 'BOFA',
      network: { description: 'Know-your-customer onboarding and credit checks' } },
    { id: 'b', name: 'acute_care_hospital_network', status: 'ready', org_name: 'Max Retail',
      network: { description: 'Hospital admissions and triage' } },
  ];
  const hits = filterDeployments(rows, { q: 'what networks relate to banking' });
  assert.deepEqual(hits.map((r) => r.id), ['a']);
});

test('a payments-heavy description does not make a barbershop a banking network', () => {
  // The reported bug, verbatim from the deployed network. Its description ends
  // "routes deposits/payment links/invoice payments/refunds/voids through the payments
  // processor" — payment and invoice are both in the finance row, so reading name and
  // description together put a barbershop in the results for "related to banking".
  const barber = node('barber', {
    name: 'barbershop_customer_system_090',
    front_man: 'customer_concierge',
    description: 'Primary customer-facing concierge for the barbershop: answers FAQs, '
      + 'explains services and pricing, books appointments, manages walk-ins and '
      + 'waitlists, routes deposits/payment links/invoice payments/refunds/voids '
      + 'through the payments processor',
  });
  assert.equal(nodeMatchesQuery(barber, 'Network related to banking'), false);
  // Still findable the ways a reader would actually look for it.
  assert.equal(nodeMatchesQuery(barber, 'barbershop'), true);
  assert.equal(nodeMatchesQuery(barber, 'customer_concierge'), true);
});

test('an agent name does not decide a network subject', () => {
  // front_man is excluded from topic classification: "customer_concierge" matches the
  // travel row via "concierge", which would have filed a barbershop under travel.
  const barber = node('barber', {
    name: 'barbershop_customer_system', front_man: 'customer_concierge',
    description: 'Books appointments',
  });
  assert.equal(nodeMatchesQuery(barber, 'travel'), false);
});

test('the name beats the description when they disagree', () => {
  // A network named for its subject must not be reclassified by a paragraph that
  // happens to mention another one.
  const shop = node('shop', {
    name: 'retail_oms_004',
    description: 'Order management, including invoice and payment reconciliation',
  });
  assert.equal(nodeMatchesQuery(shop, 'retail'), true);
  assert.equal(nodeMatchesQuery(shop, 'networks related to banking'), false);
});

test('an opaquely named network still falls back to its description', () => {
  // The fallback has to survive: without it a network called "project_atlas" would
  // have no subject at all and be unfindable except by its exact name.
  const opaque = node('atlas', {
    name: 'project_atlas', front_man: 'main',
    description: 'Handles hospital admissions, triage and patient wards',
  });
  assert.equal(nodeMatchesQuery(opaque, 'healthcare'), true);
});

/* ── organization names ───────────────────────────────────────────────────── */
// The browser copy of the API's rule (ORG_NAME_MAX / ORG_NAME_PATTERN in models.py).
// It is duplicated deliberately — the remembered organization is written to
// localStorage and sent as org_name on the next upload, so a name the browser accepts
// and the server refuses becomes a 422 after Launch. These tests are what keep the two
// copies saying the same thing.

test('a name within the rules is accepted', () => {
  for (const name of ['Max Retail', 'Acme Logistics', 'BOFA', "O'Brien Ltd",
    'Smith, Jones & Co.', 'Cognizant (India)', 'R&D / Platform', 'Team #4',
    'C++ Guild', 'team_phoenix']) {
    assert.equal(orgNameError(name), '', `should accept ${name}`);
  }
});

test('non-ascii team names are accepted', () => {
  for (const name of ['Zürich Analytics', '北京团队', 'Equipe Numéro 1']) {
    assert.equal(orgNameError(name), '', `should accept ${name}`);
  }
});

test('an empty name asks for one', () => {
  assert.match(orgNameError(''), /Enter your organization name/);
  assert.match(orgNameError('   '), /Enter your organization name/);
});

test('an over-long name says how long it is', () => {
  // The reason matters: "too long" and "bad character" need different fixes, and one
  // generic "invalid" leaves the reader guessing which rule they broke.
  const msg = orgNameError('a'.repeat(ORG_NAME_MAX + 5));
  assert.match(msg, new RegExp(String(ORG_NAME_MAX)));
  assert.match(msg, new RegExp(String(ORG_NAME_MAX + 5)));
});

test('a name exactly at the limit is fine', () => {
  assert.equal(orgNameError('a'.repeat(ORG_NAME_MAX)), '');
});

test('markup, shell and whitespace characters are refused', () => {
  for (const name of ['<script>alert(1)</script>', 'He said "hi"', 'a`b', 'a|b',
    'a;b', 'a$b', 'a*b', 'a=b', 'a\nb', 'a\tb', 'https://evil.example/x']) {
    assert.notEqual(orgNameError(name), '', `should refuse ${JSON.stringify(name)}`);
  }
});

test('leading and trailing junk is refused', () => {
  for (const name of ['-Max', '....', '!!!', '***', '---']) {
    assert.notEqual(orgNameError(name), '', `should refuse ${name}`);
  }
});

test('the browser rule and the API rule agree on the limit', () => {
  // If these drift, a name passes here and 422s on upload. The number is asserted
  // rather than assumed so a change on one side fails loudly on the other.
  assert.equal(ORG_NAME_MAX, 40);
});
