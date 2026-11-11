import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../nsdeploy_service/site_customization/shared-byok.js', import.meta.url),
  'utf8',
);

const SITE = 'https://site.example.test/';
const RELAY = 'https://site.example.test/byok/v1';
const SHARED = '__Secure-nsdeploy_shared_byok_v1=sk-shared%2Fvalue';

// One page load. `session` is the tab's sessionStorage, which survives a reload,
// so a test can click Apply on one load and pass the same session to the next.
const browser = ({ cookie = '', session = new Map(), inputValue = '' } = {}) => {
  const listeners = {};
  const writes = [];
  const input = { value: inputValue };
  const button = (id) => ({ addEventListener(type, fn) { listeners[id] = fn; } });
  const apply = button('apply');
  const deleteProfile = button('delete');
  let reloads = 0;
  const document = {
    get cookie() { return cookie; },
    set cookie(value) { writes.push(value); cookie = value; },
    querySelector(selector) {
      if (selector === '#ns-key') return input;
      if (selector === '#ns-apply') return apply;
      if (selector === '#ns-delete-profile') return deleteProfile;
      return null;
    },
  };
  const url = new URL(SITE);
  const context = {
    window: { isSecureContext: true },
    document,
    location: { href: url.href, origin: url.origin, hostname: url.hostname, reload() { reloads += 1; } },
    sessionStorage: {
      // An empty string is a stored value, as in a real browser, not a missing item.
      getItem(key) { return session.has(key) ? session.get(key) : null; },
      setItem(key, value) { session.set(key, value); },
      removeItem(key) { session.delete(key); },
    },
    URL,
    decodeURIComponent,
    encodeURIComponent,
  };
  vm.runInNewContext(source, context);
  return { input, listeners, session, writes, reloads: () => reloads };
};

// What nsdeploy's own Apply handler stores when the page accepts a setup.
const applied = (session, key, router) => {
  session.set('nsweb-byok-tab-key', key);
  session.set('nsweb-byok-router', router);
};

test('a shared cookie seeds a new network and reloads exactly once', () => {
  const page = browser({ cookie: SHARED });
  assert.equal(page.session.get('nsweb-byok-key'), 'sk-shared/value');
  assert.equal(page.input.value, 'sk-shared/value');
  assert.equal(page.reloads(), 1);

  const reloaded = browser({ cookie: SHARED, session: page.session, inputValue: 'sk-shared/value' });
  assert.equal(reloaded.reloads(), 0);
});

test('a setup applied in the tab keeps its own key', () => {
  const session = new Map();
  applied(session, '', 'https://tab.example.test/v1');
  const page = browser({ cookie: SHARED, session });
  assert.equal(page.session.has('nsweb-byok-key'), false);
  assert.equal(page.input.value, '');
  assert.equal(page.reloads(), 0);
});

test('a key applied with the site relay is shared after the page saves it', () => {
  const page = browser({ inputValue: '  sk-first-key  ' });
  page.listeners.apply();
  assert.deepEqual(page.writes, []);

  applied(page.session, 'sk-first-key', RELAY);
  const next = browser({ session: page.session });
  assert.match(next.writes[0], /^__Secure-nsdeploy_shared_byok_v1=sk-first-key;/);
  assert.match(next.writes[0], /Max-Age=172800/);
  assert.match(next.writes[0], /SameSite=Strict; Secure/);
});

test('a key applied with another provider URL stays on the site', () => {
  for (const router of ['https://api.groq.com/openai/v1', 'https://site.example.test:8443/byok/v1']) {
    const page = browser({ inputValue: 'sk-groq' });
    page.listeners.apply();
    applied(page.session, 'sk-groq', router);
    assert.deepEqual(browser({ session: page.session }).writes, []);
  }
});

test('a key the page rejected is not shared', () => {
  const page = browser({ inputValue: 'sk-rejected' });
  page.listeners.apply();
  assert.deepEqual(browser({ session: page.session }).writes, []);
});

test('an applied empty key clears the shared cookie', () => {
  const page = browser({ cookie: SHARED });
  page.input.value = '';
  page.listeners.apply();
  applied(page.session, '', RELAY);
  assert.match(browser({ cookie: SHARED, session: page.session }).writes[0], /Max-Age=0/);
});

test('Delete setup clears the shared cookie', () => {
  const page = browser({ cookie: SHARED });
  page.listeners.delete();
  assert.match(page.writes.at(-1), /^__Secure-nsdeploy_shared_byok_v1=;.*Max-Age=0/);
});

test('the behavior is inactive outside a secure context', () => {
  const context = {
    window: { isSecureContext: false },
    document: { querySelector() { throw new Error('must not inspect the UI'); } },
  };
  vm.runInNewContext(source, context);
});
