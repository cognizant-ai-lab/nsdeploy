/**
 * Captures the organization an operator is working as.
 *
 * Asked once: the answer is remembered in this browser (see util/org.js) so
 * Launch, the map and the network list all pick it up without asking again.
 * Not dismissible on first run — Launch has nothing to attribute a deployment
 * to without it — but dismissible when reopened from "Change organization",
 * because there an existing value still stands if the operator backs out.
 */
import { esc, render } from '../util/dom.js';
import { openModal } from './modal.js';
import { getOrg, setOrg } from '../util/org.js';

export function promptForOrg({ onSaved } = {}) {
  const current = getOrg();
  openModal({
    title: current ? 'Change organization' : 'Your organization',
    dismissible: Boolean(current),
    render(body, close) {
      render(body, `
        <p class="field__hint">
          Used to label your networks on the map and group them in the network
          list. New names are created for you.
        </p>
        <div class="field">
          <label class="field__label" for="org-modal-input">Organization name</label>
          <input class="input input--lg" type="text" id="org-modal-input" maxlength="120"
                 value="${esc(current)}" placeholder="e.g. Acme Logistics"
                 autocomplete="organization" spellcheck="false">
          <p class="field__error" id="org-modal-error" hidden></p>
        </div>
        <div class="modal__foot">
          ${current ? '<button type="button" class="btn btn--secondary" data-close>Cancel</button>' : ''}
          <button type="button" class="btn btn--primary" id="org-modal-save">Save</button>
        </div>`);

      const input = body.querySelector('#org-modal-input');
      const error = body.querySelector('#org-modal-error');
      body.querySelector('[data-close]')?.addEventListener('click', close);

      const save = () => {
        const value = input.value.trim();
        if (!value) {
          error.textContent = 'Enter your organization name to continue.';
          error.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return;
        }
        const saved = setOrg(value);
        close();
        onSaved?.(saved);
      };

      input.addEventListener('input', () => {
        if (!error.hidden) { error.hidden = true; input.removeAttribute('aria-invalid'); }
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); save(); }
      });
      body.querySelector('#org-modal-save').addEventListener('click', save);
      input.focus();
    },
  });
}

/** Called once at Launch mount: ask only if nothing is remembered yet. */
export function ensureOrg(onSaved) {
  if (getOrg()) return;
  promptForOrg({ onSaved });
}
