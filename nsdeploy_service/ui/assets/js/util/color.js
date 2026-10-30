/**
 * Colour arithmetic for the design editor: resolve what an operator typed, then
 * say whether the result is readable.
 *
 * Resolution is delegated to the browser rather than parsed here. The theme
 * layer accepts #hex, rgb()/hsl(), and bare CSS keywords (see is_color in
 * nsdeploy/theme.py), so a hand-rolled parser would have to carry the named
 * colour table to keep up — and would disagree with the browser the moment it
 * fell behind. Setting the value on a detached element and reading it back gets
 * the same answer the deployed site will paint, and rejects nonsense for free:
 * an invalid value never assigns.
 *
 * The contrast check exists because this editor hands over the two colours that
 * decide whether a deployed site is legible at all (`fg` on `bg`). The rest of
 * this console treats colour as reinforcement and never as the only signal
 * (see tokens.css); a site themed to 2:1 cannot make that choice for itself, so
 * the ratio is shown while it is being chosen rather than discovered later.
 */

const probe = document.createElement('span');

/** @returns {[number, number, number] | null} sRGB 0-255, or null if invalid. */
export function toRgb(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Assigning an invalid value leaves the previous one in place, so clear first:
  // without this, "nonsense" would read back as whatever was resolved last.
  probe.style.color = '';
  probe.style.color = value.trim();
  if (!probe.style.color) return null;
  const match = probe.style.color.match(/-?\d*\.?\d+/g);
  if (!match || match.length < 3) return null;
  return match.slice(0, 3).map(Number);
}

export function isColor(value) {
  return toRgb(value) !== null;
}

/** Hex form of any accepted colour, for an <input type="color"> that only
 * speaks hex. Null when the value is valid CSS but not representable (nothing
 * in the default palette is, but a keyword with alpha would be). */
export function toHex(value) {
  const rgb = toRgb(value);
  if (!rgb) return null;
  return `#${rgb.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]) {
  const channel = (raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1–21. Null if either colour is unresolvable. */
export function contrast(foreground, background) {
  const fg = toRgb(foreground);
  const bg = toRgb(background);
  if (!fg || !bg) return null;
  const light = Math.max(luminance(fg), luminance(bg));
  const dark = Math.min(luminance(fg), luminance(bg));
  return (light + 0.05) / (dark + 0.05);
}

/**
 * How a ratio reads against WCAG AA, as the editor reports it.
 *
 * `large` is for text at 18.66px bold / 24px and up, which AA holds to 3:1
 * instead of 4.5:1 — the brand wordmark and tagline qualify, body copy and chat
 * messages do not.
 */
export function rate(ratio, { large = false } = {}) {
  if (ratio === null) return { level: 'unknown', label: 'unreadable value', ok: false };
  const floor = large ? 3 : 4.5;
  const fixed = ratio.toFixed(1);
  if (ratio >= (large ? 4.5 : 7)) return { level: 'aaa', label: `AAA ${fixed}:1`, ok: true };
  if (ratio >= floor) return { level: 'aa', label: `AA ${fixed}:1`, ok: true };
  return {
    level: 'fail',
    label: `${fixed}:1 — below AA ${floor}:1`,
    ok: false,
  };
}
