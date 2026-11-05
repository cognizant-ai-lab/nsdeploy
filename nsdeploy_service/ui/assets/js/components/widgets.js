/** Shared presentational fragments. Pure functions returning HTML strings. */
import { esc, icon } from '../util/dom.js';
import { count, statusMeta } from '../util/format.js';

/**
 * Status pill: glyph + word, always both.
 * Never render the glyph alone — `good` and `critical` in the status palette are
 * ~ΔE 4 apart under deuteranopia, so the text is what actually distinguishes
 * "ready" from "failed" for red-green colorblind readers.
 */
export function statusPill(status) {
  const meta = statusMeta(status);
  const glyph = meta.spin
    ? `<span class="pill__glyph spin" aria-hidden="true">${meta.glyph}</span>`
    : `<span class="pill__glyph" aria-hidden="true">${meta.glyph}</span>`;
  return `<span class="pill pill--${esc(status)}">
    ${glyph}<span>${esc(meta.label)}</span>
    <span class="sr-only">${esc(meta.sr)}</span>
  </span>`;
}

/**
 * KPI row. Counts only — no delta, no sparkline, because the API exposes no
 * historical series and a fabricated trend would misstate the data.
 */
export function statTiles(tiles) {
  return `<div class="stats">${tiles.map((tile) => `
    <div class="stat${tile.good ? ' stat--good' : ''}">
      ${tile.icon ? `<div class="stat__icon" aria-hidden="true">${icon(tile.icon, { size: 17 })}</div>` : ''}
      <div class="stat__label">${esc(tile.label)}</div>
      <div class="stat__value${tile.good ? ' stat__value--good' : ''}">${esc(count(tile.value))}</div>
      ${tile.foot ? `<div class="stat__foot">${esc(tile.foot)}</div>` : ''}
    </div>`).join('')}</div>`;
}

export function emptyState(title, hint, iconName = 'grid') {
  return `<div class="empty">
    <div class="empty__icon" aria-hidden="true">${icon(iconName, { size: 22 })}</div>
    <div class="empty__title">${esc(title)}</div>
    ${hint ? `<p class="empty__hint">${esc(hint)}</p>` : ''}
  </div>`;
}

/** Non-fatal findings from nsdeploy's own dependency report. */
export function warningsNote(warnings) {
  if (!warnings?.length) return '';
  return `<div class="note note--warn">
    <span class="note__glyph" aria-hidden="true">!</span>
    <div>
      <strong>Deployed with ${warnings.length} caveat${warnings.length > 1 ? 's' : ''}</strong>
      <ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    </div>
  </div>`;
}

export function errorNote(message) {
  if (!message) return '';
  return `<div class="note note--err">
    <span class="note__glyph" aria-hidden="true">✕</span>
    <div>${esc(message)}</div>
  </div>`;
}

export function copyButton(value, label = 'Copy') {
  return `<button class="btn btn--ghost btn--sm" data-copy="${esc(value)}">
    ${icon('copy', { size: 13 })}<span>${esc(label)}</span>
  </button>`;
}

// `networkFacts` used to live here — a one-line "front-man X · N agents · no
// hosted tools" summary. Its only caller was the agent-description modal, which
// now states each of those as a labelled fact with what it means, so the
// condensed version had no reader left.
