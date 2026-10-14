// Presence: join/leave notifications, disconnect cleanup, and the
// heartbeat sweeper that evicts half-dead connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, createUserAndDoc, TestClient, waitFor } from './helpers.js';

test('presence join/leave and disconnect cleanup', async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  const { doc, token } = await createUserAndDoc(server);

  const a = new TestClient(server.url, token);
  t.after(() => a.close());
  const joinA = await a.join(doc.id);
  assert.equal(joinA.collaborators.length, 1, 'first joiner should see only itself');

  // A records presence events for B.
  const seen = { joins: [], removes: [] };
  a.socket.on('presence:join', (p) => seen.joins.push(p));
  a.socket.on('awareness:remove', (p) => seen.removes.push(p));

  const b = new TestClient(server.url, token);
  t.after(() => b.close());
  const joinB = await b.join(doc.id);
  assert.equal(joinB.collaborators.length, 2, 'second joiner should see both');

  await waitFor(() => seen.joins.length === 1, 3000, 'presence:join for B');
  assert.equal(seen.joins[0].user.name, 'Owner');

  const bSocketId = seen.joins[0].socketId;
  b.disconnect(); // hard disconnect, no doc:leave

  await waitFor(() => seen.removes.length === 1, 3000, 'awareness:remove for B');
  assert.equal(seen.removes[0].socketId, bSocketId);

  const room = server.rooms.rooms.get(doc.id);
  assert.equal(room.clients.size, 1, 'wrong client count after disconnect');
  assert.ok(room.clients.has(a.socket.id), 'wrong client was removed');
});

test('heartbeat sweeper evicts stale clients', async (t) => {
  const server = await startTestServer({ presenceTimeoutMs: 500, presenceSweepMs: 100 });
  t.after(() => server.stop());
  const { doc, token } = await createUserAndDoc(server);

  const a = new TestClient(server.url, token);
  const stale = new TestClient(server.url, token);
  t.after(() => { a.close(); stale.close(); });
  await a.join(doc.id);
  await stale.join(doc.id);

  const removes = [];
  a.socket.on('awareness:remove', (p) => removes.push(p));

  // Simulate a half-dead connection: socket alive, but no heartbeats.
  const room = server.rooms.rooms.get(doc.id);
  const staleSocketId = [...room.clients.keys()].find((id) => id !== a.socket.id);
  assert.ok(staleSocketId, 'stale client not tracked');
  room.clients.get(staleSocketId).lastSeen = Date.now() - 60_000;
  server.rooms.sweep();

  await waitFor(() => removes.length === 1, 3000, 'sweeper eviction broadcast');
  assert.equal(removes[0].socketId, staleSocketId);
  assert.ok(!room.clients.has(staleSocketId), 'stale client still in room map');
});
