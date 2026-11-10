/**
 * The prompt to hand a HOCON-generating tool so a network can call one or more
 * deployed peers.
 *
 * WHY THIS EXISTS. A peer reference is not the site's URL — the runtime reads the
 * URL's *path* as the network name (`parseExternalAgent` in nsdeploy/runtime/
 * kernel.js) and then refuses to run anything else:
 *
 *     No published network named '<host>:<port>' at <host>:<port>;
 *     refusing to run a different network.
 *
 * That is the guard working correctly on a bare origin. The correct reference is
 * `<site-url>/<network-name>`, and the network name is the HOCON's own filename
 * stem — which is exactly what a person copying a URL out of the address bar does
 * not have. So the console composes the reference itself.
 *
 * WHAT IT ASKS FOR. That each peer URL end up in some agent's `tools` — and nothing
 * more specific than that. nsdeploy reads a full URL in `tools` as a peer agent
 * network (resolve.py's `external_networks`), and the service picks those up as
 * `peer_urls` so they draw on the map. *Which* agent owns it does not matter to
 * either, so the prompt leaves that choice to the generator; versions that dictated
 * "add a new agent per peer" are exactly the ones that failed (see connectPromptFor).
 *
 * The alternative is a named link slot bound through a top-level `links` block. That
 * keeps every URL in one place, so re-pointing a link later is a one-line edit
 * rather than a hunt through agents — but it needs two coordinated edits, and a
 * generator that makes only one of them leaves a dangling slot and no connection.
 *
 * The network name comes from `dep.name`, not the display name: that value is the
 * HOCON stem (supervisor.safe_network_name rejects anything that is not a plain
 * identifier rather than sanitising it), so it is byte-identical to the
 * `networks[0].name` the peer publishes. `displayName` is a reader's version —
 * "Bofa Credit Card Chooser" — and would never match.
 */
import { api } from '../api/client.js';
import { toast } from './toast.js';
import { $, esc, icon, render } from '../util/dom.js';
import { displayName } from '../util/format.js';
import { openModal } from './modal.js';
import { acceleratorLink } from './acceleratorLink.js?v=120';

/** An agent name has to be usable as a bare HOCON identifier. */
const SLOT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The canonical peer reference for a deployment: its origin plus its network name.
 * Returns '' when the network has no live URL, because there is no address to
 * reference yet.
 */
export function peerReference(dep) {
  const base = String(dep?.url || '').replace(/\/+$/, '');
  const name = String(dep?.name || '').trim();
  return base && name ? `${base}/${name}` : '';
}

/**
 * The default slot name for a network: its own name.
 *
 * Not a cleverer guess on purpose — the network name is already a valid identifier
 * and is the one string the operator will recognise. `taken` disambiguates, because
 * network names are NOT unique across organizations and two slots with the same
 * name would silently collapse into a single binding.
 */
export function defaultSlot(dep, taken = new Set()) {
  const base = String(dep?.name || 'peer').trim() || 'peer';
  if (!taken.has(base)) return base;
  return `${base}_${String(dep?.id || '').slice(0, 4)}`;
}

/**
 * A network's description reduced to one line.
 *
 * What `description` holds varies: with deploy-time theming on it is the LLM's
 * tagline ("Audit-ready onboarding to monitoring"), which is already a line; with
 * theming off it falls back to the front-man agent's own `function.description`,
 * which can run to a paragraph. So this has to cope with both.
 *
 * Prefers the first sentence when there is one of a sensible length, because the
 * first sentence of a function description is almost always the "what it does"
 * summary and the rest is caveats. Otherwise it cuts on a word boundary — never
 * mid-word, which reads as corruption rather than abbreviation.
 */
export function oneLiner(text, max = 120) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  // A sentence end inside the budget, not counting the "e.g." kind of full stop.
  const sentence = flat.slice(0, max + 1).match(/^(.*?[.!?])(?=\s|$)/);
  if (sentence && sentence[1].length > 40) return sentence[1];
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/**
 * What to tell a generator the target network is for.
 *
 * How much `description` is worth depends on deploy-time theming. With theming off it
 * is the front-man's own `function.description` — a real paragraph ("Leads and
 * coordinates end-to-end inventory operations across retail locations/warehouses by
 * setting policies, KPIs, SLAs...") — but with theming on the LLM replaces it with a
 * brand tagline. "Prep, staff, sell, recover." is the whole description of a
 * sixteen-agent food-truck network, and most deployments are themed.
 *
 * `sample_queries` survive theming intact and are concrete ("Build a next-day
 * operations plan for Friday dinner service... 180 covers and rain. Include staffing
 * by station, prep pars, ticket-time target"), so one of them restores some of the
 * capability the tagline dropped.
 *
 * The example is a fallback, not a companion: it appears only when the description is
 * short enough to be a tagline. The connect prompt switches it off entirely
 * (`withExample: false`) — a bullet carries one line per peer and a second quoted
 * sentence pushes the URL off the side — so it survives for the dialog's own callers.
 */
// 420 so a front-man's purpose arrives whole. These descriptions are written to tell
// one agent what another agent does — "Top-level orchestrator for the Cognizant
// careers helper. Clarifies the candidate's goal, gathers minimal context, and routes
// to the right specialist for job search, job details and fit, application materials,
// Taleo login/application help, status tracking, interview prep, or accommodations" is
// ~300 characters, and the part a designer needs is the *routing list* at the end.
//
// At 160 oneLiner stopped at the first sentence — "Top-level orchestrator for the
// Cognizant careers helper." — which names the network and says nothing about what it
// can be asked, i.e. it reintroduces the problem this change exists to fix. The cap is
// still there to stop one pathological description dominating a multi-peer prompt.
function targetBrief(dep, { max = 420, withExample = true } = {}) {
  const net = dep?.network || {};
  // The front-man's own `function.description` first, the network blurb second.
  //
  // WHY. With theming on, `description` is the LLM's brand tagline — "Sharper shifts.
  // Happier scoops." — while the front-man's description is the author's account of
  // what the network does and routes to. A tagline cannot tell an agent-network
  // designer what a down-chain agent is for, which is the whole job of this prompt.
  //
  // The fallback is not dead code: `front_man_description` is recorded at build time,
  // so a record built before that field existed has none. _repair_summaries() backfills
  // those from the on-disk bundle at startup, but until a restart the tagline is still
  // better than an empty bullet.
  //
  // No trailing-punctuation strip: these are spliced in as quoted material, so a
  // description ending in '.' is a finished sentence. Stripping it turned
  // "Prep sharp. Serve fast. Close clean." into "...Close clean", which reads as
  // truncation. (The doubled '..' that strip once guarded against came from the old
  // `handles "${summary}".` construction, which no longer exists.)
  const handles = oneLiner(net.front_man_description || net.description, max);

  // The example is only worth its length when the description is too thin to write a
  // function.description from — i.e. when theming replaced it with a tagline and no
  // agent description was recorded to fall back on. A real paragraph needs no help.
  // 60 is the cut: "Prep, staff, sell, recover." is 27, a front-man purpose is 200+.
  //
  // `withExample` is off for a multi-peer list, where every peer gets one line and the
  // list is meant to be scanned down the agent names. A second quoted sentence per row
  // pushes the URL off the side and turns a table back into prose.
  const example = withExample && handles.length < 60
    ? oneLiner((net.sample_queries || [])[0], 90)
    : '';

  return { handles, example };
}

/**
 * The text a person pastes into whatever tool regenerates their HOCON.
 *
 * DO NOT reword this without a real generator and a real HOCON to test against. Four
 * versions have been tried on actual uploads and three failed; every one of them read
 * perfectly well on the page. The record, because it is the only thing that justifies
 * the current shape:
 *
 *   1. "add a new agent whose only tool is this web address" — the generator wrote the
 *      address into the prose of `description`/`instructions` and gave the agent no
 *      `tools` key at all. nsdeploy filed both peers as dangling `link_slots`: the
 *      network deployed, the agents were reachable, nothing connected.
 *   2. The same, with `"tools": ["<address>"] and nowhere else`, a placeholder ban and
 *      a count self-check — placement became correct (every address that appeared was
 *      in a tools list) but at NINE peers only four arrived, plus one invented
 *      `https://example.com/...`. A coverage failure, not a placement one.
 *   3. An operator's own terse wording, which dropped all field names: worked at three
 *      peers, then put the addresses back in prose at two. Coverage was never the
 *      problem; placement was unpredictable.
 *
 * So the two failure modes are independent, and this version takes what each attempt
 * got right. "Find the right place in the agent network" stays — letting the generator
 * choose which agent owns the tool is what fixed coverage, and prescribing a wrapper
 * agent per peer is what broke it. The `"tools"` field is named again, with the prose
 * placement ruled out explicitly, because that is the only thing that has ever made
 * placement reliable.
 *
 * Still deliberately absent, all present in failed versions: the source network's name,
 * the front-man's name, the placeholder ban, the completeness self-check, and "return
 * the complete HOCON with everything else unchanged". The URL stays alone on its own
 * line, which is how the working version had it and keeps it copyable verbatim.
 *
 * Coverage at high peer counts is NOT solved here and probably cannot be solved by
 * wording — nine at once failed under the most explicit prompt of the four. Link two
 * or three at a time.
 *
 * One peer and many peers use the same shape, so there is no branch here. `source` is
 * unused and kept only because callers pass it.
 */
export function connectPromptFor(entries, source = null) { // eslint-disable-line no-unused-vars
  if (!entries.length) return '';
  return [
    'Find the right place in the agent network and connect the following agents as tools. '
      + 'Put each address in that agent\'s "tools" list — "tools": ["<address>"] — '
      + 'not in its description or instructions:',
    ...entries.flatMap(({ dep, slot }) => {
      // `described as “…”` rather than the description running straight on from the
      // name. Two things that buys: the reader can see where the agent's name stops
      // and the quoted material starts, and a description that itself contains commas
      // and full stops — most of them do — no longer reads as part of the sentence
      // around it. Curly quotes on purpose: the straight pair already appears in
      // `"tools": ["<address>"]` on the line above, and reusing it here would make the
      // quoted prose look like more HOCON.
      //
      // The description still gives up a trailing full stop so `”, use:` reads as one
      // clause. Only the final stop goes — these are internally punctuated ("Sharper
      // shifts. Faster fixes. Better dogs.") and stripping more would read as
      // corruption. A description ending in anything else, such as the "(checklists,
      // SOPs, schedules, templates, KPIs, and prioritized next steps)" case, is left
      // exactly as written.
      const { handles } = targetBrief(dep, { withExample: false });
      const purpose = handles ? `, described as “${handles.replace(/\.$/, '')}”` : '';
      return [`- For ${slot}${purpose}, use:`, peerReference(dep)];
    }),
  ].join('\n');
}

/* ── the dialog ─────────────────────────────────────────────────────────── */

function candidateRow(dep, slot, checked) {
  const name = displayName(dep.name);
  const description = (dep.network?.description || '').trim();
  return `
    <li class="picker__row${checked ? ' is-on' : ''}" data-row="${esc(dep.id)}">
      <label class="switch picker__pick">
        <input type="checkbox" data-pick="${esc(dep.id)}" ${checked ? 'checked' : ''}>
        <span class="picker__name">${esc(name)}</span>
      </label>
      <div class="picker__meta">
        <span class="cell-sub">${esc(dep.org_name || 'Unattributed')}</span>
        ${description ? `<span class="cell-sub">${esc(description.slice(0, 110))}</span>` : ''}
      </div>
      <label class="picker__slot">
        <span class="cell-sub">agent</span>
        <input class="input input--sm" data-slot="${esc(dep.id)}"
               value="${esc(slot)}" spellcheck="false"
               ${checked ? '' : 'disabled'}>
      </label>
    </li>`;
}

function showConnectPrompt(candidates, preselectIds, source) {
  openModal({
    title: source?.name ? `Connect ${displayName(source.name)}` : 'Connect networks',
    size: 'lg',
    render(body, close) {
      // id -> slot name. Insertion order is the order they appear in the prompt, so
      // the block reads in the order the operator ticked things.
      const picked = new Map();
      const slots = new Map();
      candidates.forEach((dep) => slots.set(dep.id, defaultSlot(dep, new Set(slots.values()))));
      // Ticked in candidate order rather than the order the ids arrived, so the
      // links block reads down the list the same way the screen behind it does.
      candidates.forEach((dep) => {
        if (preselectIds.includes(dep.id)) picked.set(dep.id, slots.get(dep.id));
      });

      render(body, `
        <p class="field__hint">
          These are the networks <strong>your own</strong> network will be able to
          call. Tick the ones you want, copy the prompt, paste it into the tool that
          writes your HOCON, then upload the updated file. The connection is added to
          your network, not to theirs, so you can point at any organization's network.
          The web addresses below are already complete — copy them exactly as they are.
        </p>
        ${acceleratorLink()}

        <div class="field">
          <div class="picker__head">
            <label class="field__label" for="cp-search">Deployed networks</label>
            <span class="cell-sub" id="cp-count"></span>
          </div>
          <input class="input input--sm" id="cp-search" placeholder="Search by name"
                 autocomplete="off" spellcheck="false">
          <ul class="picker" id="cp-list"></ul>
          <p class="field__error" id="cp-error" hidden></p>
        </div>

        <div class="field">
          <label class="field__label" for="cp-prompt">Prompt</label>
          <textarea class="input" id="cp-prompt" readonly rows="14"
                    spellcheck="false"></textarea>
        </div>

        <div class="modal__foot">
          <button type="button" class="btn btn--secondary" data-close>Close</button>
          <button type="button" class="btn btn--primary" id="cp-copy-prompt">
            ${icon('copy', { size: 13 })}<span>Copy prompt</span>
          </button>
        </div>`);

      const list = $('#cp-list', body);
      const search = $('#cp-search', body);
      const promptBox = $('#cp-prompt', body);
      const errorBox = $('#cp-error', body);
      const countLabel = $('#cp-count', body);
      const copyPrompt = $('#cp-copy-prompt', body);

      /** Selected rows, in tick order, as the prompt builders want them. */
      const entries = () => [...picked.keys()]
        .map((id) => ({ dep: candidates.find((d) => d.id === id), slot: picked.get(id) }))
        .filter((e) => e.dep);

      function validate(current) {
        const names = current.map((e) => e.slot.trim());
        if (names.some((n) => !SLOT_PATTERN.test(n))) {
          return 'An agent name must start with a letter or underscore and contain only '
            + 'letters, numbers and underscores — it becomes an agent name in the HOCON.';
        }
        if (new Set(names).size !== names.length) {
          return 'Two agents have the same name. Give each one its own name, or the '
            + 'generated HOCON will have a duplicate agent.';
        }
        return '';
      }

      function refresh() {
        const current = entries();
        const problem = validate(current);
        countLabel.textContent = current.length
          ? `${current.length} selected` : 'none selected';
        errorBox.hidden = !problem;
        errorBox.textContent = problem;
        const usable = current.length > 0 && !problem;
        copyPrompt.disabled = !usable;
        promptBox.value = usable
          ? connectPromptFor(current, source)
          : (current.length
            ? 'Fix the slot names above to see the prompt.'
            : 'Tick one or more networks above to build the prompt.');
        // Grow with the peer list instead of sitting at a fixed 14. The prompt is
        // three lines for one peer and one line longer per peer after that, so a
        // fixed box was two-thirds empty in the common case and still scrolled at
        // ten. Floor of 6 leaves room for the wrap the long first line always takes.
        promptBox.rows = Math.min(16, Math.max(6, promptBox.value.split('\n').length + 3));
      }

      function paint() {
        const term = search.value.trim().toLowerCase();
        const shown = candidates.filter((dep) => !term
          || displayName(dep.name).toLowerCase().includes(term)
          || String(dep.name).toLowerCase().includes(term));
        render(list, shown.length
          ? shown.map((dep) =>
            candidateRow(dep, picked.get(dep.id) ?? slots.get(dep.id), picked.has(dep.id))).join('')
          : '<li class="picker__empty muted">No network matches that.</li>');
        refresh();
      }

      list.addEventListener('change', (event) => {
        const pick = event.target.closest('[data-pick]');
        if (!pick) return;
        const id = pick.dataset.pick;
        if (pick.checked) picked.set(id, slots.get(id));
        else picked.delete(id);
        // Updated in place, NOT repainted. A repaint here replaces every row, which
        // throws away the picker's scroll position and the focused element — so
        // ticking the third of ten networks scrolled the list back to the top before
        // the fourth could be reached. Only two things actually follow the checkbox.
        const row = list.querySelector(`[data-row="${CSS.escape(id)}"]`);
        if (row) {
          row.classList.toggle('is-on', pick.checked);
          const field = row.querySelector('[data-slot]');
          if (field) field.disabled = !pick.checked;
        }
        refresh();
      });

      list.addEventListener('input', (event) => {
        const slot = event.target.closest('[data-slot]');
        if (!slot) return;
        const id = slot.dataset.slot;
        slots.set(id, slot.value);
        if (picked.has(id)) picked.set(id, slot.value);
        // Not a repaint: that would blur the field mid-typing.
        refresh();
      });

      search.addEventListener('input', paint);
      body.querySelector('[data-close]').addEventListener('click', close);

      const copy = async (text, what, field) => {
        try {
          await navigator.clipboard.writeText(text);
          toast.ok(`${what} copied.`);
        } catch {
          // A blocked clipboard (insecure origin, or a declined permission) must not
          // dead-end: select the text so Ctrl+C still works.
          field.focus();
          field.select();
          toast.error('Could not reach the clipboard — the text is selected, press Ctrl+C.');
        }
      };
      copyPrompt.addEventListener('click', () =>
        copy(connectPromptFor(entries(), source), 'Prompt', promptBox));

      paint();
    },
  });
}

/**
 * Open the dialog, optionally with one network already ticked.
 *
 * The candidate list is read fresh rather than taken from the caller: the row in the
 * network list does not carry the descriptions the prompt includes, and a network
 * someone else just launched should be selectable without a refresh first.
 */
export async function openLinkPrompt(preselect = [], source = null) {
  // One id or many: the row action passes a string, the list's selection an array.
  const ids = (Array.isArray(preselect) ? preselect : [preselect]).filter(Boolean);
  let deployments = [];
  try {
    deployments = await api.list();
  } catch (error) {
    toast.error(`Could not load the network list — ${error.message}`);
    return;
  }
  // Only networks with a live URL can be referenced at all. When the flow started
  // from a specific network, the same two exclusions the list already applied are
  // applied here too — a dialog that re-offered the source, or something it already
  // calls, would contradict the screen it was opened from.
  const origin = (url) => {
    try {
      const u = new URL(String(url));
      return `${u.protocol}//${u.host}`;
    } catch { return ''; }
  };
  const linked = new Set((source?.network?.links || [])
    .map((link) => origin(link.target)).filter(Boolean));
  const candidates = deployments.filter((dep) => peerReference(dep)
    && dep.id !== source?.id
    && !linked.has(origin(dep.url)));
  if (!candidates.length) {
    toast.error(source
      ? `There is no other live network for ${displayName(source.name)} to call yet.`
      : 'No network has a live URL to link to yet. Start one and try again.');
    return;
  }
  showConnectPrompt(candidates, ids, source);
}
