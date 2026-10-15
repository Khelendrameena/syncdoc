# SyncDoc — Real-Time Collaborative Document Editor

A Google-Docs-style collaborative editor: multiple people edit the same
document simultaneously, see each other's cursors and selections live, and
never lose work — even when someone's network drops mid-sentence.

**Why this project exists:** real-time collaboration is one of the few
problems where distributed-systems theory is *visible in the UI*. Two
people typing in the same paragraph at the same time, one of them
offline — the system must converge to one correct document anyway. SyncDoc
proves that with a CRDT (Yjs), a custom sync server, and automated
convergence tests.

## Features

- **Simultaneous editing** — rich-text documents (headings, lists, quotes,
  code blocks) via TipTap, synced live over WebSockets.
- **Live cursors & selections** — per-user colors, name labels, presence
  avatars showing who's in the document.
- **Offline editing** — keep typing with no connection; edits buffer
  locally and merge on reconnect. No data loss, tested.
- **Version history & rollback** — named snapshots, one-click restore;
  the pre-rollback state is auto-preserved so a restore is never
  destructive.
- **Sharing** — invite collaborators with a link; guests get a
  document-scoped token (no account needed).
- **JWT auth** — registered users own documents; guests are fenced to one
  doc.

## Architecture

```mermaid
flowchart LR
    subgraph Clients
        A[TipTap editor\nY.Doc + awareness]
        B[TipTap editor\nY.Doc + awareness]
    end
    subgraph Server ["Node server (Socket.IO)"]
        S[sync protocol\njoin/diff, fan-out]
        R[RoomManager\nY.Doc per doc]
        P[(Postgres\nupdates log +\nsnapshots)]
    end
    A <-->|doc:update / awareness| S
    B <-->|doc:update / awareness| S
    S <--> R
    R -->|debounced flush| P
    R -->|snapshot +\ncompaction| P
```

The server is a **relay + durable log**, not an operation sequencer: Yjs
updates are commutative and idempotent, so the server needs no global
ordering. Socket.IO gives per-connection FIFO; everything beyond that is
handled by the CRDT merge. Join = state-vector sync (the server sends only
the updates you missed), which makes reconnect-after-offline a normal
join. See [docs/protocol.md](docs/protocol.md) and
[docs/ot-vs-crdt.md](docs/ot-vs-crdt.md) (why CRDT instead of OT).

## 5-minute setup

**Option A — Docker (recommended):**

```bash
cp .env.example .env   # set JWT_SECRET (openssl rand -hex 32)
docker compose up --build
# open http://localhost:8080
```

**Option B — local dev, no Docker (needs Postgres 16 + Node 20+):**

```bash
# 1. Create the Postgres role + database (one-time):
sudo -u postgres psql -c "CREATE USER syncdoc WITH PASSWORD 'syncdoc' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE syncdoc OWNER syncdoc;"

# 2. Configure:
cp .env.example .env
# edit .env: set JWT_SECRET (generate one with: openssl rand -hex 32)

# 3. Install and run (two terminals):
npm install
npm run dev:server   # terminal 1 → http://localhost:4000
npm run dev:client   # terminal 2 → http://localhost:5173 (proxied to the server)
# open http://localhost:5173
```

Register an account, create a document, open it in two browser windows
(or an incognito window) and type in both — cursors appear live. Use
*Share* to invite a guest via link.

**Smoke test** (no browser needed — exercises the real wire protocol:
register/login → create doc → 2 socket clients → concurrent edits →
presence):

```bash
# server must be running (Option A or B), then:
node server/scripts/smoke-e2e.mjs --url http://localhost:4000
# expect: 11/11 checks ok, "SMOKE PASS"
```

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://syncdoc:syncdoc@localhost:5432/syncdoc` | Postgres connection |
| `JWT_SECRET` | `dev-secret-change-me` | Token signing — **set in prod** |
| `PORT` | `4000` | Server port |
| `FRONTEND_URL` | `http://localhost:5173` | Used to build share links |
| `SAVE_DEBOUNCE_MS` | `2000` | Write-behind flush delay (crash can lose this much) |
| `PRESENCE_TIMEOUT_MS` / `PRESENCE_SWEEP_MS` | `45000` / `15000` | Stale-presence eviction |
| `IDLE_UNLOAD_MS` | `600000` | Evict empty rooms from memory |
| `SNAPSHOT_EVERY_UPDATES` / `MAX_SNAPSHOTS` | `200` / `30` | Log compaction |

## Tests

```bash
npm test --workspace=server   # 10 scenarios, in-memory Postgres (pg-mem)
```

| Test | What it proves |
|---|---|
| concurrent edits converge | 3 clients insert at the *same* position simultaneously → identical text everywhere, server agrees |
| shuffled update order | updates applied in 3 random orders → identical state |
| duplicate delivery idempotent | same update applied 3× → unchanged (safe at-least-once delivery) |
| offline edits reconcile | client edits offline, reconnects → zero data loss, all replicas converge |
| clean reconnect | reconnect with no offline edits catches up via join diff |
| presence join/leave/disconnect | `awareness:remove` broadcast on hard disconnect |
| heartbeat sweeper | half-dead client (no heartbeats) evicted by sweeper |
| snapshot + rollback | restore returns content; pre-rollback auto-snapshot preserved; all clients reset |
| auth | register/login/401s; guest tokens fenced to one document |

## Load test

```bash
# server must be running (real Postgres), then:
node server/scripts/load-test.js --url http://localhost:4000 --clients 50 --edits 40
```

**Methodology:** N guest clients join one document over WebSocket; each
makes K random insert/delete edits concurrently. Measured: per-client join
latency (join → init ack), server updates received / wall time, and
time-to-converge (last edit → all clients' text identical).

**Results** (re-measured 2026-10-15, build machine, real PostgreSQL 16,
server + clients on the same host over loopback — no network RTT, so treat
latency as a ceiling):

| Clients | Edits/client | Join p50/p95 | Server edits/s* | Time to converge |
|---|---|---|---|---|
| 30 | 40 (1,200 total) | 3 / 12 ms | 627/s | 117 ms |
| 50 | 40 (2,000 total) | 7 / 21 ms | 350/s | 174 ms |

\* The edit loop paces clients with a 0–4 ms sleep between edits, so
edits/s reflects client pacing, not the server ceiling. Every edit was
received by the server and every replica converged (final docs: 6,191 and
10,311 chars). Reproduce on your own hardware with:

```bash
docker compose up --build -d          # or your local Postgres
node server/scripts/load-test.js --url http://localhost:4000 --clients 50 --edits 40
```

Honest caveats: same-host loopback flatters latency; Postgres and Node
share the machine; no TLS. Re-run on your own hardware before quoting —
the script prints everything you need.

## Trade-offs (the interview answers)

- **Write-behind persistence:** updates flush to Postgres ~2s after the
  last edit. A server crash can lose up to that window. Chosen for write
  throughput; a financial system would want write-through.
- **CRDT over OT:** offline editing and reconnect become trivial, at the
  cost of tombstone growth (mitigated by snapshot compaction) and no
  cross-client undo. Full note: [docs/ot-vs-crdt.md](docs/ot-vs-crdt.md).
- **base64 TEXT columns:** Yjs updates are stored base64 in TEXT, not
  BYTEA — the in-memory test Postgres (pg-mem) corrupts BYTEA round-trips,
  and TEXT is lossless on both. ~33% storage overhead, irrelevant here.
- **Rollback = state reset:** CRDT history is append-only, so "going back"
  swaps the whole document state and broadcasts `doc:reset`, rather than
  surgical history rewriting. Simple, correct, and clients handle it by
  rejoining.
- **Guest identity:** share-link guests are `guest:<docId>:<name>` — stable
  so colors match everywhere; two guests with the same name share a color.

## Project structure

```
server/src/
  index.js        production entry (real Postgres, graceful shutdown)
  app.js          app factory (injectable store — used by tests)
  config.js       all tunables, documented
  db.js           Postgres store: users, documents, update log, snapshots, shares
  auth.js         bcrypt + JWT (user & guest tokens), deterministic colors
  rooms.js        RoomManager: Y.Doc rooms, sync, write-behind, snapshots,
                  rollback, presence heartbeats, idle eviction
  socket.js       Socket.IO protocol (join/diff, fan-out, awareness relay)
  routes/http.js  REST: auth, documents, sharing, snapshots, rollback
server/scripts/
  load-test.js    N-client convergence/throughput benchmark (real Postgres)
  smoke-e2e.mjs  no-browser end-to-end smoke test (11 protocol checks)
server/tests/     convergence, ordering, reconnect, presence, snapshots, auth
client/src/
  collab.js       the sync engine: Y.Doc + socket + awareness wiring
  components.jsx  StatusPill, ConnectionBanner (shared UI)
  pages/          Login, Dashboard, EditorPage (TipTap), ShareJoin
  lib.js          deterministic colors, chunked base64
docs/             protocol.md, ot-vs-crdt.md
```

## Resume bullets (fill [placeholders] with your measured numbers)

- Built a real-time collaborative editor (Node.js, Socket.IO, Yjs CRDT,
  React/TipTap, Postgres) supporting [N] concurrent editors with [X] ms
  p95 update latency; implemented state-vector sync so offline edits merge
  losslessly on reconnect.
- Designed a write-behind persistence layer (debounced Postgres flush,
  snapshot compaction) and version history with one-click rollback;
  automated tests prove convergence under simultaneous same-region edits
  and out-of-order delivery.
- Shipped presence with heartbeat-based stale-client eviction, JWT auth
  with document-scoped guest share links, Docker Compose one-command
  deploy, and GitHub Actions CI.
