/** Presentation-only formatting. */

export const LIVE_STATUSES = ['queued', 'building', 'ready'];
export const isLive = (status) => LIVE_STATUSES.includes(status);

/**
 * Status presentation. The glyph is load-bearing, not decoration: the status
 * palette's `good` and `critical` are ~ΔE 4 apart under deuteranopia, so shape
 * plus the visible word carries the distinction and hue only reinforces it.
 */
const STATUS = {
  queued:   { glyph: '◦', label: 'queued',   sr: 'Queued, waiting for a build slot' },
  building: { glyph: '◐', label: 'building', sr: 'Building', spin: true },
  ready:    { glyph: '✓', label: 'ready',    sr: 'Ready and serving' },
  failed:   { glyph: '✕', label: 'failed',   sr: 'Failed' },
  stopped:  { glyph: '■', label: 'stopped',  sr: 'Stopped' },
};

export const statusMeta = (status) =>
  STATUS[status] ?? { glyph: '?', label: status || 'unknown', sr: 'Unknown state' };

/** `2026-09-22T20:29:19+00:00` → `2026-09-22 20:29 UTC` */
export function timestamp(value) {
  if (!value) return '—';
  return String(value).replace('T', ' ').replace(/(\+00:00|Z)$/, ' UTC');
}

/** Coarse relative age, enough for a directory listing. */
export function age(value) {
  if (!value) return '';
  const then = Date.parse(value);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const units = [['d', 86400], ['h', 3600], ['m', 60]];
  for (const [suffix, size] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix} ago`;
  }
  return 'just now';
}

/* ── human names ────────────────────────────────────────────────────────────
 * A network's name is its HOCON filename stem and an agent's is its key in that
 * file, so both arrive here as `travel_agent_system` / `traveler_intake_agent`.
 * Those are identifiers — they reach the filesystem and the URL, and
 * safe_network_name() server-side deliberately refuses to sanitise them — so the
 * data must not change. Only the label does.
 *
 * Three rules, in order:
 *   · Separators become spaces. `_`, `-` and existing whitespace all collapse.
 *   · Known acronyms are spelled the way the industry spells them, because
 *     "Cicd Saas Ops" and "Fifa World Cup" read as a bug, not as a name.
 *   · Everything else is capitalised, except joining words in the middle of the
 *     phrase ("Point of Sale", not "Point Of Sale").
 *
 * A name that already looks human is returned untouched: an operator who typed
 * "AcmeBot" or "Travel Desk (EU)" has already chosen their capitalisation, and
 * re-casing it would be this function overruling them.
 */
const ACRONYMS = new Map(Object.entries({
  ai: 'AI', ml: 'ML', llm: 'LLM', nlp: 'NLP', rag: 'RAG', mcp: 'MCP', byok: 'BYOK',
  api: 'API', sdk: 'SDK', ui: 'UI', ux: 'UX', sql: 'SQL', csv: 'CSV', pdf: 'PDF',
  cicd: 'CI/CD', ci: 'CI', cd: 'CD', devops: 'DevOps', iot: 'IoT', saas: 'SaaS',
  it: 'IT', ot: 'OT', hr: 'HR', qa: 'QA', pos: 'POS', crm: 'CRM', erp: 'ERP',
  kpi: 'KPI', sla: 'SLA', faq: 'FAQ', b2b: 'B2B', b2c: 'B2C', e2e: 'E2E',
  fifa: 'FIFA', us: 'US', uk: 'UK', eu: 'EU',
  // Hosted tool names arrive here too — they are keys in the same file.
  ddgs: 'DDGS', http: 'HTTP', url: 'URL',
}));
// Lowercase only *between* words — a name may legitimately begin with one
// ("The Bakery"), and a trailing one would read as a truncation.
const JOINERS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on',
  'or', 'per', 'the', 'to', 'vs', 'with']);

export function displayName(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  // Already human: no separator to expand and the author's own casing to keep.
  if (!/[_-]/.test(value) && /[A-Z]/.test(value)) return value;

  const words = value.split(/[\s_-]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return ACRONYMS.get(lower);
      if (JOINERS.has(lower) && index > 0 && index < words.length - 1) return lower;
      // Leave anything that starts with a digit alone: `48h` and `v2` are not
      // words and title-casing them ("48h" → "48H") only makes them wrong.
      if (/^\d/.test(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/* ── capability bullets ─────────────────────────────────────────────────────
 * A network's `description` is one long author-written paragraph — the travel
 * example is 340 characters of semicolons. On the map it is read while hovering
 * a pin, by people who did not build the network and are not reading closely.
 * As prose it does not get read at all, so it is broken into a few very short
 * points instead.
 *
 * How, without a language model:
 *   · Split on real clause boundaries — `. ; : ,` and a dash.
 *   · Inside a clause, stop at the first "and"/"or" or the first PREPOSITION.
 *     That is the trick that makes the output readable: these descriptions are
 *     verb-first ("routes requests to the appropriate bakery tools for
 *     recommendations"), and everything useful sits between the verb and the
 *     first preposition ("Routes requests").
 *   · Drop articles and auxiliaries, then keep at most three words. Where a
 *     clause has more, keep the first (the verb) and the last two (the thing
 *     it acts on) — "Gathers order requirements", not "Gathers essential order".
 *   · Only the first letter is touched, so CI/CD, HR and OKRs survive.
 *
 * A clause that yields nothing is dropped, and if the whole description yields
 * nothing the caller still has the original text to fall back to.
 */
// A preposition or subordinator ends the phrase outright — whatever follows it
// is detail, and the verb plus its object is already complete.
const BULLET_STOP = new Set([
  'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'onto',
  'across', 'via', 'through', 'under', 'over', 'between', 'among', 'about',
  'when', 'while', 'that', 'which', 'where', 'than', 'until', 'so',
]);
// A conjunction is only a boundary once there is a phrase to end. "normalizes
// and minimally validates inbound submissions" is one action, and breaking at
// the first `and` would publish a bullet reading just "Normalizes".
const BULLET_CONJ = new Set(['and', 'or', 'plus', 'then']);
const BULLET_DROP = new Set([
  'a', 'an', 'the', 'its', 'their', 'this', 'these', 'those', 'is', 'are',
  'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
  'may', 'might', 'do', 'does', 'all', 'any', 'each', 'every', 'both',
]);
// Kept inside a phrase but never counted toward the word cap and never left
// dangling at the end: "Acts as owner/operator" reads, "Acts" does not.
const BULLET_CONNECT = new Set(['as', 'of']);
// A phrase that stopped at a preposition often ends on the adjective that was
// pointing at it — "responsible for", "used to". The adjective alone says
// nothing, so it goes with the preposition.
const BULLET_DANGLING = new Set([
  'responsible', 'accountable', 'available', 'used', 'designed', 'intended',
  'suitable', 'ready', 'able', 'meant',
]);
const MAX_BULLET_WORDS = 3;

export function capabilityBullets(description, max = 5) {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const points = [];
  // Parentheses split too: an aside cut mid-way leaves "(pricing" hanging.
  for (const clause of text.split(/[.;:,()[\]]|\s[—–-]\s/)) {
    const words = clause.trim().split(/\s+/).filter(Boolean);
    const kept = [];
    let stopped = false;
    for (const word of words) {
      const bare = word.replace(/[^\w/'-]/g, '').toLowerCase();
      if (!bare) continue;
      if (BULLET_STOP.has(bare)) { stopped = true; break; }
      if (BULLET_CONJ.has(bare)) {
        if (kept.length >= 2) { stopped = true; break; }
        continue;
      }
      if (BULLET_DROP.has(bare)) continue;
      if (BULLET_CONNECT.has(bare)) { if (kept.length) kept.push(bare); continue; }
      kept.push(word.replace(/[^\w/'-]+$/, ''));
    }
    while (kept.length && BULLET_CONNECT.has(kept[kept.length - 1].toLowerCase())) kept.pop();
    if (stopped && kept.length > 1
        && BULLET_DANGLING.has(kept[kept.length - 1].toLowerCase())) kept.pop();
    if (!kept.length) continue;

    const counted = kept.filter((w) => !BULLET_CONNECT.has(w.toLowerCase()));
    const point = counted.length > MAX_BULLET_WORDS
      // The verb plus what it acts on — the middle is usually adjectives.
      ? [kept[0], ...kept.slice(-2)].join(' ')
      : kept.join(' ');
    const dupe = points.some((p) => p.toLowerCase() === point.toLowerCase());
    if (!dupe) points.push(point.charAt(0).toUpperCase() + point.slice(1));
    if (points.length >= max) break;
  }
  return points;
}

/* ── industry marker ───────────────────────────────────────────────────────────
 * Which trade a network is in, guessed from its name and description so a pin
 * can carry a recognisable icon instead of a status glyph. A reader scanning the
 * map should know what a place *does* before reading its name — that is the whole
 * job of a marker on a street map.
 *
 * Keyword matched, in order, first hit wins: the list is ordered specific-first
 * so "ice cream" beats "shop" and "payroll" beats "finance". Everything that
 * matches nothing gets a neutral network marker rather than a wrong guess.
 *
 * The COLOUR is decoration on top of the icon, never the signal — the emoji
 * carries the meaning, which matters because these hues are not a validated
 * categorical palette and industry is a guess, not data. Deployment STATUS stays
 * where it has always been: its own glyph and ring on the marker (see
 * statusMeta), so nothing here can be confused for whether a site is up.
 */
const INDUSTRIES = [
  [/sport|football|soccer|world cup|cup|league|stadium/, '⚽', 'green'],
  [/ice ?cream|gelato/, '🍦', 'rose'],
  [/bakery|bake|patisserie|pastry/, '🥐', 'amber'],
  [/coffee|cafe|café|espresso/, '☕', 'amber'],
  [/food ?truck|\btruck(s|ing)?\b|18.?wheeler|semi.?truck/, '🚚', 'sky'],
  [/gas station|petrol|fuel (pump|station)|filling station/, '⛽', 'amber'],
  [/restaurant|steak|dining|kitchen|food|menu|recipe|meal/, '🍽️', 'amber'],
  [/pharmacy|pharma|clinic|health|medical|patient|wellness|\bcare\b/, '💊', 'rose'],
  [/hospital|doctor|nurse/, '🏥', 'rose'],
  [/airline|flight|aviation|airport/, '✈️', 'sky'],
  [/travel|\btrip\b|\btour\b|concierge|itinerary|holiday|vacation/, '🧭', 'sky'],
  [/hotel|\bstay\b|accommodation|lodging|\broom\b/, '🏨', 'sky'],
  [/mortgage|bank|loan|lending|credit|payment|invoice|billing|finance/, '🏦', 'teal'],
  [/payroll|salary|wage|tax/, '💵', 'teal'],
  [/insurance|claim|policy|underwrit/, '🛡️', 'teal'],
  [/hr\b|human resources|people|recruit|hiring|talent|employee|workforce/, '👥', 'violet'],
  [/school|academy|college|universit|student|course|learning|training/, '🎓', 'violet'],
  [/library|book|publish|document|archive/, '📚', 'violet'],
  [/retail|ecommerce|e-commerce|commerce|shop|store|pos\b|checkout|cart|order/, '🛒', 'amber'],
  [/ship|logistic|delivery|freight|courier|warehouse|fulfil|supply/, '🚚', 'sky'],
  [/factory|manufactur|plant|assembly|production/, '🏭', 'slate'],
  [/energy|power|grid|utility|electric|solar|uniper/, '⚡', 'amber'],
  [/telecom|network operator|mobile|broadband/, '📡', 'sky'],
  [/legal|law|contract|compliance|governance|audit|risk/, '⚖️', 'slate'],
  [/marketing|campaign|brand|advert|content|social/, '📣', 'rose'],
  [/sales|crm|lead|pipeline|quote/, '📈', 'teal'],
  [/support|helpdesk|service desk|ticket|chatbot|\bassistant\b/, '💬', 'violet'],
  [/music|dj|concert|festival|audio/, '🎧', 'violet'],
  [/cinema|movie|film|studio|media/, '🎬', 'violet'],
  [/\bgame|\btoy|lego|\btrain\b|\bplay\b/, '🎲', 'rose'],
  [/park|garden|outdoor|recreation/, '🌳', 'green'],
  [/farm|agri|crop|harvest/, '🌾', 'green'],
  [/build|construct|property|estate|facility|site ops/, '🏗️', 'slate'],
  [/\bauto\b|vehicle|\bcar\b|fleet|rental|\bride|transport|mobility/, '🚗', 'sky'],
  [/security|fraud|threat|identity|access/, '🔐', 'slate'],
  [/data|analytic|report|dashboard|insight|predict|model/, '📊', 'teal'],
  [/devops|ci\/cd|cicd|pipeline|deploy|platform|infrastructure|ops\b|saas/, '⚙️', 'slate'],
  [/strategy|advisory|consult|transformation/, '🧠', 'violet'],
];

const INDUSTRY_FALLBACK = ['🕸️', 'slate'];

/**
 * Which industries a piece of text belongs to, as indices into INDUSTRIES.
 *
 * This is the table industryMarker already uses to choose a pin's emoji, read a second
 * way: as a topic vocabulary. "banking" and "loan" and "invoice" all land on the same
 * row, so a search for one can find networks described with any of the others —
 * without a second, drifting list of synonyms to maintain alongside this one.
 *
 * Unlike industryMarker this returns *every* match rather than the first. A marker has
 * to pick one emoji; a search should not throw away the fact that a network is both
 * retail and logistics.
 */
export function industryKeys(text) {
  const hay = String(text ?? '').replace(/[_-]+/g, ' ').toLowerCase();
  const keys = new Set();
  if (!hay.trim()) return keys;
  INDUSTRIES.forEach(([pattern], index) => {
    if (pattern.test(hay)) keys.add(index);
  });
  return keys;
}

export function industryMarker(name, description = '') {
  // Two passes, name alone first. The description is a paragraph and any
  // paragraph mentions everything: "FIFA World Cup Fan Navigator" was coming
  // out as a delivery van because its text says "logistics", and "CI/CD SaaS
  // Ops" as a law court because its text says "compliance". An author's own
  // label for the network is the better signal, so it gets to answer first and
  // the description is only consulted when the name says nothing.
  const clean = (value) => String(value ?? '').replace(/[_-]+/g, ' ').toLowerCase();
  for (const haystack of [clean(name), `${clean(name)} ${clean(description)}`]) {
    if (!haystack.trim()) continue;
    for (const [pattern, emoji, hue] of INDUSTRIES) {
      if (pattern.test(haystack)) return { emoji, hue };
    }
  }
  const [emoji, hue] = INDUSTRY_FALLBACK;
  return { emoji, hue };
}

export function bytes(count) {
  if (!Number.isFinite(count)) return '';
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / 1024 / 1024).toFixed(1)} MB`;
}

/** Compact counts for stat tiles (1,284 / 12.9K). */
export function count(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(1)}M`;
}
