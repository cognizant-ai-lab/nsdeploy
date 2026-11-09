import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTabByokSetup, saveTabByokSetup } from '../nsdeploy/runtime/byok.js';

// A fresh in-memory sessionStorage for each test, so no state leaks between them.
// Writing the item named in failOn throws, as a full or blocked storage does.
function useSession(entries = [], failOn = '') {
  const items = new Map(entries);
  globalThis.sessionStorage = {
    getItem(name) { return items.has(name) ? items.get(name) : null; },
    setItem(name, value) {
      if (name === failOn) throw new Error('storage is full');
      items.set(name, String(value));
    },
    removeItem(name) { items.delete(name); },
  };
  return items;
}

const saved = { key: 'saved-key', router: 'https://saved.example.test/v1', model: 'saved-model' };
const applied = { key: 'tab-key', router: 'https://tab.example.test/v1', model: 'tab-model' };

test('a setup applied in this tab is used as a whole, not mixed with the saved profile', () => {
  useSession();
  saveTabByokSetup(applied);
  assert.deepEqual(loadTabByokSetup(saved), applied);
});

test('an applied setup with no key, router or model takes none of them from the saved profile', () => {
  useSession();
  saveTabByokSetup({ router: 'https://tab.example.test/v1' });
  assert.deepEqual(loadTabByokSetup(saved), { key: '', router: 'https://tab.example.test/v1', model: '' });
});

test('the shared-key slot cannot change the key of an applied setup', () => {
  const items = useSession();
  saveTabByokSetup(applied);
  items.set('nsweb-byok-key', 'shared-key');
  assert.deepEqual(loadTabByokSetup(saved), applied);
});

test('a loose key goes only to the site default router, never to a saved profile router', () => {
  useSession([['nsweb-byok-key', 'loose-key']]);
  assert.deepEqual(loadTabByokSetup(saved), { key: 'loose-key', router: '', model: '' });
});

test('without an applied setup or a loose key, the saved profile applies as a whole', () => {
  useSession();
  assert.deepEqual(loadTabByokSetup(saved), saved);
});

test('a failed write leaves nothing behind, so the saved profile applies as a whole', () => {
  const items = useSession([], 'nsweb-byok-router');
  saveTabByokSetup(applied);
  assert.equal(items.size, 0);
  assert.deepEqual(loadTabByokSetup(saved), saved);
});

test('clearing the tab setup removes its key too, and the saved profile applies again', () => {
  const items = useSession();
  saveTabByokSetup(applied);
  saveTabByokSetup(null);
  assert.equal(items.size, 0);
  assert.deepEqual(loadTabByokSetup(saved), saved);
});

test('a new setup without a key removes the key of the previous one', () => {
  const items = useSession();
  saveTabByokSetup(applied);
  saveTabByokSetup({ router: 'https://other.example.test/v1' });
  assert.equal(items.has('nsweb-byok-tab-key'), false);
  assert.equal(items.has('nsweb-byok-key'), false);
  assert.equal(loadTabByokSetup(saved).key, '');
});
