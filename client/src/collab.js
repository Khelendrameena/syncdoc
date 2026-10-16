// useCollabDoc: owns the Y.Doc, the Socket.IO connection, and the
// awareness (presence/cursor) channel for one document.
//
// Sync model (mirrors the server protocol in server/src/socket.js):
//  - join: send our state vector, server replies with exactly the updates
//    we're missing. Reconnect-after-offline is just a join.
//  - local Y updates -> emit doc:update (or buffer while offline).
//  - remote doc:update -> apply with REMOTE origin (never re-broadcast).
//  - doc:reset (rollback) -> throw away this Y.Doc and start a fresh
//    session; the server sends the full restored state on rejoin.
//  - awareness: our cursor/selection state is broadcast on change;
//    remote states are applied opaquely and never re-broadcast.
import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  removeAwarenessStates,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import { u8ToB64, b64ToU8 } from './lib.js';
import { getApiBase } from './api.js';

function createSession() {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  return { ydoc, awareness };
}

export function useCollabDoc({ docId, token, user }) {
  // `session` is replaced wholesale on doc:reset (rollback).
  const [session, setSession] = useState(createSession);
  const [status, setStatus] = useState('connecting'); // connecting|syncing|online|offline|error
  const [collaborators, setCollaborators] = useState([]);
  const [joinError, setJoinError] = useState(null);
  const socketRef = useRef(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const refreshCollaborators = useCallback((awareness) => {
    const list = [];
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return;
      if (state && state.user) list.push({ clientId, ...state.user });
    });
    setCollaborators(list);
  }, []);

  useEffect(() => {
    const { ydoc, awareness } = sessionRef.current;
    const REMOTE = Symbol('remote');
    let joined = false;
    let offlineBuffer = [];
    let disposed = false;

    awareness.setLocalStateField('user', { name: user.name, color: user.color });

    // Backend URL from env (Render in prod), same-origin in dev via Vite proxy.
    const socket = io(getApiBase() || undefined, { auth: { token }, reconnection: true, reconnectionDelay: 800 });
    socketRef.current = socket;

    const applyRemote = (b64) => Y.applyUpdate(ydoc, b64ToU8(b64), REMOTE);

    // Local edits -> send now, or buffer while offline for the reconnect flush.
    // The server acks every update ({ version } or { error }); a rejection
    // (malformed payload, too large) is logged so it isn't silent.
    const updateAck = (res) => {
      if (res?.error) console.warn('[syncdoc] server rejected update:', res.error);
    };
    const onDocUpdate = (update, origin) => {
      if (origin === REMOTE || disposed) return;
      const enc = u8ToB64(update);
      if (joined && socket.connected) {
        socket.emit('doc:update', { docId, update: enc }, updateAck);
      } else {
        offlineBuffer.push(enc);
      }
    };
    ydoc.on('update', onDocUpdate);

    // Cursor/selection -> broadcast only OUR state, and only when it's
    // our own change (remote applies carry REMOTE origin).
    const onAwarenessUpdate = (_changes, origin) => {
      refreshCollaborators(awareness);
      if (origin === REMOTE || disposed || !joined || !socket.connected) return;
      socket.emit('awareness:update', {
        docId,
        update: u8ToB64(encodeAwarenessUpdate(awareness, [awareness.clientID])),
        awarenessId: awareness.clientID,
      });
    };
    awareness.on('update', onAwarenessUpdate);

    const doJoin = () => {
      setStatus('syncing');
      socket.emit(
        'doc:join',
        {
          docId,
          stateVector: u8ToB64(Y.encodeStateVector(ydoc)),
          awarenessId: awareness.clientID,
        },
        (res) => {
          if (disposed) return;
          if (res.error) {
            setJoinError(res.error);
            setStatus('error');
            return;
          }
          applyRemote(res.state);
          joined = true;
          // Flush offline edits. Idempotent server-side (Yjs dedupes by
          // clientID+clock), so overlap with in-flight sends is safe.
          for (const u of offlineBuffer) socket.emit('doc:update', { docId, update: u }, updateAck);
          offlineBuffer = [];
          // Announce presence now that the server knows us.
          awareness.setLocalStateField('user', { name: user.name, color: user.color });
          setStatus('online');
        }
      );
    };

    socket.on('connect', doJoin);
    socket.on('disconnect', () => {
      joined = false;
      if (!disposed) setStatus('offline');
    });
    socket.on('doc:update', ({ update }) => applyRemote(update));
    socket.on('doc:reset', () => {
      // Rollback: our Y.Doc is stale by definition. Replace the whole
      // session; the effect re-runs and rejoins from the restored state.
      if (!disposed) setSession(createSession());
    });
    socket.on('awareness:update', ({ update }) => {
      applyAwarenessUpdate(awareness, b64ToU8(update), REMOTE);
    });
    socket.on('awareness:remove', ({ awarenessId }) => {
      if (awarenessId != null) removeAwarenessStates(awareness, [awarenessId], REMOTE);
    });

    return () => {
      disposed = true;
      ydoc.off('update', onDocUpdate);
      awareness.off('update', onAwarenessUpdate);
      socket.disconnect();
      ydoc.destroy();
    };
    // Re-runs when `session` is replaced (rollback) or docId/token change.
  }, [docId, token, session, user.name, user.color, refreshCollaborators]);

  return { ydoc: session.ydoc, awareness: session.awareness, status, collaborators, joinError, socket: socketRef.current };
}
