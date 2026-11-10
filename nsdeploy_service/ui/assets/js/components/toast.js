/** Transient feedback. Errors persist until dismissed; successes auto-expire. */
import { esc } from '../util/dom.js';

const HOST_ID = 'toasts';
const SUCCESS_MS = 5000;

function host() {
  let element = document.getElementById(HOST_ID);
  if (!element) {
    element = document.createElement('div');
    element.id = HOST_ID;
    element.className = 'toasts';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    document.body.append(element);
  }
  return element;
}

function push(message, kind) {
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.innerHTML = `
    <span class="toast__glyph" aria-hidden="true">${kind === 'err' ? '✕' : '✓'}</span>
    <span class="toast__body">${esc(message)}</span>
    <button class="btn btn--icon btn--sm" aria-label="Dismiss">✕</button>`;
  node.querySelector('button').addEventListener('click', () => node.remove());
  host().append(node);
  // An error is something the user must act on, so it does not disappear on its own.
  if (kind === 'ok') setTimeout(() => node.remove(), SUCCESS_MS);
  return node;
}

export const toast = {
  ok: (message) => push(message, 'ok'),
  error: (message) => push(message, 'err'),
};
