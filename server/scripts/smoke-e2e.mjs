// End-to-end smoke test for the SyncDoc sync server.
// Usage: node server/scripts/smoke-e2e.mjs [--url http://localhost:4000]
// Exercises the real protocol: register/login -> create doc -> join with two
// socket clients -> concurrent edits fan out -> presence -> state-vector resync.
import { io } from 'socket.io-client';
import * as Y from 'yjs';

const BASE = process.argv[2]?.replace(/^--url=/, '') || process.env.SYNCDOC_URL || 'http://localhost:4000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, label, extra = '') => {
  console.log(cond ? `  ok  ${label}` : `  FAIL ${label} ${extra}`);
  if (!cond) failures++;
};

console.log(`smoke: ${BASE}`);
// 1. register + login
const email = `smoke${Date.now()}@x.io`;
const post = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
let r = await post('/api/auth/register', { name: 'Smoke', email, password: 'password123' });
check(r.status === 201, `register -> 201 (got ${r.status})`);
r = await post('/api/auth/login', { email, password: 'password123' });
const { token, user } = await r.json();
check(!!token, `login -> token (user ${user?.name})`);

// 2. create document
r = await post('/api/documents', { title: 'Smoke Doc' }, token);
const { document: doc } = await r.json();
check(!!doc?.id, `create document -> id ${doc?.id}`);

// 3. two socket clients join
const joinClient = (name) =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token } });
    const seen = { updates: [], presenceJoins: [], awareness: [] };
    s.on('doc:update', (u) => seen.updates.push(u));
    s.on('presence:join', (p) => seen.presenceJoins.push(p));
    s.on('awareness:update', (a) => seen.awareness.push(a));
    s.on('connect_error', reject);
    s.emit('doc:join', { docId: doc.id, awarenessId: name }, (ack) => {
      if (ack?.error) reject(new Error(ack.error));
      else resolve({ s, seen, ack });
    });
  });
const A = await joinClient('Alice');
check(A.ack.version >= 0 && Array.isArray(A.ack.collaborators), 'A joins, ack has state+version+collaborators');
const B = await joinClient('Bob');
await sleep(400);
check(A.seen.presenceJoins.some((p) => p.awarenessId === 'Bob'), 'A receives presence:join for Bob');

// 4. concurrent edits converge via fan-out
const upd = (text) => {
  const d = new Y.Doc();
  d.getText('content').insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64');
};
// Reuse the exact same update bytes for send + merge: applying the same
// bytes twice must be a no-op (idempotent delivery, tested).
const ownA = upd('HELLO-A '), ownB = upd('HELLO-B ');
A.s.emit('doc:update', { docId: doc.id, update: ownA });
B.s.emit('doc:update', { docId: doc.id, update: ownB });
await sleep(1000);
check(A.seen.updates.length >= 1, `A receives broadcast updates (got ${A.seen.updates.length})`);
check(B.seen.updates.length >= 1, `B receives broadcast updates (got ${B.seen.updates.length})`);

// apply everything on one Y.Doc and confirm server state via a fresh join (state-vector sync)
// Server fan-out skips the sender by design; each client already holds its
// own updates locally. Model that by applying own sent updates too.
const merged = new Y.Doc();
if (A.ack.state) Y.applyUpdate(merged, Buffer.from(A.ack.state, 'base64'));
Y.applyUpdate(merged, Buffer.from(ownA, 'base64'));
Y.applyUpdate(merged, Buffer.from(ownB, 'base64'));
for (const u of A.seen.updates) Y.applyUpdate(merged, Buffer.from(u.update, 'base64'));
const C = await joinClient('Carol');
const serverDoc = new Y.Doc();
if (C.ack.state) Y.applyUpdate(serverDoc, Buffer.from(C.ack.state, 'base64'));
const t1 = merged.getText('content').toString();
const t2 = serverDoc.getText('content').toString();
check(t1.includes('HELLO-A') && t1.includes('HELLO-B'), `replica text converged: "${t1}"`);
check(t1 === t2, 'server state == merged replica state');

// 5. awareness relay (cursor/selection)
A.s.emit('awareness:update', { docId: doc.id, update: upd('cursor'), awarenessId: 'Alice' });
await sleep(300);
check(B.seen.awareness.some((a) => a.awarenessId === 'Alice'), 'B receives Alice awareness update');

// 6. leave -> presence removed
const removed = new Promise((res) => B.s.on('awareness:remove', (x) => res(x)));
A.s.emit('doc:leave', { docId: doc.id });
const rm = await Promise.race([removed, sleep(1500).then(() => null)]);
check(!!rm, 'B sees awareness:remove when A leaves');

A.s.disconnect(); B.s.disconnect(); C.s.disconnect();
console.log(failures ? `SMOKE FAIL (${failures})` : 'SMOKE PASS');
process.exit(failures ? 1 : 0);
