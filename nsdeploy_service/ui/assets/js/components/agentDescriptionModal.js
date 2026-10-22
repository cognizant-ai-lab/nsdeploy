/**
 * "What this network does" — the one screen that explains a deployed agent
 * network to someone who did not build it.
 *
 * This is the only action in the network list offered on *every* row, including
 * other organizations' (see views/networks.js), which sets what it has to be: a
 * reader's page, not an operator's readout. Someone arrives asking "what is this
 * thing, and should I send a question to it — or link my own network to it?" So
 * it answers in that order:
 *
 *   1. what it is for          the description, in prose, as the lead
 *   2. what to say to it       its sample queries, quoted, because a concrete
 *                              question explains a network faster than a noun
 *                              phrase about it ever does
 *   3. where it is weak        demo-mode agents and dropped tools
 *   4. what it can reach       tools and linked networks — its actual reach
 *   5. go and use it           the live site
 *
 * (3) sits above (4) because of how far the dialog scrolls: a reader deciding
 * whether to trust an answer needs the caveat, and the plumbing is what they
 * scroll for if they care. Ordering the wiring first put the one warning on the
 * screen below the fold, which is the same as not showing it.
 *
 * (4) is not buried. `demo_mode_agents` means those agents *fabricate plausible
 * answers instead of using real data* — nsdeploy's own build report says so in
 * capitals. A reader deciding whether to trust an answer needs that in words, so
 * it is a stated caveat rather than one more chip in a row of chips.
 *
 * The summary comes from the DeploymentView the caller already holds. The agent
 * roster does not: each agent's authored purpose lives in the generated bundle
 * and is read back by `GET /deployments/{id}/graph`, so that one list is fetched
 * after the dialog is already on screen. It arrives into a slot rather than
 * blocking the open — the description above it is the headline, and a reader
 * should not wait on a roster to see it.
 */
import { api, ApiError } from '../api/client.js';
import { esc, icon, render } from '../util/dom.js';
import { displayName } from '../util/format.js';
import { statusPill } from './widgets.js';
import { openModal } from './modal.js';

export function showAgentDescriptionModal(dep) {
  const network = dep.network || {};
  const name = displayName(dep.name);
  openModal({
    title: network.brand?.trim() || name,
    size: 'lg',
    render(body, close) {
      render(body, `
        <div class="netdesc">
          <p class="netdesc__meta">
            ${statusPill(dep.status)}
            <span>${esc(dep.org_name?.trim() || 'Unattributed')}</span>
            ${network.agent_count
              ? `<span>${network.agent_count} agent${network.agent_count === 1 ? '' : 's'}</span>`
              : ''}
          </p>

          ${lead(network, name)}
          ${queries(network)}
          ${caveats(network)}
          <section class="netdesc__section" id="netdesc-agents">
            <h3 class="netdesc__head">
              The agents${network.agent_count ? ` (${network.agent_count})` : ''}
            </h3>
            <p class="netdesc__hint">Reading what each one is for…</p>
          </section>
          ${reach(network)}
        </div>
        ${footer(dep)}`);
      // `data-close`, not `data-modal-close`: modal.js reaches for the first
      // element with the latter to wire and to hide its header × , so reusing it
      // here would hand that one button two jobs and leave this one dead.
      body.querySelector('[data-close]').addEventListener('click', close);
      fillAgents(body, dep);
    },
  });
}

/** The description, given the room to be read. */
function lead(network, name) {
  const text = network.description?.trim();
  if (!text) {
    return `<p class="netdesc__lead netdesc__lead--empty">
      ${esc(name)} did not declare a description in its HOCON, so there is nothing
      authored to show here. What it can reach is below.
    </p>`;
  }
  return `<p class="netdesc__lead">${esc(text)}</p>`;
}

/**
 * Sample queries, as questions rather than as a bulleted list of strings.
 *
 * These are the network's own declared examples, so they are the closest thing
 * to a demonstration available without sending it a message — which is why they
 * sit directly under the description instead of at the bottom with the metadata.
 */
function queries(network) {
  const items = (network.sample_queries || []).filter((query) => query?.trim());
  if (!items.length) return '';
  return `
    <section class="netdesc__section">
      <h3 class="netdesc__head">Try asking</h3>
      <ul class="netdesc__queries">
        ${items.map((query) => `<li>${esc(query.trim())}</li>`).join('')}
      </ul>
    </section>`;
}

/**
 * The agent roster, as an accordion — the richest description the HOCON holds.
 *
 * A network's own `description` is one paragraph about the whole thing, but
 * every agent inside it carries its own authored purpose (`function.description`
 * in the resolved network, 200–350 characters of real prose in practice). That
 * is what actually explains a 15-agent network, and it is also far too much to
 * put on screen at once — hence `<details>`, which is the platform's own
 * disclosure widget: keyboard-operable, findable by the browser's in-page
 * search even while collapsed, and needing no JavaScript to work.
 *
 * The front-man opens by default. It is the agent that answers first, so its
 * purpose is the one a reader needs; the rest are there when they want to know
 * who it delegates to.
 */
async function fillAgents(body, dep) {
  const slot = body.querySelector('#netdesc-agents');
  if (!slot) return;
  let nodes;
  try {
    ({ nodes } = await api.agentGraph(dep.id));
  } catch (error) {
    // 409 is the documented "this network has no topology yet" — a build that
    // never finished. Anything else is a real failure, and both end the same
    // way for a reader: say so plainly instead of leaving a spinner.
    const status = error instanceof ApiError ? error.status : 0;
    slot.innerHTML = `<p class="netdesc__hint">${
      status === 409
        ? 'Its agents are not readable yet — this network has not produced a build.'
        : `Could not read its agents — ${esc(messageOf(error))}`
    }</p>`;
    return;
  }

  // Front-man first, then the agents that delegate, then the leaves; endpoints
  // last. Within a group, declaration order — the author's own ordering.
  const rank = { root: 0, orchestrator: 1, agent: 2, external: 3 };
  const agents = [...(nodes || [])].sort(
    (a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9),
  );
  if (!agents.length) {
    slot.innerHTML = '<p class="netdesc__hint">No agents were recorded for this network.</p>';
    return;
  }

  slot.innerHTML = `
    <h3 class="netdesc__head">The agents (${agents.length})</h3>
    <div class="netdesc__agents">
      ${agents.map((node) => agentRow(node)).join('')}
    </div>`;
}

function agentRow(node) {
  const open = node.kind === 'root' ? ' open' : '';
  const calls = node.calls?.length
    ? `<p class="netdesc__calls">Delegates to ${chips(node.calls)}</p>`
    : '';
  const text = node.description?.trim();
  return `
    <details class="netdesc__agent"${open}>
      <summary>
        <span class="netdesc__agentname">${esc(node.name)}</span>
        ${kindBadge(node.kind)}
        ${node.calls?.length
          ? `<span class="netdesc__agentmeta">${node.calls.length} ${
              node.calls.length === 1 ? 'call' : 'calls'}</span>`
          : ''}
      </summary>
      <div class="netdesc__agentbody">
        ${text
          ? `<p>${esc(text)}</p>`
          : '<p class="netdesc__hint">Its HOCON entry declares no description.</p>'}
        ${calls}
      </div>
    </details>`;
}

/** What the agent is in the network's shape, in a word a reader can act on. */
function kindBadge(kind) {
  const label = {
    root: 'answers first',
    orchestrator: 'delegates',
    agent: 'does the work',
    external: 'endpoint',
  }[kind];
  if (!label) return '';
  return `<span class="netdesc__kind netdesc__kind--${esc(kind)}">${esc(label)}</span>`;
}

/** What the network can actually reach beyond its own agents. */
function reach(network) {
  const rows = [
    factRow('Front-man', network.front_man
      ? `<code>${esc(network.front_man)}</code>`
      : '', 'The agent that answers first and delegates.'),
    factRow('Tools it runs', chips(network.hostable_tools),
      'Hosted locally with the network, as MCP servers.'),
    factRow('External services', chips(network.external_mcps),
      'Reached over the network at request time.'),
    factRow('Linked networks', links(network.links),
      'Other agent networks this one can call.'),
  ].filter(Boolean);
  if (!rows.length) return '';
  return `
    <section class="netdesc__section">
      <h3 class="netdesc__head">How it works</h3>
      <dl class="netdesc__facts">${rows.join('')}</dl>
    </section>`;
}

/**
 * The two things that change how much an answer from here is worth.
 *
 * Phrased as consequences, not labels. "3 demo-mode agents" is a fact about the
 * build; "these three invent realistic answers" is what the reader needs.
 */
function caveats(network) {
  const demo = network.demo_mode_agents || [];
  const missing = network.missing_tools || [];
  if (!demo.length && !missing.length) return '';
  return `
    <section class="netdesc__section">
      <h3 class="netdesc__head">Worth knowing</h3>
      ${demo.length ? `
        <p class="netdesc__caveat">
          <strong>${demo.length} agent${demo.length === 1 ? '' : 's'} run in demo mode</strong>
          — ${demo.length === 1 ? 'it' : 'they'} produce realistic-looking answers
          without real data or tools behind them, so treat what
          ${demo.length === 1 ? 'it returns' : 'they return'} as illustrative:
          ${chips(demo)}
        </p>` : ''}
      ${missing.length ? `
        <p class="netdesc__caveat">
          <strong>${missing.length} tool${missing.length === 1 ? '' : 's'} could not be
          resolved</strong> and ${missing.length === 1 ? 'was' : 'were'} dropped from
          the deployed network, so anything depending on
          ${missing.length === 1 ? 'it' : 'them'} will not work: ${chips(missing)}
        </p>` : ''}
    </section>`;
}

function footer(dep) {
  const live = dep.url && dep.status === 'ready';
  return `
    <div class="modal__foot">
      ${live
        ? `<a class="btn btn--primary" href="${esc(dep.url)}" target="_blank" rel="noopener">
             ${icon('external', { size: 14 })}<span>Open the site</span>
           </a>`
        : `<span class="netdesc__offline">
             ${esc(displayName(dep.name))} is ${esc(dep.status)} — there is no live site to open.
           </span>`}
      <button type="button" class="btn btn--secondary" data-close>Close</button>
    </div>`;
}

function factRow(label, value, hint) {
  if (!value) return '';
  return `
    <div class="netdesc__fact">
      <dt>${esc(label)}</dt>
      <dd>${value}<span class="netdesc__hint">${esc(hint)}</span></dd>
    </div>`;
}

function chips(items) {
  const list = (items || []).filter((item) => item?.trim());
  if (!list.length) return '';
  return `<span class="netdesc__chips">${
    list.map((item) => `<code>${esc(item.trim())}</code>`).join('')
  }</span>`;
}

function messageOf(error) {
  return error instanceof ApiError ? error.message : String(error);
}

/** Linked networks by host, not by full URL — the origin is the identity, and a
 * full URL wraps badly and says less. */
function links(items) {
  const list = items || [];
  if (!list.length) return '';
  return `<span class="netdesc__chips">${
    list.map((link) => {
      let host = link.target;
      try { host = new URL(link.target).host; } catch { /* keep the raw value */ }
      const callers = link.callers?.length
        ? ` — called by ${link.callers.join(', ')}`
        : '';
      return `<a class="netdesc__link" href="${esc(link.target)}" target="_blank"
                 rel="noopener" title="${esc(link.reference)}${esc(callers)}">${esc(host)}</a>`;
    }).join('')
  }</span>`;
}
