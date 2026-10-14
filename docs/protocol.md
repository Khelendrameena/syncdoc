# SyncDoc wire protocol

Transport: Socket.IO (WebSocket with long-polling fallback). All payloads
are JSON; Yjs binary updates travel as base64 strings (debuggable, and it
keeps the protocol identical to the TEXT-column storage format).

## Authentication

- HTTP: `Authorization: Bearer <JWT>`.
- Socket.IO: `handshake.auth.token = <JWT>` (rejected at handshake if
  missing/invalid — no unauthenticated socket ever joins a room).
- Two token kinds: **user** (`{ sub: userId, role: 'user' }`) and **guest**
  (`{ sub: 'guest:<docId>:<name>', role: 'guest', docId }`), the latter
  minted from a share link and scoped to one document.

## Access rule

Owner (user JWT, `doc.owner_id === sub`) or guest (guest JWT,
`docId` matches) may join. Everything else is `forbidden`.

## Events

### Client → server

| Event | Payload | Effect |
|---|---|---|
| `doc:join` | `{ docId, stateVector?, awarenessId? }` → ack | Auth check, load room (snapshot + log replay), join Socket.IO room, register presence. Ack: `{ state, version, collaborators }` or `{ error }`. `state` is exactly the updates the client is missing (state-vector diff), so reconnect is just a join. |
| `doc:update` | `{ docId, update }` | Apply to room CRDT (commutative/idempotent — duplicates and out-of-order arrivals converge), bump version, fan out `doc:update` to the rest of the room, schedule debounced Postgres flush. Ignored if the socket never joined. |
| `awareness:update` | `{ docId, update, awarenessId }` | Refresh sender's presence heartbeat; relay opaquely to the room. Server never interprets cursor bytes. |
| `doc:leave` | `{ docId }` | Remove presence, broadcast `awareness:remove`. |

### Server → client

| Event | Payload | Meaning |
|---|---|---|
| `doc:update` | `{ update, version }` | A peer's edit. Apply with a `REMOTE` origin so it's never re-broadcast. |
| `doc:reset` | `{ state, version }` | Rollback happened: replace your whole Y.Doc with `state`. |
| `awareness:update` | `{ socketId, awarenessId, update }` | A peer's cursor/selection. Apply to local awareness with `REMOTE` origin. |
| `awareness:remove` | `{ socketId, awarenessId }` | Peer left or timed out: drop their cursor. |
| `presence:join` | `{ socketId, user, awarenessId }` | Someone entered the room (their cursor state arrives separately via `awareness:update`). |

## Ordering & delivery guarantees

- Socket.IO gives **per-connection FIFO**; there is **no global ordering**
  across clients, and the server deliberately does not add one.
- Safety comes from the CRDT: updates are **commutative** (any apply order
  converges — tested in `tests/ordering.test.js`) and **idempotent**
  (re-applying an update is a no-op — tested). This is what makes
  at-least-once delivery (reconnect flush overlapping in-flight sends)
  correct without ACKs or sequence numbers.

## Presence & heartbeats

- Every `awareness:update` refreshes the sender's `lastSeen`.
- Socket `disconnect` removes presence immediately and broadcasts
  `awareness:remove`.
- Backstop: a server sweeper (default every 15s) evicts entries with
  `lastSeen` older than 45s — covers half-dead connections whose socket
  never fired `disconnect`. Both paths are tested.

## Version history

- Snapshots are full Yjs states + a monotonic `version` counter, listed
  oldest→newest with note/author/timestamp.
- Rollback = state reset, not history surgery: flush, auto-snapshot the
  current state ("auto: pre-rollback" — nothing is ever lost), swap the
  room's Y.Doc for the snapshot's, persist, bump version, broadcast
  `doc:reset`. Clients replace their local doc wholesale.
