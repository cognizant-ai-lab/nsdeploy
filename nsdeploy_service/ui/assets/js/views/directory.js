/** Directory: every organization and the agent networks it has deployed. */
import { api } from '../api/client.js';
import { toast } from '../components/toast.js';
import { $, esc, hasIcon, icon, onClick, render } from '../util/dom.js';
import { age, displayName, isLive, timestamp } from '../util/format.js';
import { copyButton, emptyState, statTiles, statusPill } from '../components/widgets.js';
import { showNetworkGraphModal } from '../components/networkGraphModal.js';
import { confirmPublish } from '../components/publishModal.js';
import { deploymentsChanged } from '../util/deployments.js';
import { editDesign } from '../components/designStudio.js';

const REFRESH_MS = 5000;

let liveOnly = false;
let timer = null;

export function mount(root) {
  render(root, template());

  $('#dir-live', root).addEventListener('change', (event) => {
    liveOnly = event.target.checked;
    load(root);
  });
  $('#dir-refresh', root).addEventListener('click', () => load(root));

  onClick(root, '[data-view-graph]', (button) => {
    showNetworkGraphModal(button.dataset.viewGraph, button.dataset.viewName);
  });
  onClick(root, '[data-edit-theme]', (button) =>
    editDesign(button.dataset.editTheme, button.dataset.editThemeName,
      { onUpdated: () => load(root) }));
  onClick(root, '[data-stop]', (button) => act(button.dataset.stop, false, () => load(root)));
  onClick(root, '[data-purge]', (button) => act(button.dataset.purge, true, () => load(root)));
  onClick(root, '[data-restart]', (button) =>
    restart(button.dataset.restart, button, () => load(root)));
  // Publishing is outward-facing, so it confirms; unpublishing is reversible and
  // takes nothing down, so it does not.
  onClick(root, '[data-publish]', (button) => {
    confirmPublish(button.dataset.publish, button.dataset.publishName, {
      onPublished: () => {
        // The whole point of publishing is the pin, so announce it before
        // reloading this view — the map polls too slowly to find out on its own.
        deploymentsChanged();
        load(root);
      },
    });
  });
  onClick(root, '[data-unpublish]', async (button) => {
    const name = displayName(button.dataset.unpublishName);
    try {
      await api.unpublish(button.dataset.unpublish);
      toast.ok(`${name} is off the map. It is still deployed.`);
      deploymentsChanged();
      load(root);
    } catch (error) {
      toast.error(`Could not unpublish ${name} — ${error.message}`);
    }
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
    },
  };
}

function template() {
  return `
  <div class="stack">
    <div id="dir-stats"></div>
    <section class="card">
      <div class="card__head card__head--bordered">
        <div class="card__title">
          <h2>Deployed networks</h2>
          <p class="muted">Grouped by the organization that uploaded them.</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="dir-live"> Live only
        </label>
        <button class="btn btn--secondary btn--sm" id="dir-refresh">
          ${icon('refresh', { size: 14 })}<span>Refresh</span>
        </button>
      </div>
      <div class="card__body" id="dir-body">
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
    const data = await api.directory(liveOnly);
    render($('#dir-stats', root), statTiles([
      { label: 'Organizations', value: data.totals.organizations, icon: 'building' },
      { label: 'Networks', value: data.totals.deployments, foot: liveOnly ? 'live only' : 'all records', icon: 'grid' },
      { label: 'Live now', value: data.totals.ready, good: data.totals.ready > 0, foot: 'serving traffic', icon: 'rocket' },
    ]));

    // With `live_only`, an organization with nothing running is noise.
    const groups = liveOnly
      ? data.organizations.filter((group) => group.deployments.length)
      : data.organizations;

    if (!groups.length) {
      render($('#dir-body', root), emptyState(
        liveOnly ? 'Nothing is running' : 'No networks yet',
        liveOnly
          ? 'Deployments that have been stopped are hidden. Untick “Live only” to see them.'
          : 'Upload a HOCON from the Deploy tab to publish your first agent network.',
        liveOnly ? 'rocket' : 'grid',
      ));
      return;
    }
    render($('#dir-body', root), groups.map(group).join(''));
  } catch (error) {
    if (!quiet) toast.error(`Could not load the directory — ${error.message}`);
  }
}

function group({ organization, deployments }) {
  return `
  <section class="org-group">
    <header class="org-group__head">
      <span class="org-group__name">${esc(organization.name)}</span>
      <span class="org-group__meta">${esc(organization.contact || 'no contact')}${
        organization.address ? ` · ${esc(organization.address)}` : ''}</span>
      <span class="org-group__count">${deployments.length} network${
        deployments.length === 1 ? '' : 's'}</span>
    </header>
    ${deployments.length ? `
      <div class="table-scroll">
        <table class="table table--fixed">
          <colgroup>
            <col style="width:21%"><col style="width:13%">
            <col style="width:37%"><col style="width:29%">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Network</th>
              <th scope="col">Status</th>
              <th scope="col">URL</th>
              <th scope="col" class="table__actions">Actions</th>
            </tr>
          </thead>
          <tbody>${deployments.map(row).join('')}</tbody>
        </table>
      </div>`
      : `<p class="muted">No networks deployed.</p>`}
  </section>`;
}

/**
 * One icon-only row action.
 *
 * `title` supplies the hover text and `aria-label` the accessible name — both are
 * needed. A title alone is not reliably announced by screen readers, and an
 * icon-only control with no label is just an unlabelled button to them. The svg
 * itself is aria-hidden (see icon()), so the label is the only name.
 *
 * The label is written as the action, not the glyph: "Publish … to the map",
 * never "pin icon".
 */
export function iconAction(name, label, attrs, variant = '', fallback = '') {
  // Never render an empty button. If the glyph is missing — a typo, or a stale
  // cached dom.js without it — show a short word instead, so the control is still
  // visible and usable rather than an invisible dead square.
  const glyph = hasIcon(name)
    ? icon(name, { size: 17 })
    : `<span class="act__text">${esc(fallback || label.split(' ')[0])}</span>`;
  return `<button class="act ${variant}" type="button" ${attrs}
    title="${esc(label)}" aria-label="${esc(label)}">${glyph}</button>`;
}

function row(dep) {
  const live = isLive(dep.status);
  const endpoints = dep.endpoints || {};

  const url = dep.url
    ? `<div class="urlcell">
         <div class="urlcell__row">
           <a class="urlcell__link" href="${esc(dep.url)}" target="_blank" rel="noopener">
             ${esc(dep.url)}</a>
           ${copyButton(dep.url, '')}
         </div>
         ${endpoints.mcp_facade
           ? `<div class="endpoints"><code>${esc(endpoints.mcp_facade)}</code></div>` : ''}
       </div>`
    : '<span class="muted">—</span>';

  return `
  <tr>
    <td>
      <div class="cell-title">${esc(displayName(dep.name))}</div>
      ${displayName(dep.name) === dep.name
        // The identifier keeps its own line here, in code type. The directory is
        // where an operator goes to stop, restart or find a network's files, and
        // that is the name the HOCON, the URL and the logs all use — so it must
        // stay legible, just not be the only thing on the row.
        ? '' : `<div class="cell-sub"><code>${esc(dep.name)}</code></div>`}
      <div class="cell-sub" title="${esc(timestamp(dep.created_at))}">${esc(age(dep.created_at))}</div>
    </td>
    <td>
      <div class="cell-pills">
        ${statusPill(dep.status)}
        ${dep.published
          ? ''
          : '<span class="pill pill--draft" title="Deployed and testable, but not on the map yet">draft</span>'}
      </div>
      ${dep.warnings?.length
        ? `<div class="cell-sub" title="${esc(dep.warnings.join('\n'))}">
             ${dep.warnings.length} caveat${dep.warnings.length > 1 ? 's' : ''}</div>` : ''}
      ${dep.error ? `<div class="cell-sub">${esc(dep.error.split('\n')[0])}</div>` : ''}
    </td>
    <td>${url}</td>
    <td class="table__actions">
      <div class="table__actions-row">
        ${iconAction('sitemap', 'View network diagram',
          `data-view-graph="${esc(dep.id)}" data-view-name="${esc(dep.name)}"`)}
        ${iconAction('palette', `Change how ${displayName(dep.name)} looks`,
          `data-edit-theme="${esc(dep.id)}" data-edit-theme-name="${esc(dep.name)}"`)}
        ${dep.published ? '' : dep.publishable
          ? iconAction('pin', `Publish ${displayName(dep.name)} to the map`,
              `data-publish="${esc(dep.id)}" data-publish-name="${esc(dep.name)}"`,
              'act--accent')
          // Shown but disabled, carrying the server's own reason. Hiding it made
          // the option look absent rather than unavailable.
          : iconAction('pin',
              dep.publish_blocked_reason || 'Deploy this network before publishing it',
              'disabled')}
        ${dep.published
          ? iconAction('pinOff', 'Take off the map — the deployment keeps running',
              `data-unpublish="${esc(dep.id)}" data-unpublish-name="${esc(dep.name)}"`)
          : ''}
        ${live
          ? iconAction('stop',
              dep.published
                ? 'Stop this network — it also comes off the map until restarted'
                : 'Stop this network',
              `data-stop="${esc(dep.id)}"`, 'act--danger')
          : iconAction('refresh', 'Restart from the stored HOCON', `data-restart="${esc(dep.id)}"`)}
        ${live
          // Removal discards the logs and the uploaded HOCON, so it must not double
          // as "tear the running site down". Shown disabled with the reason.
          ? iconAction('trash', 'Stop this network before removing it', 'disabled')
          : iconAction('trash', 'Remove from the directory for good — discards its logs and uploaded HOCON',
              `data-purge="${esc(dep.id)}"`, 'act--danger')}
      </div>
    </td>
  </tr>`;
}

/**
 * Relaunch a stopped/failed deployment. No confirm dialog — this is additive, and
 * the row's own status pill reports progress as the 5s poll picks it up.
 *
 * Exported so the sidebar's flat Network list (views/networks.js) shares this
 * exact behavior — the confirm wording and the API call — rather than a second
 * copy of it drifting from this one.
 */
export async function restart(id, button, onDone) {
  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    const view = await api.restart(id);
    toast.ok(`Rebuilding ${displayName(view.name)} — this takes ~20s on a warm cache.`);
    // A restart puts a published network's pin back, so the map must not wait for
    // its own slow poll to find out.
    deploymentsChanged();
    onDone?.();
  } catch (error) {
    toast.error(error.message);
    button.disabled = false;
    button.textContent = 'Restart';
  }
}

/** Stop (purge = false) or permanently remove (purge = true) a deployment. Shared
 * with views/networks.js for the same reason as `restart` above. */
export async function act(id, purge, onDone) {
  const message = purge
    ? 'Remove this deployment from the directory? Its record, logs and uploaded HOCON are gone for good, so it cannot be restarted.'
    // Says what actually happens to the map, since a published network loses its
    // pin until it is restarted.
    : 'Stop this deployment? Its URL stops responding and it comes off the map until you restart it. The record stays in the directory.';
  if (!window.confirm(message)) return;
  try {
    await api.stop(id, purge);
    toast.ok(purge ? 'Deployment removed.' : 'Deployment stopped.');
    // Both take the pin off the map, so the map is told rather than left showing a
    // network that is no longer there.
    deploymentsChanged();
    onDone?.();
  } catch (error) {
    toast.error(error.message);
  }
}
