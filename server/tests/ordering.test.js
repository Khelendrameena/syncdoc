// Ordering guarantees, proven at the CRDT level:
//  1. Updates applied in a SHUFFLED order converge to the same state.
//  2. Duplicate delivery (at-least-once retries, reconnect flush overlap)
//     is idempotent — applying the same update twice changes nothing.
// This is why the server needs no global operation ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('updates applied in shuffled order converge identically', async () => {
  // Three independent "clients" editing concurrently.
  const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
  const allUpdates = [];
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  docs.forEach((d, di) => {
    const txt = d.getText('t');
    d.on('update', (u) => allUpdates.push(new Uint8Array(u)));
    d.transact(() => {
      for (let i = 0; i < 10; i++) {
        const pos = Math.floor(Math.random() * (txt.length + 1));
        txt.insert(pos, `${words[(di + i) % words.length]}${i} `);
        if (i % 3 === 0 && txt.length > 5) txt.delete(0, 2);
      }
    });
  });

  // Reference: apply in capture order.
  const ref = new Y.Doc();
  for (const u of allUpdates) Y.applyUpdate(ref, u);
  const expected = ref.getText('t').toString();

  // Three different shuffled orders must all reach the same state.
  for (let round = 0; round < 3; round++) {
    const d = new Y.Doc();
    for (const u of shuffled(allUpdates)) Y.applyUpdate(d, u);
    assert.equal(d.getText('t').toString(), expected, `shuffled round ${round} diverged`);
  }
  console.log(`    ${allUpdates.length} updates, 3 shuffled orders, all converged (${expected.length} chars)`);
});

test('duplicate update delivery is idempotent', async () => {
  const a = new Y.Doc();
  const txt = a.getText('t');
  const updates = [];
  a.on('update', (u) => updates.push(new Uint8Array(u)));
  a.transact(() => {
    txt.insert(0, 'hello ');
    txt.insert(6, 'world');
    txt.delete(0, 1);
  });

  const b = new Y.Doc();
  for (const u of updates) {
    Y.applyUpdate(b, u);
    Y.applyUpdate(b, u); // duplicate: e.g. reconnect flush overlapping an in-flight send
    Y.applyUpdate(b, u); // triple, for good measure
  }
  assert.equal(b.getText('t').toString(), txt.toString());
  assert.equal(b.getText('t').toString(), 'ello world');
});
