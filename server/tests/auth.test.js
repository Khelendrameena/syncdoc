// Auth: registration, login, route protection, and share-link guest scoping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestClient } from './helpers.js';

async function post(url, path, body, token) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('register / login / protected routes', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const url = server.url;

  const reg = await post(url, '/api/auth/register', { name: 'K', email: 'k@auth.dev', password: 'password123' });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.token);

  const dup = await post(url, '/api/auth/register', { name: 'K', email: 'k@auth.dev', password: 'password123' });
  assert.equal(dup.status, 409);

  const bad = await post(url, '/api/auth/login', { email: 'k@auth.dev', password: 'wrongpass1' });
  assert.equal(bad.status, 401);

  const login = await post(url, '/api/auth/login', { email: 'k@auth.dev', password: 'password123' });
  assert.equal(login.status, 200);

  const noAuth = await fetch(`${url}/api/documents`);
  assert.equal(noAuth.status, 401);
});

test('share-link guests are scoped to one document', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const url = server.url;

  const { body: reg } = await post(url, '/api/auth/register', {
    name: 'Owner', email: 'o@share.dev', password: 'password123',
  });
  const token = reg.token;
  const headers = { authorization: `Bearer ${token}` };

  const d1 = (await (await fetch(`${url}/api/documents`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Shared' }),
  })).json()).document;
  const d2 = (await (await fetch(`${url}/api/documents`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Private' }),
  })).json()).document;

  const share = await post(url, `/api/documents/${d1.id}/share`, {}, token);
  assert.equal(share.status, 201);
  assert.ok(share.body.token);

  const guest = await post(url, `/api/share/${share.body.token}`, { name: 'Guest Gina' });
  assert.equal(guest.status, 200);
  assert.equal(guest.body.document.id, d1.id);
  const guestToken = guest.body.guestToken;

  // Guest can join the shared doc…
  const g = new TestClient(url, guestToken);
  t.after(() => g.close());
  await g.join(d1.id);

  // …but not the owner's other doc.
  const g2 = new TestClient(url, guestToken);
  t.after(() => g2.close());
  await assert.rejects(() => g2.join(d2.id), /forbidden/);

  // Guests cannot create documents.
  const create = await post(url, '/api/documents', { title: 'nope' }, guestToken);
  assert.equal(create.status, 403);
});
