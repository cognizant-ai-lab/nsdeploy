/**
 * Network list: every deployment, flat — no organization grouping (see
 * views/directory.js for that, still reachable at #directory). This is the
 * sidebar's own quick list: a name, its status, and the three things an operator
 * does to a running network without leaving the main path — view its agent
 * description, stop or resume it, and remove it for good.
 *
 * Lists EVERY organization's networks, and gates the actions instead of the
 * rows: anyone can see what is deployed and read what it does, but resume,
 * stop, restyle and remove are offered only on the rows belonging to the
 * organization remembered in this browser (see util/org.js). Seeing someone
 * else's network is useful — it is a public site, and its description is how
 * you find out whether to link to it; *stopping* it is not yours to do.
 *
 * ⚠ THIS IS A GUARDRAIL, NOT ENFORCEMENT. The service authenticates with one
 * shared token (API_CONTRACT.md §1): it identifies "someone allowed to use this
 * service", never a particular organization, so the API accepts a stop or a
 * delete for any network from any holder of the token. Disabling the buttons
 * stops an accident, not an attacker. Real per-organization isolation needs the
 * login mechanism the contract describes — and when it arrives, the server
 * becomes the place this rule lives and these checks become its echo.
 *
 * Stop/resume/remove reuse directory.js's own `act`/`restart` (same confirm
 * wording, same API calls) rather than a second copy of them drifting from that
 * one.
 */
import { api } from '../api/client.js';
import { acceleratorLink } from '../components/acceleratorLink.js?v=120';
import { toast } from '../components/toast.js';
import { $, esc, icon, onClick, render } from '../util/dom.js';
import { displayName, isLive } from '../util/format.js';
import {
  PAGE_SIZES, filterDeployments, orgOf, paginate, sortDeployments,
} from '../util/listquery.js';
import { copyButton, emptyState, statusPill } from '../components/widgets.js';
import { showAgentDescriptionModal } from '../components/agentDescriptionModal.js';
import { act, iconAction, restart } from './directory.js';
import { getOrg, onOrgChange } from '../util/org.js';
import { editDesign } from '../components/designStudio.js';
import { openLinkPrompt } from '../components/linkPromptModal.js?v=120';
import { showPeerGraph } from '../components/peerGraphModal.js';

const REFRESH_MS = 5000;

let timer = null;
let deployments = [];

/**
 * The connect flow is two steps, and both halves live here rather than in the DOM
 * because this list reloads itself every REFRESH_MS — state held only in the markup
 * would be wiped a few seconds after it was set, in the middle of choosing.
 *
 * `connectSource` is the id of YOUR network whose HOCON is being regenerated. It is
 * the only part ownership gates: you may edit your own network to call anybody,
 * because a deployed network is a public site, but you may not edit theirs. With it
 * unset the list is in its ordinary read-only state and no checkboxes exist at all.
 *
 * `selected` is the set of networks that source should call. `pruneSelection` drops
 * anything that has since stopped, been removed, or become already-linked, so the
 * count can never promise more than the prompt would contain.
 */
let connectSource = null;
let selected = new Set();

const selecting = () => connectSource !== null;

/**
 * Find-your-network state: query, filters, sort and page.
 *
 * Module-level for the same reason `connectSource` is — this list repaints itself
 * every REFRESH_MS, and anything held only in the DOM would be wiped a few seconds
 * after it was set, in the middle of reading page 3.
 *
 * The controls themselves are rendered ONCE by template() and live outside the
 * repainted region, because a search box replaced under a typing operator loses
 * both focus and the caret. Only the table and its pager are re-rendered.
 */
let query = '';
let statusFilter = 'all';
let orgFilter = 'all';
let sortKey = 'mine';
let page = 1;
// Must match the option the browser displays initially. This used to start at 25
// while the first (and therefore visibly selected) option was 10. Selecting the
// already-visible 10 emitted no change event, leaving 25 rows in the internal state.
let pageSize = PAGE_SIZES[0];
let knownOrgs = [];

export function mount(root) {
  render(root, template());

  // "Change organization" is the only thing that changes which organization is
  // remembered, and this list has no filter of its own to fall out of step with
  // it — so a reload on change is all it takes.
  onOrgChange(() => load(root));

  $('#net-refresh', root).addEventListener('click', () => load(root));

  // --- find-your-network controls ---------------------------------------
  // Bound once. Each one resets to page 1, because staying on page 4 while the
  // result set changes underneath shows a reader an empty table and no reason why.
  let debounce = null;
  $('#net-q', root).addEventListener('input', (event) => {
    query = event.target.value;
    page = 1;
    // Debounced: repainting a 100-row table on every keystroke makes typing feel
    // like it is lagging, and the poll will catch up within 5s regardless.
    clearTimeout(debounce);
    debounce = setTimeout(() => repaint(root), 160);
  });
  const onPick = (id, assign) => {
    $(id, root).addEventListener('change', (event) => {
      assign(event.target.value);
      page = 1;
      repaint(root);
    });
  };
  onPick('#net-status', (v) => { statusFilter = v; });
  onPick('#net-org', (v) => { orgFilter = v; });
  onPick('#net-sort', (v) => { sortKey = v; });
  onPick('#net-size', (v) => { pageSize = Number(v) || 25; });

  $('#net-clear', root).addEventListener('click', () => {
    query = ''; statusFilter = 'all'; orgFilter = 'all'; sortKey = 'mine'; page = 1;
    $('#net-q', root).value = '';
    $('#net-status', root).value = 'all';
    $('#net-org', root).value = 'all';
    $('#net-sort', root).value = 'mine';
    repaint(root);
  });

  // Paging is delegated: the pager is inside the repainted body, so the buttons
  // that exist right now are not the ones that will be clicked.
  onClick(root, '[data-page]', (button) => {
    page = Number(button.dataset.page) || 1;
    repaint(root);
    $('#net-body', root)?.scrollIntoView({ block: 'nearest' });
  });
  // The banner's controls are re-rendered on every poll, so both are delegated
  // rather than bound to the elements that happen to exist right now.
  onClick(root, '#net-cancel', () => {
    connectSource = null;
    selected.clear();
    load(root);
  });
  onClick(root, '#net-generate', () => {
    if (!selected.size) return;
    const source = deployments.find((dep) => dep.id === connectSource);
    openLinkPrompt([...selected], source || null);
  });
  root.addEventListener('change', (event) => {
    const box = event.target.closest('[data-select]');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.select);
    else selected.delete(box.dataset.select);
    box.closest('tr')?.classList.toggle('is-selected', box.checked);
    syncSelection(root);
  });

  onClick(root, '[data-view-desc]', (button) => {
    const dep = deployments.find((d) => d.id === button.dataset.viewDesc);
    if (dep) showAgentDescriptionModal(dep);
  });
  // Every managing action re-checks ownership at click time rather than trusting
  // the markup. The buttons it renders for someone else's rows carry no data-*
  // hook at all, so this cannot normally fire — but the table is repainted by a
  // 5s poll and the remembered organization can change between a paint and a
  // click, and "the row moved under me" must not become "I stopped their site".
  const owned = (id) => {
    const dep = deployments.find((d) => d.id === id);
    if (dep && canManage(dep, getOrg())) return dep;
    toast.error('That network belongs to another organization.');
    load(root);
    return null;
  };

  onClick(root, '[data-stop]', (button) => {
    if (owned(button.dataset.stop)) act(button.dataset.stop, false, () => load(root));
  });
  onClick(root, '[data-purge]', (button) => {
    if (owned(button.dataset.purge)) act(button.dataset.purge, true, () => load(root));
  });
  onClick(root, '[data-restart]', (button) => {
    if (owned(button.dataset.restart)) restart(button.dataset.restart, button, () => load(root));
  });
  onClick(root, '[data-edit-theme]', (button) => {
    if (owned(button.dataset.editTheme)) {
      editDesign(button.dataset.editTheme, button.dataset.editThemeName,
        { onUpdated: () => load(root) });
    }
  });
  onClick(root, '[data-view-peers]', (button) => {
    const dep = deployments.find((d) => d.id === button.dataset.viewPeers);
    // Never gated: how a public network is wired is public information, and this
    // reads the list already on screen rather than acting on anything.
    if (dep) showPeerGraph(dep, deployments);
  });
  onClick(root, '[data-connect-from]', (button) => {
    connectSource = button.dataset.connectFrom;
    selected.clear();
    load(root);
  });
  onClick(root, '[data-copy]', async (button) => {
    await navigator.clipboard.writeText(button.dataset.copy);
    toast.ok('URL copied.');
  });

  return {
    refresh: () => load(root),
    // Polling only runs while this tab is visible; a hidden tab should not keep
    // hitting the API.
    activate() {
      load(root);
      timer ??= setInterval(() => load(root, { quiet: true }), REFRESH_MS);
    },
    deactivate() {
      clearInterval(timer);
      timer = null;
      // Leaving the view with a connect started but nothing ticked abandons it: on
      // return the list would show checkboxes on every row and a banner the reader
      // has forgotten opening, with no idea why the screen changed. So that case is
      // cleared. A connect that *has* selections is work in progress — picking
      // targets often means going to the map or directory to decide, and resetting
      // would silently discard those picks — so it is kept, and the banner explains
      // itself on return.
      if (selecting() && selected.size === 0) connectSource = null;
    },
  };
}

function template() {
  return `
  <div class="stack">
    <section class="card">
      <div class="card__head card__head--bordered">
        <div class="card__title">
          <h2>Network list</h2>
          <p class="muted" id="net-subtitle">Every deployed network, across every organization.</p>
          ${acceleratorLink()}
        </div>
        <button class="btn btn--secondary btn--sm" id="net-refresh">
          ${icon('refresh', { size: 14 })}<span>Refresh</span>
        </button>
      </div>

      <!-- Rendered once, deliberately OUTSIDE #net-body. The body is replaced on a
           5s poll; a search input in there would lose focus and the caret while
           somebody was still typing into it. -->
      <div class="listbar" id="net-controls">
        <div class="listbar__search">
          ${icon('search', { size: 14 })}
          <input class="input input--bare" id="net-q" type="search"
                 placeholder="Search name, organization or description"
                 autocomplete="off" spellcheck="false" aria-label="Search networks">
        </div>
        <label class="listbar__field">
          <span class="listbar__label">Status</span>
          <select class="input input--sm" id="net-status" aria-label="Filter by status">
            <option value="all">All</option>
            <option value="live">Live</option>
            <option value="pending">Queued or building</option>
            <option value="stopped">Stopped</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label class="listbar__field">
          <span class="listbar__label">Organization</span>
          <select class="input input--sm" id="net-org" aria-label="Filter by organization">
            <option value="all">All</option>
          </select>
        </label>
        <label class="listbar__field">
          <span class="listbar__label">Sort</span>
          <select class="input input--sm" id="net-sort" aria-label="Sort networks">
            <option value="mine">Mine first</option>
            <option value="name">Name A-Z</option>
            <option value="connections">Most connected</option>
            <option value="newest">Newest first</option>
            <option value="status">Status</option>
            <option value="org">Organization</option>
          </select>
        </label>
        <label class="listbar__field">
          <span class="listbar__label">Per page</span>
          <select class="input input--sm" id="net-size" aria-label="Rows per page">
            ${PAGE_SIZES.map((n) => `<option value="${n}"${
              n === pageSize ? ' selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
        <button class="btn btn--ghost btn--sm" id="net-clear" hidden>Clear</button>
      </div>

      <div class="card__body" id="net-body">
        <div class="stack">
          <div class="skeleton" style="width:40%"></div>
          <div class="skeleton" style="width:70%"></div>
          <div class="skeleton" style="width:55%"></div>
        </div>
      </div>
    </section>
  </div>`;
}

async function load(root, { quiet = false } = {}) {
  try {
    deployments = await api.list();
    syncOrgOptions(root);
    repaint(root);
  } catch (error) {
    if (!quiet) toast.error(`Could not load the network list — ${error.message}`);
  }
}

/**
 * Rebuild the organization filter's options, preserving the current selection.
 *
 * Rewritten only when the set of organizations actually changes. Replacing the
 * options on every 5s poll would collapse the dropdown under anyone who had it open
 * and reset a selection they were part-way through making.
 */
function syncOrgOptions(root) {
  const names = [...new Set(deployments.map(orgOf))]
    .sort((a, b) => (a === 'Unattributed') - (b === 'Unattributed')
      || a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (names.length === knownOrgs.length && names.every((n, i) => n === knownOrgs[i])) return;
  knownOrgs = names;
  const select = $('#net-org', root);
  if (!select) return;
  const keep = select.value;
  select.innerHTML = `<option value="all">All</option>`
    + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  // If the organization being filtered on has gone, fall back to All rather than
  // leaving a filter selected that matches nothing.
  select.value = names.includes(keep) ? keep : 'all';
  if (select.value === 'all') orgFilter = 'all';
}

/** Re-render from the rows already in memory — no fetch, so the controls feel instant. */
function repaint(root) {
  try {
    const org = getOrg();
    const mine = deployments.filter((dep) => canManage(dep, org)).length;
    // Says whose rows are actionable before anyone discovers it by finding a
    // greyed-out button — the list is mostly read-only for most visitors, and
    // that is the kind of thing a screen should admit up front.
    $('#net-subtitle', root).textContent = org
      ? `Every deployed network, across every organization. `
        + `${mine
          ? `You can manage ${mine === 1 ? 'the one' : `the ${mine}`} owned by ${org}`
          : `None belong to ${org}`}.`
      : 'Every deployed network, across every organization. '
        + 'Set your organization to manage your own.';

    if (!deployments.length) {
      render($('#net-body', root), emptyState(
        'No networks yet',
        'Upload a HOCON from the New network tab to deploy your first agent network.',
        'grid',
      ));
      return;
    }
    // Connectivity is computed over EVERY row, not the filtered page: "used by 3"
    // and the most-connected star are facts about the whole estate, and recomputing
    // them per page would make the same network's badge change as you filter.
    const links = connectivity(deployments);
    const targets = outboundTargets(deployments);
    const already = selecting()
      ? (targets.get(connectSource) || new Set()) : new Set();
    pruneSelection(already);

    const filtered = filterDeployments(deployments,
      { q: query, status: statusFilter, org: orgFilter });
    const sorted = sortDeployments(filtered, { key: sortKey, links, org });
    const view = paginate(sorted, page, pageSize);
    page = view.page;  // paginate() clamps; keep the state in step with what rendered

    const active = Boolean(query.trim()) || statusFilter !== 'all' || orgFilter !== 'all'
      || sortKey !== 'mine';
    const clear = $('#net-clear', root);
    if (clear) clear.hidden = !active;

    render($('#net-body', root), connectBanner(org)
      + (view.total === 0
        ? noMatches()
        : listTable(view, links, org, already) + pager(view)));
    // After the render, because the controls it reflects have just been replaced.
    syncSelection(root);
  } catch (error) {
    toast.error(`Could not draw the network list — ${error.message}`);
  }
}

/** Shown when filters exclude everything — distinct from "no networks at all". */
function noMatches() {
  return `
    <div class="emptyish">
      <p class="emptyish__title">No networks match</p>
      <p class="muted">Try a different search, or clear the filters.</p>
    </div>`;
}

/**
 * The rows, as one flat table.
 *
 * Flat rather than grouped by organization, which is what this screen used to do.
 * Grouping and paging pull against each other — a page boundary falling inside a
 * group leaves a header with no rows under it — and at 80+ networks searching and
 * filtering finds a network far faster than scanning group headings. The
 * organization moved into a column, and the "mine first" sort keeps what the
 * grouping was really for: your own rows, which are the only actionable ones, at
 * the top.
 */
function listTable(view, links, org, already) {
  const starred = mostConnected(links);
  return `
    <div class="table-scroll">
      <table class="table table--fixed">
        <!-- Sums to 100%, not 96%: the missing 4% was handed to whichever column the
             browser chose, which at some widths was the actions column and at others
             the URL. Actions gets the largest share because its content is six fixed
             1.9rem buttons that must not wrap — see the min-width floor in
             components.css. Everything else truncates, which is why Network and URL
             can afford to give room back. -->
        <colgroup>
          ${selecting() ? '<col style="width:3.5rem">' : ''}
          <!-- Organization drops 14% -> 11% now that .cell-org caps it at ~14
               characters: the column no longer has to be wide enough for an arbitrary
               name, so the 3% goes to Network, which truncates far more often. -->
          <col style="width:24%"><col style="width:11%"><col style="width:8%">
          <col style="width:11%"><col style="width:24%"><col style="width:22%">
        </colgroup>
        <thead>
          <tr>
            ${selecting()
              ? '<th scope="col"><span class="sr-only">Call from this network</span></th>'
              : ''}
            <th scope="col">Network</th>
            <th scope="col">Organization</th>
            <th scope="col">Status</th>
            <th scope="col">Connections</th>
            <th scope="col">URL</th>
            <th scope="col" class="table__actions">Actions</th>
          </tr>
        </thead>
        <tbody>${view.rows.map((dep) => row(dep, org, links, starred, already)).join('')}</tbody>
      </table>
    </div>`;
}

/**
 * The pager: what you are looking at, and how to move.
 *
 * Says "1-25 of 83" rather than only page numbers, because the count is the thing a
 * reader checks after filtering. First/Last are offered as well as Previous/Next —
 * with 100 networks at 10 a page, stepping to the end one click at a time is not a
 * reasonable ask.
 */
function pager(view) {
  if (view.pages <= 1) {
    return `<div class="pager"><span class="pager__count">${view.total} network${
      view.total === 1 ? '' : 's'}</span></div>`;
  }
  const from = view.start + 1;
  const to = view.start + view.rows.length;
  const btn = (p, label, disabled, extra = '') => `
    <button class="btn btn--ghost btn--sm ${extra}" data-page="${p}"
            ${disabled ? 'disabled' : ''}>${label}</button>`;
  // A window around the current page rather than every page: at 100 rows and 10 a
  // page this is 10 buttons, but the same markup at size 10 over 1000 rows would be
  // a wall of them.
  const span = 2;
  const first = Math.max(1, view.page - span);
  const last = Math.min(view.pages, view.page + span);
  const numbers = [];
  for (let p = first; p <= last; p += 1) {
    numbers.push(btn(p, String(p), false, p === view.page ? 'is-current' : ''));
  }
  return `
    <div class="pager">
      <span class="pager__count">${from}-${to} of ${view.total}</span>
      <div class="pager__nav">
        ${btn(1, 'First', view.page === 1)}
        ${btn(view.page - 1, 'Prev', view.page === 1)}
        ${first > 1 ? '<span class="pager__gap">...</span>' : ''}
        ${numbers.join('')}
        ${last < view.pages ? '<span class="pager__gap">...</span>' : ''}
        ${btn(view.page + 1, 'Next', view.page === view.pages)}
        ${btn(view.pages, 'Last', view.page === view.pages)}
      </div>
    </div>`;
}

/**
 * Drop selections that no longer make sense, then reflect the count in the header.
 *
 * A network can stop, be removed, or lose its URL between two polls. Keeping its id
 * in `selected` would leave the button offering to build a prompt containing a
 * reference that cannot be formed — so it is dropped silently, which matches what
 * the row now shows.
 */
function pruneSelection(already = new Set()) {
  if (!selecting()) { selected.clear(); return; }
  const offerable = new Set(deployments
    .filter((dep) => dep.url && dep.id !== connectSource && !already.has(dep.id))
    .map((dep) => dep.id));
  [...selected].forEach((id) => { if (!offerable.has(id)) selected.delete(id); });
  // The source itself can disappear between two polls; the flow has nothing to
  // regenerate then, so it ends rather than silently retargeting.
  if (!deployments.some((dep) => dep.id === connectSource)) connectSource = null;
}

/** Can this browser start a connect flow from `dep`? Its HOCON, its organization. */
function canConnectFrom(dep, org) {
  return canManage(dep, org);
}

function syncSelection(root) {
  const button = $('#net-generate', root);
  if (!button) return;
  const count = selected.size;
  button.disabled = count === 0;
  button.textContent = count ? `Generate prompt (${count})` : 'Generate prompt';
  button.title = count
    ? `Build the prompt for ${count} connection${count === 1 ? '' : 's'}`
    : 'Tick at least one network above';
}

function connectBanner(org) {
  const source = deployments.find((dep) => dep.id === connectSource);
  if (!source) return '';
  return `
    <div class="connbar" role="status">
      <div class="connbar__text">
        <strong>Connecting ${esc(displayName(source.name))}</strong>
        <span class="cell-sub">Tick the networks it should be able to call. Ones it
          already calls are marked and cannot be ticked again.</span>
      </div>
      <div class="btnrow">
        <button class="btn btn--ghost btn--sm" id="net-cancel">Cancel</button>
        <button class="btn btn--primary btn--sm" id="net-generate" disabled>
          Generate prompt
        </button>
      </div>
    </div>`;
}

/* ── connectivity ───────────────────────────────────────────────────────────
 * Who calls whom, computed here rather than fetched.
 *
 * Every row already carries its own resolved outbound `links` (models.py's
 * NetworkLink: a `reference`, an absolute `target` URL, and the `callers` inside
 * this network). Matching each target's *origin* against the set of deployment URLs
 * is the same thing GET /graph does server-side — so the list needs no second
 * request, and unlike /graph it also covers networks that are deployed but not
 * published, which is most of them while someone is still testing.
 */

/**
 * A long deployment URL shortened for the table, keeping both ends.
 *
 * Truncated in the MIDDLE, not the end, because the end is the part that
 * identifies the deployment: on a hosted install every URL shares a ~60-character
 * FQDN and differs only in the `:8103` after it. A CSS ellipsis would cut exactly
 * the port and network name off, leaving sixty identical-looking rows — so this is
 * done in JS, where the tail can be kept.
 *
 * The full URL stays available three ways: the title attribute on hover, the copy
 * button beside it, and the href itself.
 *
 * 32 characters because that is what the URL column holds at the table's minimum
 * width — a longer budget looked fine on a wide screen and overflowed the cell on
 * a 1000px one, where CSS would then have clipped the tail this exists to keep.
 */
export function shortUrl(url, max = 32) {
  const text = String(url || '');
  if (text.length <= max) return text;
  // Two thirds to the head (scheme and the start of the host, which is what makes
  // it recognisable), a third to the tail (port and path, which make it unique).
  const tail = Math.max(Math.floor((max - 1) / 3), 10);
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Every outbound peer call a row reports, however it was written. */
function peerLinks(dep) {
  return [...(dep.network?.links || []), ...(dep.network?.peer_urls || [])];
}

/** Scheme + host + port, or '' — the identity /graph matches links on. */
function originOf(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/**
 * `id -> { inbound, outbound, external }` for every deployment.
 *
 * `inbound` is the interesting one: how many other networks call this. It is the
 * closest thing here to a popularity signal, because somebody had to deliberately
 * bind a slot to this network's URL for it to count.
 *
 * `external` counts outbound links whose target is not a network on this service —
 * a peer run elsewhere. Kept separate rather than dropped so a network does not
 * look unconnected when in fact it calls something this console cannot see.
 */
export function connectivity(deployments) {
  const byOrigin = new Map();
  deployments.forEach((dep) => {
    const origin = originOf(dep.url);
    if (origin) byOrigin.set(origin, dep.id);
  });

  const counts = new Map(deployments.map(
    (dep) => [dep.id, { inbound: 0, outbound: 0, external: 0 }]));
  deployments.forEach((dep) => {
    const mine = counts.get(dep.id);
    // Both kinds of outbound call: slot-bound `links` and inline `peer_urls`.
    peerLinks(dep).forEach((link) => {
      const targetId = byOrigin.get(originOf(link.target));
      // A self-link would double-count one network as both caller and callee, and
      // says nothing about how connected it is to anything else.
      if (targetId && targetId !== dep.id) {
        mine.outbound += 1;
        counts.get(targetId).inbound += 1;
      } else if (!targetId) {
        mine.external += 1;
      }
    });
  });
  return counts;
}

/**
 * `sourceId -> Set(targetId)` — who each network already links to.
 *
 * Drives the "no checkbox for something it is already connected to" rule: offering
 * a target that is already bound would produce a prompt asking for a link that
 * exists, and the tool would either duplicate it or quietly do nothing.
 */
export function outboundTargets(deployments) {
  const byOrigin = new Map();
  deployments.forEach((dep) => {
    const origin = originOf(dep.url);
    if (origin) byOrigin.set(origin, dep.id);
  });
  const out = new Map(deployments.map((dep) => [dep.id, new Set()]));
  deployments.forEach((dep) => {
    // Both kinds of outbound call: slot-bound `links` and inline `peer_urls`.
    peerLinks(dep).forEach((link) => {
      const targetId = byOrigin.get(originOf(link.target));
      if (targetId && targetId !== dep.id) out.get(dep.id).add(targetId);
    });
  });
  return out;
}

/**
 * The ids of the most-called networks across the whole estate — the single highest
 * inbound count, which is more than one id when networks tie on it.
 *
 * Inbound is the right measure: it only moves when somebody else deliberately bound
 * a slot or wrote a URL pointing here, so it is earned rather than declared. A
 * network nothing calls is never starred, however many calls it makes itself — so an
 * estate where nothing is linked yet shows no star at all rather than crowning an
 * arbitrary row with zero connections.
 *
 * Only the top is marked. Second and third were medals once; they are gone because a
 * star already says "this is the one", and a podium adds vocabulary without adding
 * the answer a reader scanning for the busiest network came for.
 *
 * Estate-wide, not per organization: "the most used network" is a claim about all of
 * them, so the star shows wherever that row appears.
 */
export function mostConnected(links) {
  let best = 0;
  links.forEach((counts) => { if (counts.inbound > best) best = counts.inbound; });

  const winners = new Set();
  if (!best) return winners;
  links.forEach((counts, id) => { if (counts.inbound === best) winners.add(id); });
  return winners;
}

/**
 * The gold star, or '' when this network is not (joint) most-connected.
 *
 * A star rather than a ranked badge: it says "this is the one" before anything is
 * read, where an ordinal has to be read and decoded first.
 *
 * Inline SVG with the fill set from CSS rather than a gradient, because a gradient
 * needs an id and two stars on one screen would collide on it. The viewBox is square
 * and the star fills it, so the glyph sits on the title's own line rather than
 * reserving the headroom the old medal's ribbon needed above the disc.
 */
function topStar(dep, winners, links) {
  if (!winners.has(dep.id)) return '';
  const inbound = links.get(dep.id)?.inbound ?? 0;
  const label = `Most connected — called by ${inbound} `
    + `network${inbound === 1 ? '' : 's'}`;
  return `<svg class="topstar" viewBox="0 0 24 24" role="img"
      aria-label="${esc(label)}"><title>${esc(label)}</title>
    <path class="topstar__shape" d="M12 1 14.7 8.28 22.46 8.6 16.37 13.42
      18.47 20.9 12 16.6 5.53 20.9 7.63 13.42 1.54 8.6 9.3 8.28Z"/>
  </svg>`;
}

/**
 * The connections cell: who calls this, and what it calls.
 *
 * Inbound first and in words ("used by 3 networks"), because that is the number a
 * reader is actually looking for. A network with nothing either way says so plainly
 * rather than showing two zeros, which read as a loading failure.
 */
function connectionsCell(dep, links) {
  const c = links.get(dep.id) || { inbound: 0, outbound: 0, external: 0 };
  if (!c.inbound && !c.outbound && !c.external) {
    return '<span class="muted">Not connected</span>';
  }
  return `
    <div class="conns">
      ${c.inbound ? `<span class="conns__in" title="${c.inbound} other network${
        c.inbound === 1 ? '' : 's'} call${c.inbound === 1 ? 's' : ''} this one">
        ${icon('sitemap', { size: 12 })}<span>used by ${c.inbound}</span></span>` : ''}
      ${c.outbound ? `<span class="conns__out" title="This network calls ${
        c.outbound} other${c.outbound === 1 ? '' : 's'} on this service">
        calls ${c.outbound}</span>` : ''}
      ${c.external ? `<span class="conns__out" title="${c.external} link${
        c.external === 1 ? '' : 's'} to a network outside this service">
        ${c.external} external</span>` : ''}
    </div>`;
}


/**
 * Whether this browser's operator may act on `dep`.
 *
 * Name comparison, because that is what identity is here: the console remembers
 * an organization *name* (util/org.js) and `org_name` is matched
 * case-insensitively on the way in (§3), so the same normalization has to apply
 * on the way out or "Apex" would not own "apex". With no organization set
 * nothing is manageable — "whoever is logged in" cannot mean "everyone" just
 * because nobody has said who they are.
 */
function canManage(dep, org) {
  if (!org) return false;
  return (dep.org_name || '').trim().toLowerCase() === org.trim().toLowerCase();
}

/**
 * The select cell, rendered only while a connect flow is open.
 *
 * Four distinct states, each said rather than left to be inferred: this IS the
 * source; already called by it; callable; or not callable because it has no live
 * URL. A checkbox appears in exactly one of them.
 */
function selectCell(dep, already) {
  const name = displayName(dep.name);
  if (dep.id === connectSource) {
    return '<td class="selcell"><span class="selcell__tag" title="The network being '
      + 'connected">source</span></td>';
  }
  if (already.has(dep.id)) {
    return `<td class="selcell"><span class="selcell__tag selcell__tag--done"
      title="${esc(name)} is already called by this network">linked</span></td>`;
  }
  if (!dep.url) {
    return `<td class="selcell"><input type="checkbox" class="selcell__box" disabled
      aria-label="${esc(name)} has no live URL to call"
      title="${esc(name)} has no live URL to call — start it first"></td>`;
  }
  return `<td class="selcell">
    <input type="checkbox" class="selcell__box" data-select="${esc(dep.id)}"
           ${selected.has(dep.id) ? 'checked' : ''}
           aria-label="Call ${esc(name)} from this network"
           title="Call ${esc(name)} from this network">
  </td>`;
}

/** One class attribute, or none — two of them on a <tr> is invalid markup. */
function rowClass(dep) {
  if (!selecting()) return '';
  if (dep.id === connectSource) return ' class="is-source"';
  return selected.has(dep.id) ? ' class="is-selected"' : '';
}

function row(dep, org, links = new Map(), starred = new Set(), already = new Set()) {
  const live = isLive(dep.status);
  const name = displayName(dep.name);
  const mine = canManage(dep, org);
  const owner = dep.org_name?.trim() || 'another organization';
  // One reason, written once: a disabled control has to say why it is disabled,
  // or it reads as a bug in the console rather than a boundary.
  const why = org
    ? `${name} belongs to ${owner} — only ${org}’s own networks can be managed here`
    : `${name} belongs to ${owner} — set your organization to manage your own networks`;
  const url = dep.url
    ? `<div class="urlcell">
         <div class="urlcell__row">
           <a class="urlcell__link" href="${esc(dep.url)}" target="_blank" rel="noopener"
              title="${esc(dep.url)}">${esc(shortUrl(dep.url))}</a>
           ${copyButton(dep.url, '')}
         </div>
       </div>`
    : '<span class="muted">—</span>';
  return `
  <tr${rowClass(dep)}>
    <!-- Ticking a TARGET is never gated by ownership, and that is the permission
         model: a deployed network is a public site that anything may call. What the
         prompt edits is the source's own HOCON — and the source is gated, which is
         why the Connect action below only appears on your own networks. -->
    ${selecting() ? selectCell(dep, already) : ''}
    <td>
      <div class="cell-title">${topStar(dep, starred, links)}${esc(name)}</div>
      <div class="cell-sub">${esc(dep.network?.front_man || '—')}</div>
    </td>
    <!-- The organization used to be the section heading. With the list flat and
         paginated it is a column, and "yours" is marked here instead of on a group
         so a reader can still see at a glance which rows they can act on. -->
    <td>
      <!-- title carries the full name: the cell truncates at ~14 characters (see
           .cell-org in components.css) and a reader needs some way to read the rest
           without opening the row. -->
      <div class="cell-title cell-org" title="${esc(orgOf(dep))}">${esc(orgOf(dep))}</div>
      ${mine ? '<div class="cell-sub"><span class="org-group__mine">yours</span></div>' : ''}
    </td>
    <td>${statusPill(dep.status)}</td>
    <td>${connectionsCell(dep, links)}</td>
    <td>${url}</td>
    <td class="table__actions">
      <div class="table__actions-row">
        <!-- View is never gated: a deployed network is a public site, and its
             description is how anyone decides whether to link to it. -->
        ${iconAction('eye', `What ${name} does`, `data-view-desc="${esc(dep.id)}"`)}
        <!-- Never gated, for the same reason as View: linking *to* a network is
             something any organization does, and the thing it hands over is the
             network's public address. Needs a live URL, so a stopped network says
             why instead of offering a reference that points nowhere. -->
        <!-- Start a connect flow FROM this network. Gated on ownership because it
             regenerates this network's own HOCON — the thing you may only do to
             your own. Choosing the targets afterwards is not gated. -->
        ${iconAction('sitemap', `See which networks ${name} is connected to`,
            `data-view-peers="${esc(dep.id)}"`)}
        ${canConnectFrom(dep, org)
          ? iconAction('plus', `Connect ${name} to other networks`,
              `data-connect-from="${esc(dep.id)}"`)
          : iconAction('plus',
              `Only ${org || 'your own organization'}'s networks can be connected `
              + `from here — ${name} belongs to ${esc(owner)}`, 'disabled')}
        ${mine
          ? iconAction('palette', `Change how ${name} looks`,
              `data-edit-theme="${esc(dep.id)}" data-edit-theme-name="${esc(dep.name)}"`)
          : iconAction('palette', why, 'disabled')}
        ${!mine
          ? iconAction(live ? 'stop' : 'refresh', why, 'disabled')
          : live
            ? iconAction('stop', 'Stop this network', `data-stop="${esc(dep.id)}"`, 'act--danger')
            : iconAction('refresh', 'Resume — restart from the stored HOCON',
                `data-restart="${esc(dep.id)}"`)}
        ${!mine
          ? iconAction('trash', why, 'disabled')
          : live
            // Removal discards the logs and the uploaded HOCON, so it must not double
            // as "tear the running site down" — stop it first, same as the Directory.
            ? iconAction('trash', 'Stop this network before removing it', 'disabled')
            : iconAction('trash', 'Remove for good — discards its logs and uploaded HOCON',
                `data-purge="${esc(dep.id)}"`, 'act--danger')}
      </div>
    </td>
  </tr>`;
}
