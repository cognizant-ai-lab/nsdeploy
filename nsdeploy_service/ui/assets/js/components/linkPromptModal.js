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
 * WHAT IT ASKS FOR. One new agent per peer, with the peer's URL as that agent's
 * only tool — the shape that is known to work with a HOCON generator. nsdeploy reads
 * a full URL in `tools` as a peer agent network (resolve.py's `external_networks`),
 * and the service picks those up as `peer_urls` so they still draw on the map.
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
import { acceleratorLink } from './acceleratorLink.js?v=94';

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
 * The text a person pastes into whatever tool regenerates their HOCON.
 *
 * Kept to the three things that have to be true, with no explanation of why — the
 * reader is a code-generating tool, and the reasoning that used to be in here
 * (what makes a name a bindable slot, which error a bare URL produces) is context
 * for a person, not an instruction. It lives in this module's header instead.
 *
 * The one piece of emphasis worth its words is "exactly as written": a tool that
 * tidies the URL by dropping its path puts the operator straight back on the
 * "No published network named ..." error this whole feature exists to avoid.
 */
export function connectPromptFor(entries, source = null) {
  if (!entries.length) return '';
  const many = entries.length > 1;
  const subject = source?.name
    ? `my agent network "${source.name}"`
    : 'my agent network';

  return [
    `In the HOCON for ${subject}, add ${many ? 'these agents' : 'this agent'}. `
      + `Use the URLs exactly as written — the name on the end of each one is `
      + `required.`,
    '',
    // One instruction per peer, in the shape that is known to work with a HOCON
    // generator: name the agent to create, say what the target is for, then give
    // the URL last. The agent name is the editable field in the dialog, so
    // "Add a payments agent" is a rename away from "Add a bofa_credit_card_chooser
    // agent" — which is why that field is labelled for an agent, not a slot.
    //
    // The description is quoted rather than spliced into the sentence. With theming
    // on it is the LLM's tagline — "Official terms, clearer card choices" — a noun
    // phrase that reads wrong after a verb and starts with a capital mid-sentence.
    // Quoted, it stands as the network's own words and its case stops mattering.
    ...entries.map(({ dep, slot }) => {
      const summary = oneLiner(dep.network?.description);
      return `    Add a ${slot} agent, with this URL as its tool.`
        + (summary ? ` This network handles "${summary}".` : '')
        + ` ${peerReference(dep)}`;
    }),
    '',
    'Return the complete HOCON with everything else unchanged.',
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
          call. Paste the prompt into the tool that regenerates your HOCON, then
          upload it — the link is added to your network, not to theirs, so any
          organization's network can be a target. Every URL below already has the
          target network's name appended, which the runtime requires.
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
