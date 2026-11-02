/**
 * A single reusable modal dialog. Only one is ever open — opening a second
 * closes the first, rather than stacking overlays.
 */
import { $, esc, icon } from '../util/dom.js';

let closeActive = null;

/**
 * @param {string} title - plain text; escaped before it reaches the DOM.
 * @param {'md'|'lg'} size
 * @param {boolean} dismissible - whether a click on the backdrop, Escape, or the
 *   close button may close it. Pass false for a dialog reporting work in progress:
 *   a stray click must not throw away the only report of how a build went. The
 *   caller keeps the returned `close` and is then the only thing that can close it,
 *   typically re-enabling dismissal once the work settles (see setDismissible).
 * @param {(body: HTMLElement, close: () => void) => (void | (() => void))} render
 *   Called once with the empty body to fill in. May return a cleanup function
 *   (e.g. to disconnect a ResizeObserver) run when the modal closes.
 * @returns {{ close: () => void, setDismissible: (value: boolean) => void }}
 */
export function openModal({ title, size = 'md', dismissible = true, render }) {
  closeModal();

  let canDismiss = dismissible;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal--${esc(size)}" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
      <div class="modal__head">
        <h2 id="modal-title">${esc(title)}</h2>
        <button type="button" class="btn btn--icon" data-modal-close aria-label="Close dialog"
                ${canDismiss ? '' : 'hidden'}>
          ${icon('close', { size: 16 })}
        </button>
      </div>
      <div class="modal__body"></div>
    </div>`;
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';

  const previouslyFocused = document.activeElement;
  let cleanup;

  function onKey(event) {
    if (event.key === 'Escape' && canDismiss) close();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    cleanup?.();
    overlay.remove();
    document.body.style.overflow = '';
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    closeActive = null;
  }

  function setDismissible(value) {
    canDismiss = Boolean(value);
    $('[data-modal-close]', overlay).hidden = !canDismiss;
  }

  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && canDismiss) close();
  });
  $('[data-modal-close]', overlay).addEventListener('click', close);

  // closeActive is what closeModal() and the next openModal() reach for. It is the
  // owner's handle, so it ignores `dismissible` — that flag governs the *user's*
  // ways out (backdrop, Escape, the × button), not the caller's.
  closeActive = close;
  cleanup = render($('.modal__body', overlay), close, { setDismissible }) || undefined;
  // Only take the fallback focus if the render callback did not already put
  // focus somewhere more useful (e.g. a form's first field).
  if (!overlay.contains(document.activeElement)) $('.modal', overlay).focus();
  return { close, setDismissible };
}

export function closeModal() {
  closeActive?.();
}
