/**
 * Search, filter, sort and pagination for a list of deployments.
 *
 * Its own module, and deliberately free of any DOM import, for two reasons. It is
 * the only part of the network list that can be *wrong* rather than merely ugly — a
 * bad comparator or an unclamped page shows a reader an empty table with no way to
 * tell a filter from a fault — and views/networks.js reaches the DOM transitively,
 * so logic living there cannot be unit-tested without a browser.
 *
 * `displayName` is the single dependency, and util/format.js is DOM-free too.
 *
 * See tests/network_list.test.mjs.
 */
import { displayName, industryKeys } from './format.js';

/** Page sizes offered in the console. */
export const PAGE_SIZES = [10, 25, 50, 100];

/**
 * Status groupings offered in the filter, mapped to the statuses they cover.
 *
 * `queued` and `building` are one choice: to a reader they are the same condition —
 * "not up yet" — and splitting them asks them to care about an internal step.
 */
export const STATUS_FILTERS = {
  all: null,
  live: new Set(['ready']),
  pending: new Set(['queued', 'building']),
  stopped: new Set(['stopped']),
  failed: new Set(['failed']),
};

/**
 * Rows matching the query and filters.
 *
 * The query is matched against what a person actually remembers about a network —
 * its name, its organization, its brand and its description — rather than the name
 * alone. Someone searching "hospital" should find a network branded "CareFlight"
 * whose description mentions hospitals, which name-only matching would miss.
 *
 * An unrecognised status is treated as "all" rather than matching nothing: a stale
 * value in the select must not silently empty the table.
 */
export function filterDeployments(rows, { q = '', status = 'all', org = 'all' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const allowed = STATUS_FILTERS[status] ?? null;
  return rows.filter((dep) => {
    if (allowed && !allowed.has(dep.status)) return false;
    if (org !== 'all' && orgOf(dep) !== org) return false;
    if (!needle) return true;
    const hay = [
      dep.name, displayName(dep.name), dep.org_name, dep.status,
      dep.network?.brand, dep.network?.description,
    ].filter(Boolean).join(' ').toLowerCase();
    if (hay.includes(needle)) return true;
    // Same two-pass reading as the map, so one box behaves the same on both screens.
    // A reader who learns that "banking" works on the map should not find it silently
    // returning nothing in the directory.
    const asked = queryTopics(needle);
    return asked.size > 0 && shareATopic(asked, nodeTopics(dep));
  });
}

/** A deployment's organization, with the same blank-to-Unattributed rule as the API. */
export function orgOf(dep) {
  return String(dep.org_name || '').trim() || 'Unattributed';
}

/* ── asking in words ──────────────────────────────────────────────────────────
 * A reader types two different things into one box: an identifier they already know
 * ("retail_oms_004") and a question about a subject ("what networks are related to
 * banking"). Substring matching serves the first and fails the second — no network is
 * literally described as "banking", and none contains the words "what" or "related".
 *
 * So a query is read twice. The literal pass keeps exact-name search working. The
 * topic pass strips the question wording, maps what remains onto the industry
 * vocabulary in util/format.js, and matches any network in those same industries — so
 * "banking" finds the ones described with loan, credit, invoice or KYC.
 *
 * DELIBERATELY NOT AN LLM. This runs on every keystroke of a debounced box and on the
 * map's poll path, where a provider call would add latency, cost and a key that
 * participants are specifically not being asked for. The cost is that it understands
 * subjects, not sentences: it will not reason about "networks that could talk to each
 * other". GET /relations?strategy=llm is where that kind of inference already lives.
 */

// Question scaffolding and words every network shares. Removing them is what lets the
// topic pass see "banking" inside a sentence; left in, every term would miss and the
// question would return nothing at all.
const STOPWORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'any', 'anything', 'are', 'as', 'available', 'be',
  'can', 'could', 'do', 'does', 'find', 'for', 'from', 'get', 'give', 'has', 'have',
  'how', 'i', 'in', 'is', 'it', 'its', 'kind', 'kinds', 'like', 'list', 'me', 'my',
  'network', 'networks', 'of', 'on', 'or', 'please', 'related', 'relating', 'relates',
  'see', 'show', 'some', 'something', 'sort', 'that', 'the', 'their', 'them', 'there',
  'these', 'they', 'this', 'those', 'to', 'us', 'want', 'was', 'we', 'what', 'whats',
  'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

/** The words in a query that carry meaning, lowercased. */
export function queryTerms(q = '') {
  return String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9+/]+/)
    .filter((word) => word && !STOPWORDS.has(word));
}

/**
 * The industries a query is asking about.
 *
 * Each meaningful term is looked up on its own rather than as one string: "banking
 * logistics" should find both subjects, and the joined phrase matches neither regex.
 */
export function queryTopics(q = '') {
  const topics = new Set();
  for (const term of queryTerms(q)) {
    for (const key of industryKeys(term)) topics.add(key);
  }
  return topics;
}

/**
 * The industries a network belongs to.
 *
 * NAME FIRST, description only when the name says nothing — the same precedence
 * industryMarker uses, and for the same reason it documents: a description is a
 * paragraph, and any paragraph mentions everything.
 *
 * The case that forced this: a barbershop booking network whose text ends "routes
 * deposits/payment links/invoice payments/refunds through the payments processor".
 * `payment` and `invoice` are both in the finance row, so searching for networks
 * related to banking returned the barbershop — reasonable-looking words, completely
 * wrong answer. Its *name* says barbershop, which is the signal its author chose.
 *
 * The fallback still exists because some networks are named opaquely, and a topic
 * guessed from the description is better for those than no topic at all.
 */
function nodeTopics(node) {
  // The author's own labels only. front_man is deliberately excluded: it is an agent
  // name, not a subject, and the generic ones mislead — "customer_concierge" put a
  // barbershop in *travel* via "concierge". It stays searchable by literal text,
  // which is where looking up an agent by name belongs.
  const named = industryKeys([
    node?.name, node?.network?.brand,
  ].filter(Boolean).join(' '));
  if (named.size) return named;
  return industryKeys([
    node?.description, node?.network?.description,
  ].filter(Boolean).join(' '));
}

const shareATopic = (a, b) => {
  for (const key of a) if (b.has(key)) return true;
  return false;
};

/**
 * Does one map node match a search box?
 *
 * Separate from filterDeployments because a /graph node is not a deployment record: it
 * carries front_man and a flattened description rather than a nested `network` object,
 * and it has no status filter to honour. Sharing one function would have meant a
 * node-shaped branch inside a deployment-shaped filter.
 *
 * An empty query matches everything, so the caller can treat "no search" and "search
 * cleared" identically.
 */
export function nodeMatchesQuery(node, q = '') {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  if (!node) return false;
  const hay = [
    node.name, displayName(node.name), node.org_name,
    node.front_man, node.description,
  ].filter(Boolean).join(' ').toLowerCase();
  // Literal first: it is the cheaper test and the one that answers a pasted name.
  if (hay.includes(needle)) return true;
  const asked = queryTopics(needle);
  return asked.size > 0 && shareATopic(asked, nodeTopics(node));
}

/** The ids of every node matching a query — what the map uses to highlight. */
export function matchingNodeIds(nodes, q = '') {
  const needle = String(q || '').trim();
  if (!needle) return null;   // null means "no search", distinct from "nothing matched"
  return new Set((Array.isArray(nodes) ? nodes : [])
    .filter((node) => nodeMatchesQuery(node, needle))
    .map((node) => node.id));
}

/**
 * Sorted copy of `rows`. Never mutates the input.
 *
 * `mine` is the default and preserves what the organization grouping used to give
 * for free: your own rows first, because they are the only ones whose controls work.
 *
 * Every comparator falls through to most-connected then name, so the order is
 * *total*. That matters more than it looks: this list repaints every 5 seconds, and
 * a partial order lets equal rows swap places under the reader's cursor between one
 * paint and the next.
 */
export function sortDeployments(rows, { key = 'mine', links = null, org = '' } = {}) {
  const inbound = (dep) => links?.get(dep.id)?.inbound ?? 0;
  const own = String(org || '').trim().toLowerCase();
  const isMine = (dep) => !!own && String(dep.org_name || '').trim().toLowerCase() === own;
  const byName = (a, b) => String(a.name)
    .localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  const tie = (a, b) => inbound(b) - inbound(a) || byName(a, b);
  const comparators = {
    mine: (a, b) => (isMine(b) - isMine(a)) || tie(a, b),
    name: byName,
    connections: tie,
    status: (a, b) => String(a.status).localeCompare(String(b.status)) || tie(a, b),
    newest: (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))
      || tie(a, b),
    org: (a, b) => orgOf(a).localeCompare(orgOf(b), undefined, { sensitivity: 'base' })
      || tie(a, b),
  };
  return rows.slice().sort(comparators[key] || comparators.mine);
}

/**
 * One page of `rows`, with the page number clamped into range.
 *
 * Clamping is the point. A filter can shrink the result set under a reader sitting
 * on page 5; without it the table renders empty and reads as broken rather than
 * showing the last page that exists.
 */
export function paginate(rows, wanted = 1, size = 25) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, wanted), pages);
  const start = (page - 1) * size;
  return { rows: rows.slice(start, start + size), page, pages, total, start };
}
