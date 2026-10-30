/**
 * Confirm, then publish a network to the map.
 *
 * With AUTOPUBLISH on (the service default) a launch reaches the map on its own and
 * nothing calls this. It stays because AUTOPUBLISH can be turned off to restore the
 * draft → publish workflow, and because a network taken off the map with /unpublish
 * has to have a way back on. Putting a network on the shared map is outward-facing,
 * so it asks first and says what it will do.
 *
 * Lives here rather than in a view: it was previously exported from views/deploy.js,
 * which coupled the directory to the launch screen's internals.
 */
import { api } from '../api/client.js';
import { toast } from './toast.js';
import { esc, render } from '../util/dom.js';
import { displayName } from '../util/format.js';
import { openModal } from './modal.js';

export function confirmPublish(id, rawName, { onPublished } = {}) {
  // Callers pass the network's identifier; every sentence below is addressed to a
  // person, so they all use its readable form.
  const name = displayName(rawName);
  openModal({
    title: `Publish ${name}?`,
    render(body, close) {
      render(body, `
        <p class="field__hint">
          This adds <strong>${esc(name)}</strong> to the network map, where everyone
          using this service can see it and other networks can be related to it.
          It stays reachable at its own URL either way, and you can take it off the
          map again at any time.
        </p>
        <div class="modal__foot">
          <button type="button" class="btn btn--secondary" data-close>Cancel</button>
          <button type="button" class="btn btn--primary" id="d-publish-confirm">
            Publish to map
          </button>
        </div>`);
      body.querySelector('[data-close]').addEventListener('click', close);
      body.querySelector('#d-publish-confirm').addEventListener('click', async () => {
        try {
          await api.publish(id);
          toast.ok(`${name} is on the map.`);
          close();
          onPublished?.();
        } catch (error) {
          toast.error(`Could not publish ${name} — ${error.message}`);
        }
      });
    },
  });
}
