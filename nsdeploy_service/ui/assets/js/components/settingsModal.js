/**
 * The viewer's own LLM key, plus the deploy defaults every Launch sends along —
 * the BYOK upstream and deploy-time theming. All of it is saved server-side to
 * this checkout's `.env` (POST /settings) rather than in the browser, so it
 * survives a restart and is available to the next `python -m nsdeploy_service`
 * too — see views/deploy.js, which reads the three deploy defaults back out of
 * this same GET /settings to attach to every Launch request.
 *
 * Only the LLM key is offered. The NSDeploy API token is the credential the
 * service checks on every request, so letting the console change it would let a
 * visitor lock the operator out of their own deployment; it belongs to whoever
 * runs the service, set in the admin panel or via NSDEPLOY_SERVICE_API_TOKEN.
 *
 * The key is a secret: the server never sends the real value back, only whether
 * one is set and its last 4 characters (GET /settings). That masked string seeds
 * the field so a viewer can recognize that a key is already configured without it
 * being legible in full, and is discarded — not sent back — unless they actually
 * edit it. The deploy defaults are not secrets, so GET /settings returns them
 * verbatim and the field just shows them.
 */
import { api } from '../api/client.js';
import { toast } from './toast.js';
import { esc, render } from '../util/dom.js';
import { openModal } from './modal.js';

// Both credentials belong to whoever runs the service, not to the viewer: shown
// masked and read-only, never editable.
//
// Shown rather than hidden because the masked value answers a real question — which
// credential is this service actually using? For the API token the console reports
// `settings.api_token`, the same value `require_token` compares a request against
// (see app.py::_settings_view), so a value appearing here means the service is
// honouring it, which is exactly what makes the field worth having.
//
// Not editable because neither is the viewer's to change: altering the API token from
// the console could lock the operator out of their own deployment, and a saved LLM key
// would be replaced the next time the admin panel re-applies its stored default. Both
// are set by the operator in the admin panel under API & LLM keys.
const SECRET_FIELDS = [
  {
    key: 'nsdeploy_api_token',
    label: 'NSDeploy API token',
    hint: 'In use by this service. Set by the organiser - you cannot change it here.',
  },
  {
    key: 'openai_api_key',
    label: 'LLM key',
    hint: 'Provided by the organiser - you do not need to enter one.',
  },
];

const BOOL_FIELDS = [
  {
    key: 'theme',
    label: 'Enable deploy-time theming',
    hint: 'Runs an LLM pass over each network at deploy time (needs the OpenAI key '
      + 'above; adds minutes to the build). NSDEPLOY_SERVICE_THEME.',
  },
  {
    key: 'theme_refresh',
    label: 'Refresh theme on every deploy',
    hint: 'Re-asks the LLM instead of reusing a theme already on disk. Only does '
      + 'anything while theming above is on. NSDEPLOY_SERVICE_THEME_REFRESH.',
  },
];

const TEXT_FIELDS = [
  {
    key: 'upstream',
    label: 'BYOK proxy upstream',
    placeholder: 'https://api.openai.com/v1',
    hint: 'Where each deployed site relays /byok/v1 to (NSDEPLOY_SERVICE_UPSTREAM).',
  },
  {
    key: 'theme_model',
    label: 'Theme model',
    placeholder: 'gpt-4o',
    hint: 'Model used when deploy-time theming is on (NSDEPLOY_SERVICE_THEME_MODEL).',
  },
  // 'theme_prompt' is deliberately absent. It seeded a design instruction into every
  // new Launch, which is confusing where each network is themed individually from its
  // own row in the network list — a participant would see design they did not ask for
  // and have no way to tell where it came from.
  //
  // Hidden here, not removed: NSDEPLOY_SERVICE_THEME_PROMPT still works, deploy.js
  // still forwards whatever GET /settings returns, and the per-deployment prompt in
  // the network list is unaffected. An operator who does want one house style for
  // everything can still set it on the server.
];

function seedFor(info) {
  return info?.is_set ? `${'•'.repeat(8)}${info.last4}` : '';
}

function renderSettingsModal(current) {
  openModal({
    title: 'API settings',
    render(body, close) {
      render(body, `
        <p class="field__hint">
          Saved to this checkout's <code>.env</code>, so it does not need retyping
          next time the service starts.
        </p>
        <p class="modal__subhead">Credentials</p>
        ${SECRET_FIELDS.map(({ key, label, hint }) => {
          const seed = seedFor(current[key]);
          // readonly rather than disabled: the masked value stays legible and
          // selectable, which is the whole reason for showing it, where a disabled
          // field reads as "broken" and greys the text out.
          return `
            <div class="field">
              <label class="field__label" for="d-settings-${key}">${esc(label)}</label>
              <input class="input" id="d-settings-${key}" readonly
                     value="${esc(seed)}"
                     placeholder="${current[key]?.is_set ? '' : 'Not set'}"
                     autocomplete="off" spellcheck="false"
                     aria-describedby="d-settings-${key}-hint">
              <p class="field__hint" id="d-settings-${key}-hint">${esc(hint)}</p>
            </div>`;
        }).join('')}

        <p class="modal__subhead">Deploy defaults</p>
        ${BOOL_FIELDS.map(({ key, label, hint }) => `
          <div class="field">
            <label class="switch">
              <input type="checkbox" id="d-settings-${key}" data-bool="${esc(key)}"
                     ${current[key] ? 'checked' : ''}>
              ${esc(label)}
            </label>
            <p class="field__hint">${esc(hint)}</p>
          </div>`).join('')}
        ${TEXT_FIELDS.map(({ key, label, placeholder, hint }) => `
          <div class="field">
            <label class="field__label" for="d-settings-${key}">${esc(label)}</label>
            <input class="input" id="d-settings-${key}" data-text="${esc(key)}"
                   value="${esc(current[key] || '')}" placeholder="${esc(placeholder)}"
                   autocomplete="off" spellcheck="false">
            <p class="field__hint">${esc(hint)}</p>
          </div>`).join('')}

        <div class="modal__foot">
          <button type="button" class="btn btn--secondary" data-close>Cancel</button>
          <button type="button" class="btn btn--primary" id="d-settings-save">Save</button>
        </div>`);

      const textInputs = [...body.querySelectorAll('input[data-text]')];
      const boolInputs = [...body.querySelectorAll('input[data-bool]')];
      body.querySelector('[data-close]').addEventListener('click', close);

      // No secret collection: credentials are read-only here, so a save can only ever
      // carry the deploy defaults. The focus-to-clear behaviour the masked seed used
      // to need went with it — there is nothing to type over.
      body.querySelector('#d-settings-save').addEventListener('click', async () => {
        const patch = {};
        // Deploy defaults are not secrets — the console was given the real value,
        // so it always sends what is currently in the field, changed or not.
        textInputs.forEach((input) => { patch[input.dataset.text] = input.value.trim(); });
        boolInputs.forEach((input) => { patch[input.dataset.bool] = input.checked; });

        try {
          await api.updateSettings(patch);
          // No auth.set() here any more: this dialog no longer offers the NSDeploy
          // API token, so a save cannot invalidate the token this tab is holding.
          toast.ok('Settings saved.');
          close();
        } catch (error) {
          toast.error(`Could not save settings — ${error.message}`);
        }
      });
    },
  });
}

/** Open the dialog on demand — the gear button in the topbar. */
export async function openSettings() {
  let current;
  try {
    current = await api.getSettings();
  } catch (error) {
    toast.error(`Could not load settings — ${error.message}`);
    return;
  }
  renderSettingsModal(current);
}

/**
 * Called once at boot. Says so when a credential the viewer depends on is missing.
 *
 * It used to open the settings dialog instead. That was right while the dialog could
 * fix the problem; now that credentials are read-only and owned by the operator, a
 * dialog would present a viewer with something they have no means to solve. So this
 * reports it and names who can — a persistent error toast rather than a modal, because
 * it is information to act on, not a step to complete before using the console.
 *
 * Deliberately not silent. A missing key does not fail loudly on its own: networks
 * still deploy, they just come out with the default look and their chat cannot reach a
 * provider, which reads as "the app is broken" long before anyone suspects a
 * credential.
 */
export async function promptForMissingCredentials() {
  let current;
  try {
    current = await api.getSettings();
  } catch {
    return; // Service not reachable yet — the health poll reports that; don't also nag here.
  }
  const missing = SECRET_FIELDS.filter(({ key }) => !current[key]?.is_set);
  if (!missing.length) return;
  const names = missing.map(({ label }) => label).join(' and ');
  toast.error(`No ${names} is configured. Networks will still deploy, but theming `
    + `and chat need one. Ask an administrator to set it in the admin panel.`);
}
