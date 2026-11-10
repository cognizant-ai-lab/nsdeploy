/**
 * Tiny DOM helpers. No framework: the whole UI is a handful of views over a
 * documented JSON API, so a virtual DOM would cost more than it saves.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Escape text for interpolation into an HTML template string.
 * Every value that reaches innerHTML goes through this — organization names,
 * network names, and error text all come from user input.
 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

/** Replace a container's contents with an HTML string. */
export function render(target, html) {
  target.innerHTML = html;
  return target;
}

/** Delegated click handling, so re-rendered markup needs no re-binding. */
export function onClick(root, selector, handler) {
  root.addEventListener('click', (event) => {
    const match = event.target.closest(selector);
    if (match && root.contains(match)) handler(match, event);
  });
}

export function show(element, visible) {
  element.hidden = !visible;
}

const ICONS = {
  upload: '<path d="M12 16V4m0 0L8 8m4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  cube: '<path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  external: '<path d="M14 4h6v6M20 4 10 14M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  // "Run this" on the map's search bar — the Enter key, drawn.
  arrowRight: '<path d="M5 12h13M12 5l7 7-7 7"/>',
  // Corner brackets: "fit the whole thing in the frame", the reset for a zoomed map.
  frame: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/>',
  rocket: '<path d="M12 2c2.5 2 4 5.3 4 8.5 0 2-1 4-2 5.5l-2-1-2 1c-1-1.5-2-3.5-2-5.5C8 7.3 9.5 4 12 2Z"/><path d="M9 15.5 6 19l3-1 1-3M15 15.5 18 19l-3-1-1-3"/><circle cx="12" cy="10" r="1.4"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  map: '<path d="M9 3 3 5.5v15L9 18l6 2.5 6-2.5v-15L15 5.5 9 3Zm0 0v15m6-15v15"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 21v-4.5h6V21M9 8h.01M15 8h.01M9 12h.01M15 12h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  sitemap: '<circle cx="12" cy="4.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="18.5" r="2"/><path d="M12 6.5v4M12 10.5 6 16.7M12 10.5l6 6.2"/>',
  // A map pin: publishing puts the network on the map. The struck-through variant
  // is the same glyph, so the pair reads as one action and its reverse.
  pin: '<path d="M12 21s6.5-5.4 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.6 12 21 12 21Z"/><circle cx="12" cy="10" r="2.3"/>',
  pinOff: '<path d="M12 21s6.5-5.4 6.5-11a6.5 6.5 0 0 0-11.1-4.6M5.7 7.1A6.5 6.5 0 0 0 5.5 10c0 5.6 6.5 11 6.5 11"/><path d="M3.5 3.5l17 17"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.8"/>',
  trash: '<path d="M4 7h16M10 4.5h4M6.5 7l.8 12.5a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9L17.5 7"/><path d="M10.5 11v5.5M13.5 11v5.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/>',
  // Deploy-time LLM theming — distinct from the sun/moon light/dark toggle, which
  // is the console's own appearance, not the deployed site's.
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.9a1.9 1.9 0 0 1 1.9-1.9H17a3.2 3.2 0 0 0 3.2-3.2A9 9 0 0 0 12 3Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.9-3.9"/>'
    + '<circle cx="7.5" cy="10.3" r="1.2"/><circle cx="12" cy="7.2" r="1.2"/>'
    + '<circle cx="16.5" cy="10.3" r="1.2"/><circle cx="9" cy="15.2" r="1.2"/>',
};

/** Whether an icon name exists, so callers can fall back instead of rendering nothing. */
export function hasIcon(name) {
  return Boolean(ICONS[name]);
}

/**
 * Inline stroked icon. Decorative by default — meaning lives in adjacent text.
 *
 * An unknown name returns '' and logs. Returning '' silently is how an icon-only
 * button ends up rendering as an empty box: nothing to see and nothing to click on,
 * with no clue why. Callers that have no adjacent text should check `hasIcon` (see
 * iconAction in views/directory.js).
 */
export function icon(name, { size = 16 } = {}) {
  const path = ICONS[name];
  if (!path) {
    console.warn(`icon(): no glyph named "${name}"`);
    return '';
  }
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
