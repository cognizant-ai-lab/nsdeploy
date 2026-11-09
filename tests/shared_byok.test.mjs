import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../nsdeploy_service/site_customization/shared-byok.js', import.meta.url),
  'utf8',
);

// tabRouter is the router of a setup applied in the tab; '' is an applied setup with no router.
function browser({ cookie = '', sessionKey = '', inputValue = '', tabRouter = null } = {}) {
  const listeners = {};
  const writes = [];
  const input = { value: inputValue };
  const apply = { addEventListener(type, fn) { listeners[type] = fn; } };
  const session = new Map(sessionKey ? [['nsweb-byok-key', sessionKey]] : []);
  if (tabRouter !== null) session.set('nsweb-byok-router', tabRouter);
  let reloads = 0;
  const document = {
    get cookie() { return cookie; },
    set cookie(value) { writes.push(value); cookie = value; },
    querySelector(selector) {
      if (selector === '#ns-key') return input;
      if (selector === '#ns-apply') return apply;
      return null;
    },
  };
  const context = {
    document,
    location: { protocol: 'https:', reload() { reloads += 1; } },
    sessionStorage: {
      // An empty string is a stored value, as in a real browser, not a missing item.
      getItem(key) { return session.has(key) ? session.get(key) : null; },
      setItem(key, value) { session.set(key, value); },
    },
    decodeURIComponent,
    encodeURIComponent,
  };
  vm.runInNewContext(source, context);
  return { input, listeners, session, writes, reloads: () => reloads };
}

test('a shared cookie seeds a new network and reloads exactly once', () => {
  const page = browser({ cookie: '__Secure-nsdeploy_shared_byok_v1=sk-shared%2Fvalue' });
  assert.equal(page.session.get('nsweb-byok-key'), 'sk-shared/value');
  assert.equal(page.input.value, 'sk-shared/value');
  assert.equal(page.reloads(), 1);

  const reloaded = browser({
    cookie: '__Secure-nsdeploy_shared_byok_v1=sk-shared%2Fvalue',
    sessionKey: 'sk-shared/value',
    inputValue: 'sk-shared/value',
  });
  assert.equal(reloaded.reloads(), 0);
});

test('a setup applied in the tab keeps its empty key: no seeding, no reload, no key in the field', () => {
  const page = browser({
    cookie: '__Secure-nsdeploy_shared_byok_v1=sk-shared%2Fvalue',
    tabRouter: 'https://tab.example.test/v1',
  });
  assert.equal(page.session.has('nsweb-byok-key'), false);
  assert.equal(page.input.value, '');
  assert.equal(page.reloads(), 0);

  const noRouter = browser({ cookie: '__Secure-nsdeploy_shared_byok_v1=sk-shared%2Fvalue', tabRouter: '' });
  assert.equal(noRouter.input.value, '');
  assert.equal(noRouter.reloads(), 0);
});

test('Apply writes the entered key as a secure 48-hour cookie', () => {
  const page = browser({ inputValue: '  sk-first-key  ' });
  page.listeners.click();
  assert.match(page.writes[0], /^__Secure-nsdeploy_shared_byok_v1=sk-first-key;/);
  assert.match(page.writes[0], /Max-Age=172800/);
  assert.match(page.writes[0], /SameSite=Strict; Secure/);
});

test('Apply with a blank field clears the shared cookie', () => {
  const page = browser({ inputValue: '' });
  page.listeners.click();
  assert.match(page.writes[0], /Max-Age=0/);
});

test('the behavior is inactive on non-HTTPS sites', () => {
  const context = {
    document: { querySelector() { throw new Error('must not inspect the UI'); } },
    location: { protocol: 'http:' },
  };
  vm.runInNewContext(source, context);
});
