/**
 * Tests for the map's pan/zoom arithmetic.
 *
 * The clamping is the part worth testing: a wrong bound lets the reader drag the city
 * off its own frame and leaves them staring at empty background with no way back
 * except the reset button.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
  centreOnPercent, clampPan, clampScale, cssFor, identity, isZoomed,
  panBy, zoomAbout, zoomByCentre, zoomPercent,
} from '../nsdeploy_service/ui/assets/js/util/zoom.js';

const W = 1200;
const H = 600;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} != ${b}`);

test('scale is held between the documented bounds', () => {
  assert.equal(clampScale(0.1), ZOOM_MIN);
  assert.equal(clampScale(99), ZOOM_MAX);
  assert.equal(clampScale(2), 2);
});

test('a nonsense scale falls back to fitted rather than NaN', () => {
  for (const bad of [NaN, undefined, null, 'wide', {}]) {
    assert.equal(clampScale(bad), ZOOM_MIN);
  }
});

test('a fitted map cannot be panned at all', () => {
  // At k=1 the scene exactly covers the frame, so 0 is the only legal offset.
  const { tx, ty } = clampPan(-300, 200, 1, W, H);
  assert.deepEqual({ tx, ty }, { tx: 0, ty: 0 });
});

test('panning stops at the edges of the scene', () => {
  // At k=2 the scene is 2400x1200 against a 1200x600 frame, so the offset may run
  // from -1200/-600 (bottom-right flush) to 0 (top-left flush).
  assert.deepEqual(clampPan(-5000, -5000, 2, W, H), { tx: -1200, ty: -600 });
  assert.deepEqual(clampPan(5000, 5000, 2, W, H), { tx: 0, ty: 0 });
  assert.deepEqual(clampPan(-100, -50, 2, W, H), { tx: -100, ty: -50 });
});

test('the identity view is fitted and unshifted', () => {
  assert.deepEqual(identity(), { scale: ZOOM_MIN, tx: 0, ty: 0 });
});

test('zooming about a point keeps that point under the cursor', () => {
  // The scene point beneath the cursor before and after must be the same.
  const before = { scale: 1, tx: 0, ty: 0 };
  const fx = 400;
  const fy = 300;
  const sceneBefore = (fx - before.tx) / before.scale;
  const after = zoomAbout(before, 2, fx, fy, W, H);
  const sceneAfter = (fx - after.tx) / after.scale;
  close(sceneBefore, sceneAfter, 'the point drifted under the cursor');
});

test('zooming about a point still respects the frame', () => {
  // Zooming hard at the top-left corner would want a positive offset; it cannot have
  // one, because that would expose background to the left of the map.
  const after = zoomAbout({ scale: 1, tx: 0, ty: 0 }, ZOOM_MAX, 0, 0, W, H);
  assert.ok(after.tx <= 0 && after.ty <= 0);
  assert.deepEqual(clampPan(after.tx, after.ty, after.scale, W, H),
    { tx: after.tx, ty: after.ty });
});

test('zooming at the centre keeps the centre fixed', () => {
  const after = zoomByCentre(identity(), ZOOM_STEP, W, H);
  close((W / 2 - after.tx) / after.scale, W / 2);
  close((H / 2 - after.ty) / after.scale, H / 2);
});

test('zooming out from the maximum lands back at fitted and square', () => {
  let view = { scale: ZOOM_MAX, tx: -2000, ty: -1000 };
  for (let i = 0; i < 20; i += 1) view = zoomByCentre(view, 1 / ZOOM_STEP, W, H);
  assert.equal(view.scale, ZOOM_MIN);
  // The clamp must also pull the offset home, or a fitted map sits off-centre with
  // no way to correct it.
  assert.deepEqual({ tx: view.tx, ty: view.ty }, { tx: 0, ty: 0 });
});

test('zoom never escapes its bounds however many times it is applied', () => {
  let view = identity();
  for (let i = 0; i < 50; i += 1) view = zoomByCentre(view, ZOOM_STEP, W, H);
  assert.equal(view.scale, ZOOM_MAX);
  for (let i = 0; i < 50; i += 1) view = zoomByCentre(view, 1 / ZOOM_STEP, W, H);
  assert.equal(view.scale, ZOOM_MIN);
});

test('a drag moves the view and then holds it against the frame', () => {
  const view = { scale: 2, tx: -100, ty: -100 };
  assert.deepEqual(panBy(view, -50, -25, W, H), { scale: 2, tx: -150, ty: -125 });
  // Dragging past the edge sticks there instead of continuing.
  assert.deepEqual(panBy(view, 5000, 5000, W, H), { scale: 2, tx: 0, ty: 0 });
});

test('a drag on a fitted map does nothing', () => {
  assert.deepEqual(panBy(identity(), -200, -200, W, H), { scale: 1, tx: 0, ty: 0 });
});

test('centring on a percent coordinate puts it in the middle of the frame', () => {
  const view = centreOnPercent({ scale: 3, tx: 0, ty: 0 }, 50, 50, W, H);
  // Scene point (0.5W, 0.5H) should render at the frame centre.
  close(0.5 * W * view.scale + view.tx, W / 2);
  close(0.5 * H * view.scale + view.ty, H / 2);
});

test('centring on an edge pin stays inside the frame', () => {
  // A pin at the far corner cannot be centred without exposing background, so the
  // clamp wins and the pin sits at the edge instead.
  const view = centreOnPercent({ scale: 3, tx: 0, ty: 0 }, 91, 82, W, H);
  assert.deepEqual(clampPan(view.tx, view.ty, view.scale, W, H),
    { tx: view.tx, ty: view.ty });
});

test('the emitted CSS counter-scales the markers', () => {
  // Markers must hold their on-screen size, or zoom magnifies the crowding instead
  // of relieving it.
  const css = cssFor({ scale: 2, tx: -10, ty: -20 });
  assert.equal(css.transform, 'translate(-10px, -20px) scale(2)');
  assert.equal(css.unzoom, '0.5');
});

test('the emitted CSS survives a malformed view', () => {
  const css = cssFor(undefined);
  assert.equal(css.transform, 'translate(0px, 0px) scale(1)');
  assert.equal(css.unzoom, '1');
});

test('the zoom level reads as a whole percentage', () => {
  assert.equal(zoomPercent({ scale: 1 }), '100%');
  assert.equal(zoomPercent({ scale: 2.5 }), '250%');
  assert.equal(zoomPercent(undefined), '100%');
});

test('isZoomed distinguishes fitted from magnified', () => {
  assert.equal(isZoomed(identity()), false);
  assert.equal(isZoomed({ scale: 1.0000001 }), false);
  assert.equal(isZoomed({ scale: 1.5 }), true);
});

test('a zero-sized stage does not produce NaN', () => {
  // ResizeObserver fires before the stage has been laid out; the first view must
  // still be a usable set of numbers.
  const view = zoomByCentre(identity(), ZOOM_STEP, 0, 0);
  assert.ok(Number.isFinite(view.tx) && Number.isFinite(view.ty));
  assert.deepEqual({ tx: view.tx, ty: view.ty }, { tx: 0, ty: 0 });
});
