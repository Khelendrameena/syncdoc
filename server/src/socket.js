// Socket.IO wire protocol.
//
// Every socket authenticates at handshake time (auth.token = JWT).
// Rooms are Socket.IO rooms named `doc:<docId>`.
//
// Client -> server:
//   doc:join  { docId, stateVector?, awarenessId } -> ack { state, version, collaborators } | { error }
//   doc:update { docId, update }                      -> broadcast doc:update { update, version }
//   awareness:update { docId, update, awarenessId }    -> broadcast awareness:update (presence/cursors)
//   doc:leave { docId }
//
// Server -> client:
//   doc:init        (sent as the doc:join ack, not a separate event)
//   doc:update      { update, version }
//   doc:reset       { state, version }        (rollback: replace your whole doc)
//   awareness:update { socketId, awarenessId, update }
//   awareness:remove { socketId, awarenessId }
//   presence:join   { socketId, user, awarenessId }
//
// Access rule: the document owner (user JWT) or a guest holding a token
// scoped to this docId (guest JWT) may join. Nothing else.
import { verifyToken, colorFor } from './auth.js';

export function attachSocket(io, store, rooms) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('missing auth token'));
    try {
      socket.user = verifyToken(token);
      next();
    } catch {
      next(new Error('invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    socket.data.docs = new Set();

    const canAccess = (doc) => {
      if (!doc) return false;
      if (user.role === 'guest') return user.docId === doc.id;
      return doc.owner_id === user.sub;
    };

    socket.on('doc:join', async ({ docId, stateVector, awarenessId }, ack = () => {}) => {
      try {
        const doc = await store.getDocument(docId);
        if (!doc) return ack({ error: 'document not found' });
        if (!canAccess(doc)) return ack({ error: 'forbidden' });

        const room = await rooms.getRoom(docId);
        socket.join(`doc:${docId}`);
        socket.data.docs.add(docId);

        const diff = rooms.joinDiff(room, stateVector);
        const color = colorFor(String(user.sub));
        rooms.joinPresence(room, socket.id, {
          userId: user.sub,
          name: user.name,
          color,
          awarenessId: awarenessId ?? null,
        });

        // Tell the rest of the room about the newcomer.
        socket.to(`doc:${docId}`).emit('presence:join', {
          socketId: socket.id,
          user: { id: user.sub, name: user.name, color },
          awarenessId: awarenessId ?? null,
        });

        ack({ state: diff, version: room.version, collaborators: rooms.collaborators(room) });
      } catch (err) {
        ack({ error: err.message });
      }
    });

    socket.on('doc:update', async ({ docId, update }) => {
      if (!socket.data.docs.has(docId)) return; // must join first
      await rooms.handleUpdate(docId, update, socket);
    });

    // Awareness (cursors/selections) is relayed opaquely; the server only
    // uses it to refresh the sender's presence heartbeat.
    socket.on('awareness:update', ({ docId, update, awarenessId }) => {
      if (!socket.data.docs.has(docId)) return;
      rooms.heartbeat(docId, socket.id);
      socket.to(`doc:${docId}`).emit('awareness:update', {
        socketId: socket.id,
        awarenessId,
        update,
      });
    });

    socket.on('doc:leave', ({ docId }) => {
      if (!socket.data.docs.has(docId)) return;
      socket.data.docs.delete(docId);
      rooms.leaveRoom(docId, socket);
    });

    socket.on('disconnect', () => {
      for (const docId of socket.data.docs) rooms.leaveRoom(docId, socket);
      socket.data.docs.clear();
    });
  });
}
