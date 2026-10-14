// Snapshots & rollback, exercised through the real HTTP API + sockets:
// edit -> snapshot -> edit -> rollback => content returns to the snapshot,
// a pre-rollback auto-snapshot preserves the discarded state, and every
// connected client receives doc:reset and replaces its local document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestClient, waitFor } from './helpers.js';

async function register(url, name, email) {
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password123' }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('snapshot, rollback, and pre-rollback safety copy', async (t) => {
  const server = await startTestServer({ saveDebounceMs: 50 });
  t.after(() => server.stop());
  const url = server.url;

  const { token } = await register(url, 'Owner', 'owner@snap.dev');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  const created = await (
    await fetch(`${url}/api/documents`, { method: 'POST', headers, body: JSON.stringify({ title: 'Snap Doc' }) })
  ).json();
  const docId = created.document.id;

  const a = new TestClient(url, token);
  const b = new TestClient(url, token);
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a.join(docId), b.join(docId)]);

  a.edit((txt) => txt.insert(0, 'version-one'));
  await waitFor(() => b.getText() === 'version-one', 3000, 'v1 sync');

  const snap1 = await (
    await fetch(`${url}/api/documents/${docId}/snapshots`, {
      method: 'POST', headers, body: JSON.stringify({ note: 'before risky edit' }),
    })
  ).json();
  assert.ok(snap1.snapshot.id);

  a.edit((txt) => txt.insert(txt.length, ' + version-two (mistake)'));
  await waitFor(() => b.getText().includes('mistake'), 3000, 'v2 sync');

  const before = await (await fetch(`${url}/api/documents/${docId}/snapshots`, { headers })).json();
  const rb = await fetch(`${url}/api/documents/${docId}/rollback`, {
    method: 'POST', headers, body: JSON.stringify({ snapshotId: snap1.snapshot.id }),
  });
  assert.equal(rb.status, 200);

  // Both clients must have applied the reset…
  await waitFor(() => a.receivedResets >= 1 && b.receivedResets >= 1, 5000, 'doc:reset on both clients');
  assert.equal(a.getText(), 'version-one');
  assert.equal(b.getText(), 'version-one');

  // …and the server agrees.
  await waitFor(
    () => server.rooms.rooms.get(docId).ydoc.getText('t').toString() === 'version-one',
    3000,
    'server rolled back'
  );

  // The discarded state was auto-preserved.
  const after = await (await fetch(`${url}/api/documents/${docId}/snapshots`, { headers })).json();
  assert.ok(after.snapshots.length > before.snapshots.length, 'no pre-rollback snapshot created');
  assert.ok(after.snapshots.some((s) => s.note === 'auto: pre-rollback'));
  assert.ok(after.snapshots.some((s) => s.note.startsWith('rollback to v')));
});
