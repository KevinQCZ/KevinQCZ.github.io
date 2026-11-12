import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initAdmin } from '../public/js/admin.js';

function fixture(origin = 'https://api.example.test') {
  const elements = Object.fromEntries(['status', 'login', 'logout'].map((name) => [name, {
    hidden: false, disabled: false, textContent: '',
    addEventListener(_event, listener) { this.click = listener; }
  }]));
  return {
    elements,
    root: { dataset: { apiOrigin: origin }, querySelector: (selector) => elements[selector.slice(6, -1)] }
  };
}

test('admin page is explicitly unavailable without an HTTPS API origin', () => {
  const { root, elements } = fixture('');
  initAdmin(root, () => { throw new Error('must not fetch'); });
  assert.match(elements.status.textContent, /not configured/);
  assert.equal(elements.login.hidden, true);
  assert.equal(elements.logout.hidden, true);
});

test('unauthenticated users can start login', async () => {
  const { root, elements } = fixture();
  let destination;
  await initAdmin(root, async () => ({ status: 401 }), (url) => { destination = url; });
  assert.match(elements.status.textContent, /Not signed in/);
  assert.equal(elements.login.hidden, false);
  elements.login.click();
  assert.equal(destination, 'https://api.example.test/auth/github');
});

test('authorized session uses in-memory CSRF and handles logout failure', async () => {
  const { root, elements } = fixture();
  let request;
  await initAdmin(root, async (url, options) => {
    if (url.endsWith('/api/me')) return { ok: true, json: async () => ({ role: 'ADMIN', csrfToken: 'csrf-token' }) };
    request = options;
    return { ok: false };
  });
  assert.equal(elements.logout.hidden, false);
  await elements.logout.click();
  assert.equal(request.credentials, 'include');
  assert.equal(request.headers['X-CSRF-Token'], 'csrf-token');
  assert.match(elements.status.textContent, /Sign-out failed/);
  assert.equal(elements.logout.hidden, false);
});

test('successful logout clears admin controls', async () => {
  const { root, elements } = fixture();
  await initAdmin(root, async (url) => url.endsWith('/api/me')
    ? { ok: true, json: async () => ({ role: 'ADMIN', csrfToken: 'csrf-token' }) }
    : { ok: true });
  await elements.logout.click();
  assert.match(elements.status.textContent, /Signed out/);
  assert.equal(elements.logout.hidden, true);
  assert.equal(elements.login.hidden, false);
});

test('reports denied and unavailable sessions without login or logout controls', async () => {
  for (const [response, expected] of [
    [{ status: 403 }, /not authorized/],
    [{ status: 503 }, /unavailable/]
  ]) {
    const { root, elements } = fixture();
    await initAdmin(root, async () => response);
    assert.match(elements.status.textContent, expected);
    assert.equal(elements.login.hidden, true);
    assert.equal(elements.logout.hidden, true);
  }
});
