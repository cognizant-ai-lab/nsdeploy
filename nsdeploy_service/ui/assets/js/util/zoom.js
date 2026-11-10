/**
 * Pan/zoom arithmetic for the map stage.
 *
 * DOM-free on purpose, like util/listquery.js: the interesting part is the clamping,
 * and a wrong clamp shows up as the reader dragging the city off the edge of its own
 * frame. That is worth testing without a browser.
 *
 * THE MODEL. The scene is exactly the size of the stage, and is drawn with
 * `transform: translate(tx, ty) scale(k)` against `transform-origin: 0 0`. A point at
 * scene coordinate p therefore lands on screen at `p * k + t`. Keeping the origin at
 * the top-left is what makes that one multiply instead of a centre-relative offset.
 *
 * WHY ZOOM AT ALL. nsdeploy_service/layout.py spreads ~100 event networks over a 15x11
 * lattice and util/scatter.js nudges them off it, but 100 markers in one viewport are
 * crowded whatever the placement. Magnification alone would not help — scaling the
 * markers with the ground leaves the overlap ratio exactly where it started. So the
 * scene scales while the markers hold their on-screen size (see --unzoom in
 * styles/components.css), which turns zoom into real separation rather than a
 * magnifying glass.
 */

export const ZOOM_MIN = 1;      // Fit-the-frame. Zooming out past the artwork shows nothing.
export const ZOOM_MAX = 6;      // ~100 markers over 6x is one pin per screenful; past that
                                // the reader has lost the map and should use the list.
export const ZOOM_STEP = 1.5;   // Per button press. Four presses spans min to max.
export const WHEEL_STEP = 1.12; // Per wheel notch — finer, because a wheel sends many.

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function clampScale(scale) {
  const k = Number(scale);
  if (!Number.isFinite(k)) return ZOOM_MIN;
  return clamp(k, ZOOM_MIN, ZOOM_MAX);
}

/**
 * Hold the scene against its frame.
 *
 * At scale k the scene is `size * k` long against a `size` frame, so the offset may
 * run from `size * (1 - k)` (bottom/right edge flush) to 0 (top/left flush). At k = 1
 * that collapses to a single legal value, 0 — which is what stops the map being
 * dragged away when it is already fitted.
 */
export function clampPan(tx, ty, scale, width, height) {
  const k = clampScale(scale);
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  return {
    tx: clamp(Number(tx) || 0, w * (1 - k), 0),
    ty: clamp(Number(ty) || 0, h * (1 - k), 0),
  };
}

export const identity = () => ({ scale: ZOOM_MIN, tx: 0, ty: 0 });

/**
 * Re-scale about a fixed point, so whatever is under the cursor stays under it.
 *
 * `fx`/`fy` are in stage pixels, measured from the stage's top-left. The scene point
 * beneath them is `(f - t) / k`; requiring it to land on `f` again at the new scale
 * gives `t' = f - (f - t) * (k' / k)`.
 */
export function zoomAbout(view, nextScale, fx, fy, width, height) {
  const from = clampScale(view?.scale);
  const to = clampScale(nextScale);
  const ratio = to / from;
  const tx = fx - (fx - (Number(view?.tx) || 0)) * ratio;
  const ty = fy - (fy - (Number(view?.ty) || 0)) * ratio;
  return { scale: to, ...clampPan(tx, ty, to, width, height) };
}

/** Zoom by a factor about the centre of the frame — what the buttons and keys use. */
export function zoomByCentre(view, factor, width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  return zoomAbout(view, clampScale(view?.scale) * factor, w / 2, h / 2, w, h);
}

/** Drag: shift by a screen-space delta, then hold it against the frame. */
export function panBy(view, dx, dy, width, height) {
  const scale = clampScale(view?.scale);
  const tx = (Number(view?.tx) || 0) + (Number(dx) || 0);
  const ty = (Number(view?.ty) || 0) + (Number(dy) || 0);
  return { scale, ...clampPan(tx, ty, scale, width, height) };
}

/**
 * Centre the frame on a scene coordinate given in percent — how "find my pin" moves
 * the map to a network without the reader hunting for it.
 */
export function centreOnPercent(view, xPercent, yPercent, width, height) {
  const scale = clampScale(view?.scale);
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const tx = w / 2 - ((Number(xPercent) || 0) / 100) * w * scale;
  const ty = h / 2 - ((Number(yPercent) || 0) / 100) * h * scale;
  return { scale, ...clampPan(tx, ty, scale, w, h) };
}

/** The CSS the stage needs for one view: the scene transform and the marker unzoom. */
export function cssFor(view) {
  const scale = clampScale(view?.scale);
  return {
    transform: `translate(${Number(view?.tx) || 0}px, ${Number(view?.ty) || 0}px) scale(${scale})`,
    unzoom: String(1 / scale),
  };
}

export const zoomPercent = (view) => `${Math.round(clampScale(view?.scale) * 100)}%`;

/** True once the reader has moved away from the fitted view, so reset can be offered. */
export const isZoomed = (view) => clampScale(view?.scale) > ZOOM_MIN + 1e-6;
