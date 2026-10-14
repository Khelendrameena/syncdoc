// Concurrent edits to the SAME region must converge on all replicas.
// Three clients all insert at position 0 simultaneously (the hardest case
// for OT-style systems; CRDT resolves it by (clientID, clock) tie-break).
// Then all three make interleaved random edits, and we assert every
// replica — including the server's — agrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUserAndDoc, TestClient, waitFor } from './helpers.js';

test('concurrent edits to the same region converge on all clients and the server', async (t) => {
  const server = await startTestServer({ saveDebounceMs: 50 });
  t.after(() => server.stop());
  const { doc, token } = await createUserAndDoc(server);
  const url = server.url;

  const a = new TestClient(url, token);
  const b = new TestClient(url, token);
  const c = new TestClient(url, token);
  t.after(() => { a.close(); b.close(); c.close(); });
  await Promise.all([a.join(doc.id), b.join(doc.id), c.join(doc.id)]);

  // Phase 1: all three insert at position 0 "simultaneously" (no awaits).
  a.edit((txt) => txt.insert(0, '[A]'));
  b.edit((txt) => txt.insert(0, '[B]'));
  c.edit((txt) => txt.insert(0, '[C]'));

  await waitFor(() => a.getText() === b.getText() && b.getText() === c.getText(), 5000, 'phase-1 convergence');
  for (const marker of ['[A]', '[B]', '[C]']) {
    assert.ok(a.getText().includes(marker), `converged text missing ${marker}: ${a.getText()}`);
  }

  // Phase 2: interleaved random inserts/deletes from all clients at once.
  const clients = [a, b, c];
  for (let i = 0; i < 30; i++) {
    const cl = clients[i % 3];
    cl.edit((txt) => {
      const pos = Math.floor(Math.random() * (txt.length + 1));
      if (txt.length > 10 && i % 4 === 0) txt.delete(pos % txt.length, 2);
      else txt.insert(pos, `<${i}>`);
    });
  }

  await waitFor(() => a.getText() === b.getText() && b.getText() === c.getText(), 8000, 'phase-2 convergence');
  const room = server.rooms.rooms.get(doc.id);
  const serverText = room.ydoc.getText('t').toString();
  assert.equal(a.getText(), serverText, 'server replica diverged from clients');
  assert.ok(a.getText().length > 0);
  console.log(`    converged text length: ${a.getText().length} chars, server in agreement`);
});
