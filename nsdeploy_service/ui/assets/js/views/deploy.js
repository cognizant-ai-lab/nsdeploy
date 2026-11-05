/**
 * Launch view: confirm an organization, drop a HOCON, press Launch.
 *
 * Three deliberate constraints, because the people using this are not deploying
 * software for a living:
 *
 *   · Two fields, no options. Everything else nsdeploy accepts (network name, TTL,
 *     BYOK upstream, CRUSE, LLM theming) comes from the service defaults. The API
 *     still takes all of them for scripted callers — see API_CONTRACT.md — so
 *     nothing was removed, only taken off this screen.
 *   · The organization is asked once, in a modal, not typed into this form every
 *     time. `org_name` is get-or-create server-side, so a first-time operator
 *     never has to create a profile before their first upload — they just answer
 *     the modal — and the answer is remembered in this browser (see util/org.js)
 *     so it is never asked again unless "Change organization" is clicked.
 *   · Launch opens a progress dialog and, when the site answers, the map in a new
 *     tab focused on the new pin. Between pressing Launch and the site answering
 *     there is nothing to do and nothing to decide, so the dialog owns that wait —
 *     it cannot be missed or scrolled past, and it is the only place a failed build
 *     can be reported, since a failed deployment has no pin to carry the error.
 */
import { api, ApiError } from '../api/client.js';
import { toast } from '../components/toast.js';
import { $, icon, onClick, render } from '../util/dom.js';
import { bytes } from '../util/format.js';
import { errorNote } from '../components/widgets.js';
import { showDeployProgress } from '../components/deployProgressModal.js';
import { networkArt } from '../components/networkArt.js';
import { ensureOrg, promptForOrg } from '../components/orgModal.js';
import { deploymentsChanged } from '../util/deployments.js';
import { getOrg } from '../util/org.js';
import { acceleratorLink } from '../components/acceleratorLink.js?v=120';

const MAX_BYTES = 512 * 1024;
const ACCEPTED = /\.(hocon|conf)$/i;

export function mount(root, { onLaunched } = {}) {
  render(root, template());
  wireDropzone(root);

  showOrg(root);
  $('#d-org-change', root).addEventListener('click', () => {
    promptForOrg({ onSaved: () => showOrg(root) });
  });
  // Nothing to launch against without one: ask immediately if this browser has
  // never been told an organization before.
  ensureOrg(() => showOrg(root));

  $('#d-form', root).addEventListener('submit', (event) => {
    event.preventDefault();
    launch(root, onLaunched);
  });

  // Delegated: the error panel is re-rendered on every attempt.
  onClick(root, '[data-retry]', () => {
    render($('#d-error', root), '');
    $('#d-file', root).focus();
  });

  return { refresh() { /* nothing to poll: this screen owns no server state */ } };
}

function template() {
  return `
  <section class="launch">
    <!-- Scenery: the thing being deployed, behind the thing that deploys it. Never
         focusable and never announced — see components/networkArt.js. -->
    <div class="launch__art" aria-hidden="true">${networkArt()}</div>

    <div class="launch__intro">
      <span class="launch__kicker">${icon('sitemap', { size: 14 })}<span>Agent network deployment</span></span>
      <h2 class="launch__title">Put your agent network on the map</h2>
      <p class="launch__lede">
        Tell us who you are, drop in your network file, and press Launch. It is
        hosted for you and appears on the shared map straight away.
      </p>
      ${acceleratorLink()}
    </div>

    <form class="card card--brand launch__card" id="d-form" novalidate>
      <div class="card__body launch__body">
        <div class="field">
          <label class="field__label launch__label" for="d-org">
            <span class="launch__num" aria-hidden="true">1</span>
            Your organization
          </label>
          <div class="launch__orgrow">
            <input class="input input--lg" type="text" id="d-org" readonly tabindex="-1"
                   aria-describedby="d-org-hint">
            <button type="button" class="btn btn--ghost" id="d-org-change">Change organization</button>
          </div>
          <p class="field__error" id="d-org-error" hidden></p>
          <p class="field__hint" id="d-org-hint">
            Used to label your network on the map. New names are created for you.
          </p>
        </div>

        <div class="field">
          <span class="field__label launch__label">
            <span class="launch__num" aria-hidden="true">2</span>
            Your network file
          </span>
          <label class="dropzone dropzone--lg" id="d-drop">
            <input type="file" id="d-file" accept=".hocon,.conf,text/plain" required
                   aria-describedby="d-drop-meta">
            <span class="dropzone__icon" aria-hidden="true">${icon('upload', { size: 34 })}</span>
            <span class="dropzone__main" id="d-drop-main">Drag your file here</span>
            <span class="dropzone__meta" id="d-drop-meta">or click to browse · .hocon up to 512 KB</span>
          </label>
          <p class="field__error" id="d-file-error" hidden></p>
        </div>

        <div id="d-error" aria-live="polite"></div>
      </div>

      <div class="card__foot launch__foot">
        <button type="submit" class="btn btn--primary btn--block btn--xl" id="d-submit">
          ${icon('rocket', { size: 19 })}<span>Launch</span>
        </button>
        <p class="launch__note">Takes about 20 seconds. You can watch it on the map.</p>
      </div>
    </form>
  </section>`;
}

/** Reflect the remembered organization into the readonly display field. */
function showOrg(root) {
  $('#d-org', root).value = getOrg();
  clearFieldError(root, 'd-org');
}

/* ── field-level validation ─────────────────────────────────────────────────
 * Beside the field, not only in a toast.
 *
 * A toast lands in the corner of the screen while the operator is looking at the
 * button they just pressed, and it says nothing about *which* field is wrong. On a
 * two-field form that reads as "I clicked Launch and nothing happened" — which is
 * exactly how this was reported. So a rejected submit now marks the field itself,
 * persistently, and the toast is only the announcement.
 */
function setFieldError(root, id, message) {
  const field = $(`#${id}`, root);
  const slot = $(`#${id}-error`, root);
  if (!field || !slot) return;
  slot.textContent = message;
  slot.hidden = false;
  field.setAttribute('aria-invalid', 'true');
  // Point the field's description at the complaint so a screen reader reads the
  // reason on focus, not just the hint it violates.
  field.setAttribute('aria-describedby', `${id}-error`);
}

function clearFieldError(root, id) {
  const field = $(`#${id}`, root);
  const slot = $(`#${id}-error`, root);
  if (!field || !slot) return;
  slot.hidden = true;
  slot.textContent = '';
  field.removeAttribute('aria-invalid');
  field.setAttribute('aria-describedby', id === 'd-org' ? 'd-org-hint' : 'd-drop-meta');
}

/* ── file input ─────────────────────────────────────────────────────────── */
const IDLE_MAIN = 'Drag your file here';
const IDLE_META = 'or click to browse · .hocon up to 512 KB';

/**
 * Reject an over-sized or wrong-suffix file here rather than letting the upload
 * fail server-side: the operator finds out while looking at the file they picked,
 * not after pressing Launch.
 */
function fileProblem(file) {
  if (!file) return '';
  if (file.size > MAX_BYTES) {
    return `That file is ${bytes(file.size)}. The limit is ${bytes(MAX_BYTES)}.`;
  }
  if (!ACCEPTED.test(file.name)) {
    return `“${file.name}” is not a network file. Look for one ending in .hocon.`;
  }
  return '';
}

function describeDropzone(root) {
  const zone = $('#d-drop', root);
  const file = $('#d-file', root).files[0];
  const problem = fileProblem(file);

  zone.classList.toggle('has-file', Boolean(file) && !problem);
  zone.classList.toggle('is-bad', Boolean(problem));
  $('#d-drop-main', root).textContent = file ? file.name : IDLE_MAIN;
  $('#d-drop-meta', root).textContent = problem || (file ? bytes(file.size) : IDLE_META);
  // A bad file is already explained inside the zone, so the separate slot is only
  // for "you have not chosen one at all".
  if (file) clearFieldError(root, 'd-file');
  // Deliberately never disable Launch: a disabled button that does nothing when
  // clicked is the same dead end this whole change is fixing. The submit path
  // rejects the file and says why.
}

function resetDropzone(root) {
  $('#d-file', root).value = '';
  describeDropzone(root);
}

function wireDropzone(root) {
  const zone = $('#d-drop', root);
  const input = $('#d-file', root);

  input.addEventListener('change', () => describeDropzone(root));
  ['dragenter', 'dragover'].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('is-over');
    }));
  ['dragleave', 'drop'].forEach((type) =>
    zone.addEventListener(type, () => zone.classList.remove('is-over')));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    const [file] = event.dataTransfer.files;
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    describeDropzone(root);
  });
}

/** Swaps a .hocon/.conf filename for a .txt one before it goes over the wire —
 * some corporate proxies block uploads by that extension, but the server parses
 * the content as HOCON regardless of what the file is named. */
function toUploadFilename(originalName) {
  return /\.(hocon|conf)$/i.test(originalName)
    ? originalName.replace(/\.(hocon|conf)$/i, '.txt')
    : originalName;
}

/* ── launch ─────────────────────────────────────────────────────────────── */
async function launch(root, onLaunched) {
  const button = $('#d-submit', root);
  const file = $('#d-file', root).files[0];
  const org = getOrg();

  render($('#d-error', root), '');
  clearFieldError(root, 'd-file');

  // The org field is read-only and backed by the modal, so a missing org is not
  // something the operator can fix by looking at this field — reopen the modal
  // that fixes it instead of marking a field they cannot type into.
  if (!org) {
    promptForOrg({ onSaved: () => showOrg(root) });
    return;
  }

  const problem = fileProblem(file);
  const fileFault = !file ? 'Choose the .hocon file for your network.' : problem;

  if (fileFault) {
    setFieldError(root, 'd-file', fileFault);
    // Focus the field so keyboard users land on it, and the page scrolls to it if
    // the button was reached by scrolling past it.
    const field = $('#d-file', root);
    field.focus();
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast.error(fileFault);
    return;
  }

  button.disabled = true;
  button.innerHTML = `<span class="spin" aria-hidden="true">${icon('refresh', { size: 17 })}</span><span>Launching…</span>`;

  // The deploy defaults set in API settings (upstream, theme, theme model, theme
  // refresh, theme prompt) — fetched fresh on every Launch rather than cached at
  // mount, so a change made in that dialog a moment ago is what this deployment
  // actually gets. Left off the request on failure to reach /settings: the server
  // still applies its own configured defaults either way.
  let deployDefaults = {};
  try {
    const settings = await api.getSettings();
    deployDefaults = {
      upstream: settings.upstream || '',
      theme: Boolean(settings.theme),
      theme_model: settings.theme_model || '',
      theme_refresh: Boolean(settings.theme_refresh),
      theme_prompt: settings.theme_prompt || '',
    };
  } catch { /* fall through with no overrides */ }

  const form = new FormData();
  const uploadName = toUploadFilename(file.name);
  form.append('file', file, uploadName);
  form.append('org_name', org);
  // Agentic City hosts browser-only bundles on its own /sites/{network_name}/ path. The
  // port mode remains available to scripted API callers that need Python tools.
  form.append('deployment_mode', 'static_bundle');
  if (deployDefaults.upstream) form.append('upstream', deployDefaults.upstream);
  if (deployDefaults.theme_model) form.append('theme_model', deployDefaults.theme_model);
  if ('theme' in deployDefaults) form.append('theme', String(deployDefaults.theme));
  if ('theme_refresh' in deployDefaults) {
    form.append('theme_refresh', String(deployDefaults.theme_refresh));
  }
  if (deployDefaults.theme_prompt) form.append('theme_prompt', deployDefaults.theme_prompt);

  try {
    const view = await api.deploy(form);
    resetDropzone(root);
    // Under AUTOPUBLISH (the default) the pin exists from this moment, in `queued`
    // — so tell the map now rather than letting its slow poll decide when the
    // launch becomes visible. Announced again when the build settles, because the
    // status the pin renders changes then too.
    deploymentsChanged();
    // The dialog takes it from here: it watches the build and opens the map. This
    // screen is left clean and ready for the next upload.
    showDeployProgress(view, {
      onSettled: () => {
        deploymentsChanged();
        onLaunched?.(view);
      },
    });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : String(error);
    render($('#d-error', root), `${errorNote(message)}
      <div class="btnrow">
        <button type="button" class="btn btn--secondary" data-retry>
          ${icon('refresh', { size: 14 })}<span>Pick another file</span>
        </button>
      </div>`);
    toast.error(message);
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon('rocket', { size: 19 })}<span>Launch</span>`;
  }
}
