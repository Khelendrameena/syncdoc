// Disconnect / reconnect with offline edits.
//
// Scenario: client A goes offline, keeps typing (edits buffer locally).
// Client B keeps editing online. A reconnects: the join diff gives A what
// it missed, A's buffered offline edits flush to the server, and every
// replica converges with NO data loss on either side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUserAndDoc, TestClient, waitFor } from './helpers.js';

test('offline edits reconcile on reconnect without data loss', async (t) => {
  const server = await startTestServer({ saveDebounceMs: 50 });
  t.after(() => server.stop());
  const { doc, token } = await createUserAndDoc(server);
  const url = server.url;

  const a = new TestClient(url, token);
  const b = new TestClient(url, token);
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a.join(doc.id), b.join(doc.id)]);

  a.edit((txt) => txt.insert(0, 'BASE '));
  await waitFor(() => b.getText() === 'BASE ', 3000, 'baseline sync');

  // A drops offline and keeps typing; B keeps typing online.
  a.disconnect();
  assert.ok(!a.connected);
  a.edit((txt) => txt.insert(txt.length, 'OFFLINE-A1 '));
  a.edit((txt) => txt.insert(txt.length, 'OFFLINE-A2 '));
  b.edit((txt) => txt.insert(txt.length, 'ONLINE-B1 '));
  await new Promise((r) => setTimeout(r, 300));

  // A must NOT have received B's edit while offline…
  assert.ok(!a.getText().includes('ONLINE-B1'), 'A received updates while offline?!');
  // …and the server must not have A's offline edits yet.
  const roomBefore = server.rooms.rooms.get(doc.id);
  assert.ok(!roomBefore.ydoc.getText('t').toString().includes('OFFLINE-A1'));

  // Reconnect: diff + buffered flush.
  await a.reconnect();

  await waitFor(
    () => a.getText() === b.getText() && a.getText().includes('OFFLINE-A2') && a.getText().includes('ONLINE-B1'),
    8000,
    'post-reconnect convergence'
  );
  const serverText = server.rooms.rooms.get(doc.id).ydoc.getText('t').toString();
  assert.equal(a.getText(), serverText, 'server diverged after reconnect');
  for (const marker of ['BASE ', 'OFFLINE-A1 ', 'OFFLINE-A2 ', 'ONLINE-B1 ']) {
    assert.ok(serverText.includes(marker), `server lost edit: ${marker}`);
  }
  console.log(`    converged after reconnect: "${serverText}"`);
});

test('reconnect with zero offline edits is a clean no-op', async (t) => {
  const server = await startTestServer({ saveDebounceMs: 50 });
  t.after(() => server.stop());
  const { doc, token } = await createUserAndDoc(server);

  const a = new TestClient(server.url, token);
  const b = new TestClient(server.url, token);
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a.join(doc.id), b.join(doc.id)]);
  b.edit((txt) => txt.insert(0, 'hello'));
  await waitFor(() => a.getText() === 'hello', 3000, 'initial sync');

  a.disconnect();
  b.edit((txt) => txt.insert(txt.length, ' world'));
  await a.reconnect(); // no offline edits; join diff should catch A up

  await waitFor(() => a.getText() === 'hello world', 5000, 'catch-up after reconnect');
  assert.equal(a.getText(), b.getText());
});
