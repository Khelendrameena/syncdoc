// Shared test harness: in-memory Postgres + ephemeral server + a protocol-
// faithful test client (implements the same join/diff/offline-buffer flow
// as the real frontend, so these tests exercise the actual wire protocol).
import { newDb } from 'pg-mem';
import { io as clientIO } from 'socket.io-client';
import * as Y from 'yjs';
import { createStore } from '../src/db.js';
import { createApp } from '../src/app.js';
import { signUserToken } from '../src/auth.js';

export const b64e = (u8) => Buffer.from(u8).toString('base64');
export const b64d = (s) => new Uint8Array(Buffer.from(s, 'base64'));

export async function waitFor(cond, timeoutMs = 5000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

export async function startTestServer(roomOpts = {}) {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const store = createStore(pool);
  await store.init();
  const app = createApp({ store, roomOpts, corsOrigin: '*' });
  const port = await app.start(0);
  const url = `http://127.0.0.1:${port}`;
  return { ...app, url, pool };
}

export async function createUserAndDoc(server, { name = 'Owner', email = 'owner@test.dev', title = 'Doc' } = {}) {
  const store = server.store;
  const user = await store.createUser({
    id: store.newId(),
    name,
    email,
    passwordHash: 'test-hash',
  });
  const doc = await store.createDocument({ id: store.newId(), title, ownerId: user.id });
  const token = signUserToken({ id: user.id, name: user.name, email: user.email });
  return { user, doc, token };
}

// Test client: mirrors the frontend's sync logic (join with state vector,
// remote-origin tagging, offline update buffering, reconnect flush).
export class TestClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.REMOTE = Symbol('remote');
    this.joined = false;
    this.docId = null;
    this.offlineBuffer = [];
    this.receivedResets = 0;
    this._newDoc();
    this._connect();
  }

  _newDoc() {
    if (this.ydoc) this.ydoc.destroy();
    this.ydoc = new Y.Doc();
    this.text = this.ydoc.getText('t');
    this.ydoc.on('update', (update, origin) => {
      if (origin === this.REMOTE) return;
      const enc = b64e(update);
      if (this.joined && this.socket.connected) {
        this.socket.emit('doc:update', { docId: this.docId, update: enc });
      } else {
        this.offlineBuffer.push(enc); // disconnected: buffer for reconnect
      }
    });
  }

  _connect() {
    this.socket = clientIO(this.url, { auth: { token: this.token }, reconnection: false });
    this.socket.on('doc:update', ({ update }) => {
      Y.applyUpdate(this.ydoc, b64d(update), this.REMOTE);
    });
    this.socket.on('doc:reset', ({ state }) => {
      this._newDoc();
      Y.applyUpdate(this.ydoc, b64d(state), this.REMOTE);
      this.receivedResets += 1;
    });
  }

  get connected() {
    return this.socket.connected;
  }

  async join(docId) {
    this.docId = docId;
    await new Promise((resolve, reject) => {
      this.socket.on('connect', resolve);
      this.socket.on('connect_error', (e) => reject(e));
      if (this.socket.connected) resolve();
    });
    const res = await this.socket.emitWithAck('doc:join', {
      docId,
      stateVector: b64e(Y.encodeStateVector(this.ydoc)),
      awarenessId: Math.floor(Math.random() * 1e9),
    });
    if (res.error) throw new Error(`join failed: ${res.error}`);
    Y.applyUpdate(this.ydoc, b64d(res.state), this.REMOTE);
    this.joined = true;
    // Flush anything edited while offline (idempotent server-side).
    for (const u of this.offlineBuffer) this.socket.emit('doc:update', { docId, update: u });
    this.offlineBuffer = [];
    return res;
  }

  // Local edit (goes through the same ydoc 'update' path as the UI).
  edit(fn) {
    this.ydoc.transact(() => fn(this.text));
  }

  getText() {
    return this.text.toString();
  }

  disconnect() {
    this.joined = false;
    this.socket.disconnect();
  }

  async reconnect() {
    this._connect();
    await this.join(this.docId);
  }

  close() {
    try {
      this.socket.disconnect();
    } catch {}
    this.ydoc.destroy();
  }
}
