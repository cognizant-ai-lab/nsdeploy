import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MAP_REFRESH_SECONDS, mapRefreshSeconds,
} from '../nsdeploy_service/ui/assets/js/util/mapRefresh.js';

test('the map never waits longer than one minute', () => {
  assert.equal(MAX_MAP_REFRESH_SECONDS, 60);
  assert.equal(mapRefreshSeconds(120), 60);
  assert.equal(mapRefreshSeconds(3600), 60);
});

test('a faster valid server recommendation is preserved', () => {
  assert.equal(mapRefreshSeconds(45), 45);
  assert.equal(mapRefreshSeconds('30'), 30);
});

test('zero or invalid values cannot disable automatic refresh', () => {
  for (const value of [0, -1, null, undefined, '', 'disabled', Infinity]) {
    assert.equal(mapRefreshSeconds(value), 60);
  }
});

/* ── 30-second cadence ───────────────────────────────────────────────────── */

test('the server default of 30s is accepted as-is', () => {
  // config.py sets map_refresh_seconds = 30. The cap only ever makes the map fresher,
  // so this must pass straight through rather than being rounded to the 60s default.
  assert.equal(mapRefreshSeconds(30), 30);
  assert.ok(30 < MAX_MAP_REFRESH_SECONDS, 'the cap must not clamp the new default');
});

test('the 5-second floor still rejects a cadence that would hammer /graph', () => {
  // A hundred viewers at the event share one service; 1s would be ~100 req/s of pure
  // projection work for no reader benefit.
  assert.equal(mapRefreshSeconds(4), MAX_MAP_REFRESH_SECONDS);
  assert.equal(mapRefreshSeconds(5), 5);
});
