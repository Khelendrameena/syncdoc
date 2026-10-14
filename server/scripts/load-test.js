// Load test: N concurrent clients editing one document.
//
// What it measures (methodology in README):
//   - joinLatency: per-client time from doc:join emit to init ack.
//   - editsPerSec: server-side updates received / wall time (via /api/health).
//   - timeToConverge: after the last edit is made, how long until every
//     client's document text is identical.
// Caveats: clients and server run on the same machine (no network RTT);
// numbers are a ceiling, not a production claim. Run it yourself with:
//   node scripts/load-test.js --url http://localhost:4000 --clients 50 --edits 40
import { io } from 'socket.io-client';
import * as Y from 'yjs';

const b64e = (u8) => Buffer.from(u8).toString('base64');
const b64d = (s) => new Uint8Array(Buffer.from(s, 'base64'));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const URL = arg('url', 'http://localhost:4000');
const N = parseInt(arg('clients', '10'), 10);
const EDITS = parseInt(arg('edits', '30'), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit'];

async function main() {
  // Owner + document + share link (guests are cheaper than N registrations).
  const reg = await (
    await fetch(`${URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Load', email: `load${Date.now()}@test.dev`, password: 'password123' }),
    })
  ).json();
  const H = { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` };
  const { document } = await (
    await fetch(`${URL}/api/documents`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Load Test' }) })
  ).json();
  const { token: shareToken } = await (
    await fetch(`${URL}/api/documents/${document.id}/share`, { method: 'POST', headers: H, body: '{}' })
  ).json();

  const health0 = await (await fetch(`${URL}/api/health`)).json();

  const clients = [];
  const joinLatencies = [];
  for (let i = 0; i < N; i++) {
    const { guestToken } = await (
      await fetch(`${URL}/api/share/${shareToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `bot${i}` }),
      })
    ).json();
    const socket = io(URL, { auth: { token: guestToken }, reconnection: false });
    const ydoc = new Y.Doc();
    const text = ydoc.getText('t');
    const REMOTE = Symbol('remote');
    ydoc.on('update', (update, origin) => {
      if (origin === REMOTE) return;
      socket.emit('doc:update', { docId: document.id, update: b64e(update) });
    });
    socket.on('doc:update', ({ update }) => Y.applyUpdate(ydoc, b64d(update), REMOTE));
    await new Promise((res, rej) => {
      socket.on('connect', res);
      socket.on('connect_error', rej);
    });
    const t0 = Date.now();
    const ack = await socket.emitWithAck('doc:join', {
      docId: document.id,
      stateVector: b64e(Y.encodeStateVector(ydoc)),
      awarenessId: i,
    });
    if (ack.error) throw new Error(ack.error);
    Y.applyUpdate(ydoc, b64d(ack.state), REMOTE);
    joinLatencies.push(Date.now() - t0);
    clients.push({ socket, ydoc, text });
    if (i % 10 === 0) process.stdout.write(`\rjoined ${i + 1}/${N}`);
  }
  console.log(`\rjoined ${N}/${N}`);

  // Editing phase: every client makes EDITS random edits, all at once.
  const editStart = Date.now();
  await Promise.all(
    clients.map(async ({ text }, ci) => {
      for (let e = 0; e < EDITS; e++) {
        text.doc.transact(() => {
          const pos = Math.floor(Math.random() * (text.length + 1));
          if (text.length > 20 && e % 5 === 0) text.delete(pos % text.length, 3);
          else text.insert(pos, WORDS[(ci + e) % WORDS.length] + ' ');
        });
        await sleep(Math.random() * 4);
      }
    })
  );
  const lastEdit = Date.now();

  // Convergence: poll until all clients agree.
  let convergedMs = -1;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const t0 = clients[0].text.toString();
    if (clients.every((c) => c.text.toString() === t0)) {
      convergedMs = Date.now() - lastEdit;
      break;
    }
    await sleep(100);
  }

  const health1 = await (await fetch(`${URL}/api/health`)).json();
  const updatesReceived = health1.updatesReceived - health0.updatesReceived;
  const wallSec = (Date.now() - editStart) / 1000;

  const sorted = [...joinLatencies].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mem = process.memoryUsage();

  console.log(JSON.stringify({
    clients: N, editsPerClient: EDITS, totalEdits: N * EDITS,
    joinLatencyMs: { p50: pct(50), p95: pct(95), max: sorted[sorted.length - 1] },
    serverUpdatesReceived: updatesReceived,
    editPhaseSec: +wallSec.toFixed(2),
    serverEditsPerSec: +(updatesReceived / wallSec).toFixed(1),
    timeToConvergeMs: convergedMs,
    finalTextChars: clients[0].text.toString().length,
    loadScriptRssMB: +(mem.rss / 1024 / 1024).toFixed(1),
    sameHostCaveat: true,
  }, null, 2));

  for (const c of clients) c.socket.disconnect();
}

main().catch((e) => {
  console.error('load test failed:', e.message);
  process.exit(1);
});
