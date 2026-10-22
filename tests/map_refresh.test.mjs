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
