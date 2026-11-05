/**
 * Authentication strategy — the seam where a real login replaces the shared token.
 *
 * Today the service authenticates with one shared bearer token (`API_TOKEN`), or
 * nothing at all on loopback. That is attribution-only security: any caller can act
 * on any organization's deployments.
 *
 * When a login mechanism arrives, only this module changes. Swap `headers()` for a
 * session cookie (return `{}` and set `credentials: 'include'` in the client) or an
 * OIDC access token, and point `challenge()` at the login screen. No view imports
 * anything from here, so nothing else needs touching.
 */

// sessionStorage, never localStorage: a shared secret should not outlive the tab.
const TOKEN_KEY = 'nsdeploy.token';

// One dialog shared by every concurrent 401. The console loads several views at
// once, so an unauthenticated first paint challenges from half a dozen requests in
// parallel; without this they would each raise their own asker.
let pending = null;

/** Ask for the token in-page.
 *
 * `window.prompt` is not universally available — it is a no-op in a sandboxed
 * iframe and in several embedded webviews, where it throws or returns null. The
 * console then never obtains a token and every view reports its own failure
 * ("prompt() is not supported"), which looks like an outage rather than a missing
 * credential. A <dialog> is part of the platform and works everywhere the rest of
 * this UI does.
 */
function ask() {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'auth-dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <h2>API token required</h2>
        <p>This deployment service is protected by a shared token — the value of
           <code>NSDEPLOY_SERVICE_API_TOKEN</code> (or <code>--api-token</code>)
           on the server.</p>
        <div class="field">
          <input class="input" type="password" name="token" autocomplete="off"
                 autofocus placeholder="Paste the token" aria-label="API token" />
        </div>
        <menu>
          <button class="btn btn--secondary" value="cancel" type="submit">Cancel</button>
          <button class="btn btn--primary" value="save" type="submit">Continue</button>
        </menu>
      </form>`;
    document.body.append(dialog);

    dialog.addEventListener('close', () => {
      const token = dialog.querySelector('input[name=token]').value.trim();
      dialog.remove();
      // Esc closes with an empty returnValue; treat that as a cancel.
      if (dialog.returnValue !== 'save' || !token) return resolve(false);
      sessionStorage.setItem(TOKEN_KEY, token);
      resolve(true);
    });

    dialog.showModal();
  });
}

export const auth = {
  /** Headers to merge into every API request. */
  headers() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  hasCredential() {
    return Boolean(sessionStorage.getItem(TOKEN_KEY));
  },

  /**
   * Adopt a token without the challenge dialog — used right after the settings
   * modal saves a new NSDEPLOY_SERVICE_API_TOKEN, so the tab that just set it does
   * not immediately 401 itself and get asked to re-enter the value it was just given.
   */
  set(token) {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  },

  /**
   * Called on a 401. Resolves true when a new credential was supplied and the
   * request should be retried. A future implementation redirects to a login view.
   */
  challenge() {
    if (!pending) pending = ask().finally(() => { pending = null; });
    return pending;
  },

  clear() {
    sessionStorage.removeItem(TOKEN_KEY);
  },
};
