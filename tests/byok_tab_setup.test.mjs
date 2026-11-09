import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTabByokSetup, saveTabByokSetup } from '../nsdeploy/runtime/byok.js';

// A fresh in-memory sessionStorage for each test, so no state leaks between them.
function useSession(entries = []) {
  const items = new Map(entries);
  globalThis.sessionStorage = {
    getItem(name) { return items.has(name) ? items.get(name) : null; },
    setItem(name, value) { items.set(name, String(value)); },
    removeItem(name) { items.delete(name); },
  };
  return items;
}

const saved = { key: 'saved-key', router: 'https://saved.example.test/v1', model: 'saved-model' };

test('a setup applied in this tab is used as a whole, not mixed with the saved profile', () => {
  useSession();
  saveTabByokSetup({ key: 'tab-key', router: 'https://tab.example.test/v1', model: 'tab-model' });
  assert.deepEqual(loadTabByokSetup(saved), {
    key: 'tab-key',
    router: 'https://tab.example.test/v1',
    model: 'tab-model',
  });
});

test('an applied setup with no router or model does not take them from the saved profile', () => {
  useSession();
  saveTabByokSetup({ key: 'tab-key' });
  assert.deepEqual(loadTabByokSetup(saved), { key: 'tab-key', router: '', model: '' });
});

test('without an applied setup, a key already in the session comes before the saved key', () => {
  useSession([['nsweb-byok-key', 'session-key']]);
  assert.deepEqual(loadTabByokSetup(saved), {
    key: 'session-key',
    router: 'https://saved.example.test/v1',
    model: 'saved-model',
  });
});

test('clearing the tab setup makes the saved profile apply again', () => {
  const items = useSession();
  saveTabByokSetup({ key: 'tab-key', router: 'https://tab.example.test/v1', model: 'tab-model' });
  saveTabByokSetup(null);
  assert.equal(items.size, 0);
  assert.deepEqual(loadTabByokSetup(saved), saved);
});

test('a new setup without a key removes the key of the previous one', () => {
  const items = useSession();
  saveTabByokSetup({ key: 'tab-key', router: 'https://tab.example.test/v1' });
  saveTabByokSetup({ router: 'https://other.example.test/v1' });
  assert.equal(items.has('nsweb-byok-key'), false);
  assert.equal(loadTabByokSetup(saved).key, '');
});
