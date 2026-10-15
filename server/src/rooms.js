// RoomManager: owns every live document's Y.Doc and the sync protocol.
//
// Architecture notes (the parts Khelendra should be able to defend):
//
// 1. The server is NOT the source of truth in the OT sense — it is a
//    relay + durable log for a CRDT. Yjs updates are commutative and
//    idempotent, so the server never needs to order operations globally.
//    Socket.IO already gives per-connection FIFO; anything beyond that is
//    handled by the CRDT merge, which is why out-of-order and duplicate
//    deliveries are safe (and tested).
//
// 2. Join = state-vector sync. The client sends what it already has
//    (Y.encodeStateVector); the server replies with exactly the missing
//    updates (Y.encodeStateAsUpdate(doc, clientVector)). This makes
//    reconnect-after-offline-editing a normal join: the client's offline
//    edits are simply updates the server hasn't seen yet, and the diff
//    the server sends is what the client missed.
//
// 3. Persistence is write-behind: updates accumulate in memory and flush
//    to Postgres (debounced). A crash can lose at most saveDebounceMs of
//    edits — documented in the README as an accepted trade-off.
//
// 4. Broadcasts skip the sender (socket.to(room)). Applying your own
//    update back would be harmless (idempotent) but doubles traffic.
import * as Y from 'yjs';
import { config } from './config.js';

const b64encode = (u8) => Buffer.from(u8).toString('base64');
const b64decode = (s) => new Uint8Array(Buffer.from(s, 'base64'));

export class RoomManager {
  constructor(store, io, opts = {}) {
    this.store = store;
    this.io = io;
    this.rooms = new Map(); // docId -> room
    this.saveDebounceMs = opts.saveDebounceMs ?? config.saveDebounceMs;
    this.presenceTimeoutMs = opts.presenceTimeoutMs ?? config.presenceTimeoutMs;
    this.presenceSweepMs = opts.presenceSweepMs ?? config.presenceSweepMs;
    this.idleUnloadMs = opts.idleUnloadMs ?? config.idleUnloadMs;
    this.snapshotEveryUpdates = opts.snapshotEveryUpdates ?? config.snapshotEveryUpdates;
    this.maxSnapshots = opts.maxSnapshots ?? config.maxSnapshots;
    this.stats = { updatesReceived: 0, roomsLoaded: 0 };

    // Backstop sweeper: evicts stale presence entries (half-dead
    // connections whose socket never fired 'disconnect') and unloads
    // rooms that have been empty past idleUnloadMs.
    this.sweeper = setInterval(() => this.sweep(), this.presenceSweepMs);
    this.sweeper.unref?.();
  }

  // ---- room lifecycle ----

  // Load a room into memory (snapshot + updates-after-snapshot replay).
  // Returns null if the document does not exist.
  async getRoom(docId) {
    let room = this.rooms.get(docId);
    if (room) {
      room.lastActivity = Date.now();
      return room;
    }
    const doc = await this.store.getDocument(docId);
    if (!doc) return null;

    const ydoc = new Y.Doc();
    let lastUpdateId = 0;
    let version = 0;
    const snapshots = await this.store.listSnapshots(docId);
    if (snapshots.length > 0) {
      const latest = await this.store.getSnapshot(snapshots[snapshots.length - 1].id);
      Y.applyUpdate(ydoc, b64decode(latest.state));
      lastUpdateId = Number(latest.last_update_id);
      version = Number(latest.version);
    }
    const updates = await this.store.getUpdatesAfter(docId, lastUpdateId);
    for (const u of updates) {
      Y.applyUpdate(ydoc, b64decode(u.update));
      lastUpdateId = Number(u.id);
      version += 1;
    }

    room = {
      docId,
      ydoc,
      version,            // monotonic counter: updates applied + snapshots/rollbacks
      lastUpdateId,       // highest document_updates.id applied to this ydoc
      clients: new Map(), // socketId -> { userId, name, color, awarenessId, lastSeen }
      pendingUpdates: [], // base64 update strings not yet flushed to Postgres
      saveTimer: null,
      lastActivity: Date.now(),
    };
    this.rooms.set(docId, room);
    this.stats.roomsLoaded += 1;
    return room;
  }

  hasRoom(docId) {
    return this.rooms.has(docId);
  }

  // ---- sync protocol ----

  // A client joined: return the diff it is missing, given its state vector.
  joinDiff(room, clientStateVectorB64) {
    const sv = clientStateVectorB64 ? b64decode(clientStateVectorB64) : undefined;
    return b64encode(Y.encodeStateAsUpdate(room.ydoc, sv));
  }

  // A client sent an edit. Apply to the room CRDT, fan out to the rest of
  // the room, and schedule a debounced Postgres flush.
  async handleUpdate(docId, updateB64, socket) {
    const room = this.rooms.get(docId);
    if (!room) return { error: 'not in room' };
    // Validate BEFORE decoding: Buffer.from(non-string) throws, and a
    // garbage update must be rejected, not crash the handler.
    if (typeof updateB64 !== 'string' || updateB64.length === 0) {
      return { error: 'malformed update' };
    }
    let update;
    try {
      update = b64decode(updateB64);
    } catch {
      return { error: 'malformed update' };
    }
    if (update.length > config.maxUpdateBytes) return { error: 'update too large' };

    // CRDT apply is commutative + idempotent: duplicates and out-of-order
    // arrivals converge to the same state. No locking, no sequencing.
    Y.applyUpdate(room.ydoc, update);
    room.version += 1;
    room.pendingUpdates.push(b64encode(update)); // base64: TEXT column, see schema note
    room.lastActivity = Date.now();
    this.stats.updatesReceived += 1;

    socket.to(`doc:${docId}`).emit('doc:update', { update: updateB64, version: room.version });
    this.scheduleSave(room);
    return { version: room.version };
  }

  // ---- persistence (write-behind) ----

  scheduleSave(room) {
    if (room.saveTimer) return; // already scheduled; the timer flushes everything pending
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      this.saveRoom(room).catch((err) => console.error(`[room ${room.docId}] save failed:`, err.message));
    }, this.saveDebounceMs);
    room.saveTimer.unref?.();
  }

  async saveRoom(room) {
    if (room.pendingUpdates.length === 0) return;
    const updates = room.pendingUpdates;
    room.pendingUpdates = [];
    const ids = await this.store.appendUpdates(room.docId, updates);
    if (ids.length) room.lastUpdateId = ids[ids.length - 1];
    await this.store.touchDocument(room.docId);

    // Compaction: keep the update log short so room loads stay fast.
    const total = await this.store.countUpdates(room.docId);
    if (total >= this.snapshotEveryUpdates) {
      await this.createSnapshot(room.docId, { note: 'auto: compaction', createdBy: null });
    }
  }

  // Public: create a named snapshot of the current room state.
  async createSnapshot(docId, { note, createdBy }) {
    const room = await this.getRoom(docId);
    if (!room) throw new Error('document not found');
    await this.saveRoom(room); // flush first so the snapshot covers everything
    const state = Y.encodeStateAsUpdate(room.ydoc);
    const snap = await this.store.createSnapshot({
      id: this.store.newId(),
      documentId: docId,
      version: room.version,
      state: b64encode(state),
      lastUpdateId: room.lastUpdateId,
      note: note || null,
      createdBy: createdBy || null,
    });
    // The snapshot now covers these updates; drop them from the log.
    await this.store.deleteUpdatesUpTo(docId, room.lastUpdateId);
    await this.store.pruneSnapshots(docId, this.maxSnapshots);
    return snap;
  }

  // Rollback: restore the room to a snapshot. Because CRDT history is
  // append-only, "going back" is implemented as a state reset, not as
  // history surgery:
  //   1. flush + auto-snapshot the current state (nothing is ever lost),
  //   2. swap the room's Y.Doc for one built from the snapshot,
  //   3. persist the restored state, bump version, broadcast doc:reset.
  // Clients replace their local doc wholesale. Documented in README.
  async rollback(docId, snapshotId, userId) {
    const room = await this.getRoom(docId);
    if (!room) throw new Error('document not found');
    const snap = await this.store.getSnapshot(snapshotId);
    if (!snap || snap.document_id !== docId) throw new Error('snapshot not found');

    await this.saveRoom(room);
    await this.createSnapshot(docId, { note: 'auto: pre-rollback', createdBy: userId });

    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, b64decode(snap.state));
    room.ydoc = fresh;
    room.pendingUpdates = [];
    room.version += 1;
    room.lastActivity = Date.now();

    // Persist the restored state as the new base.
    const state = Y.encodeStateAsUpdate(room.ydoc);
    await this.store.createSnapshot({
      id: this.store.newId(),
      documentId: docId,
      version: room.version,
      state: b64encode(state),
      lastUpdateId: room.lastUpdateId,
      note: `rollback to v${snap.version}`,
      createdBy: userId,
    });
    await this.store.deleteUpdatesUpTo(docId, room.lastUpdateId);
    await this.store.pruneSnapshots(docId, this.maxSnapshots);
    await this.store.touchDocument(docId);

    const payload = { state: b64encode(state), version: room.version };
    this.io.to(`doc:${docId}`).emit('doc:reset', payload);
    return { version: room.version };
  }

  // ---- presence ----

  joinPresence(room, socketId, info) {
    room.clients.set(socketId, { ...info, lastSeen: Date.now() });
    room.lastActivity = Date.now();
  }

  heartbeat(docId, socketId) {
    const room = this.rooms.get(docId);
    const c = room?.clients.get(socketId);
    if (c) c.lastSeen = Date.now();
  }

  collaborators(room) {
    return [...room.clients.entries()].map(([socketId, c]) => ({
      socketId,
      userId: c.userId,
      name: c.name,
      color: c.color,
      awarenessId: c.awarenessId,
    }));
  }

  // Remove a socket from a room; tell everyone else to drop its cursor.
  leaveRoom(docId, socket) {
    const room = this.rooms.get(docId);
    if (!room) return;
    const c = room.clients.get(socket.id);
    room.clients.delete(socket.id);
    socket.leave(`doc:${docId}`);
    if (c) {
      this.io.to(`doc:${docId}`).emit('awareness:remove', {
        socketId: socket.id,
        awarenessId: c.awarenessId,
      });
    }
    room.lastActivity = Date.now();
  }

  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const [socketId, c] of room.clients) {
        if (now - c.lastSeen > this.presenceTimeoutMs) {
          room.clients.delete(socketId);
          this.io.to(`doc:${room.docId}`).emit('awareness:remove', {
            socketId,
            awarenessId: c.awarenessId,
          });
        }
      }
      // Evict rooms nobody is in anymore (flush first).
      if (room.clients.size === 0 && now - room.lastActivity > this.idleUnloadMs) {
        this.unloadRoom(room.docId).catch((e) =>
          console.error(`[room ${room.docId}] unload failed:`, e.message)
        );
      }
    }
  }

  async unloadRoom(docId) {
    const room = this.rooms.get(docId);
    if (!room) return;
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    await this.saveRoom(room);
    this.rooms.delete(docId);
  }

  async shutdown() {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      await this.saveRoom(room).catch(() => {});
    }
    this.rooms.clear();
  }
}
