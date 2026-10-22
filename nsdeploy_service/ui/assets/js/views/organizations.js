/**
 * Organization profiles.
 *
 * These are attribution labels, not accounts — the service has one shared token,
 * so the UI says so plainly rather than implying a security boundary that is not
 * there. When login lands, this view becomes the admin surface for real accounts.
 */
import { api } from '../api/client.js';
import { toast } from '../components/toast.js';
import { $, esc, onClick, render } from '../util/dom.js';
import { emptyState } from '../components/widgets.js';

export function mount(root, { onChanged }) {
  render(root, template());

  $('#org-form', root).addEventListener('submit', (event) => {
    event.preventDefault();
    create(root, onChanged);
  });

  onClick(root, '[data-del-org]', (button) => remove(root, button.dataset.delOrg, onChanged));

  return { refresh: () => load(root) };
}

function template() {
  // Full-width stack rather than two columns: a four-column table carrying emails
  // and postal addresses overflows a half-width card and clips its own actions.
  return `
  <div class="stack">
    <form class="card" id="org-form" novalidate>
      <div class="card__head card__head--bordered">
        <div class="card__title">
          <h2>New organization</h2>
          <p class="muted">A quick profile so deployed networks can be attributed.</p>
        </div>
      </div>
      <div class="card__body">
        <div class="field-row">
          <div class="field">
            <label class="field__label" for="o-name">
              Name <span class="field__req" aria-hidden="true">*</span>
            </label>
            <input class="input" type="text" id="o-name" required maxlength="120"
                   placeholder="Acme Logistics" autocomplete="organization">
            <p class="field__hint">Must be unique.</p>
          </div>
          <div class="field">
            <label class="field__label" for="o-contact">Contact</label>
            <input class="input" type="text" id="o-contact" maxlength="200"
                   placeholder="team@acme.example">
            <p class="field__hint">Email or team channel.</p>
          </div>
        </div>
        <div class="field">
          <label class="field__label" for="o-address">Address</label>
          <input class="input" type="text" id="o-address" maxlength="500"
                 placeholder="1 Harbour Road, Lisbon" autocomplete="street-address">
        </div>
        <div class="note note--warn">
          <span class="note__glyph" aria-hidden="true">!</span>
          <div>A profile is a label, not a login. Everyone who can reach this service
               can see and stop any organization's deployments.</div>
        </div>
      </div>
      <div class="card__foot card__foot--end">
        <button type="submit" class="btn btn--primary">Create organization</button>
      </div>
    </form>

    <section class="card">
      <div class="card__head card__head--bordered">
        <div class="card__title"><h2>Organizations</h2></div>
      </div>
      <div class="card__body" id="org-body">
        <div class="stack">
          <div class="skeleton" style="width:60%"></div>
          <div class="skeleton" style="width:45%"></div>
        </div>
      </div>
    </section>
  </div>`;
}

async function load(root) {
  try {
    const orgs = await api.listOrgs();
    if (!orgs.length) {
      render($('#org-body', root), emptyState(
        'No organizations yet',
        'Create one above to attribute the agent networks you deploy.',
        'building',
      ));
      return;
    }
    render($('#org-body', root), `
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Contact</th>
              <th scope="col" class="num">Networks</th>
              <th scope="col" class="table__actions"></th>
            </tr>
          </thead>
          <tbody>${orgs.map(row).join('')}</tbody>
        </table>
      </div>`);
  } catch (error) {
    toast.error(`Could not load organizations — ${error.message}`);
  }
}

function row(org) {
  return `
  <tr>
    <td>
      <div class="cell-title">${esc(org.name)}</div>
      <div class="cell-sub"><span class="chip">${esc(org.id)}</span></div>
      ${org.address ? `<div class="cell-sub">${esc(org.address)}</div>` : ''}
    </td>
    <td>${esc(org.contact) || '<span class="muted">—</span>'}</td>
    <td class="num">${org.deployment_count}
      ${org.live_count ? `<div class="cell-sub">${org.live_count} live</div>` : ''}</td>
    <td class="table__actions">
      ${org.deployment_count === 0
        ? `<button class="btn btn--danger btn--sm" data-del-org="${esc(org.id)}">Delete</button>`
        : `<span class="muted" title="Remove its networks from the directory first">in use</span>`}
    </td>
  </tr>`;
}

async function create(root, onChanged) {
  const name = $('#o-name', root).value.trim();
  if (!name) return toast.error('An organization name is required.');
  try {
    const org = await api.createOrg({
      name,
      address: $('#o-address', root).value.trim(),
      contact: $('#o-contact', root).value.trim(),
    });
    toast.ok(`Created “${org.name}”.`);
    $('#org-form', root).reset();
    load(root);
    onChanged?.();
  } catch (error) {
    toast.error(error.message);
  }
}

async function remove(root, orgId, onChanged) {
  if (!window.confirm('Delete this organization profile?')) return;
  try {
    await api.deleteOrg(orgId);
    toast.ok('Organization deleted.');
    load(root);
    onChanged?.();
  } catch (error) {
    toast.error(error.message);
  }
}
