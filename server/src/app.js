// App factory: builds the Express app + HTTP server + Socket.IO without
// binding config to the environment, so tests can inject an in-memory DB
// and short timeouts while production uses real Postgres.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';
import { attachSocket } from './socket.js';
import { authRoutes, shareEntryRoute, documentRoutes } from './routes/http.js';

export function createApp({ store, roomOpts = {}, corsOrigin = '*' }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // CORS for REST API (Socket.IO has its own cors config below)
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', corsOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      rooms: rooms ? rooms.rooms.size : 0,
      updatesReceived: rooms ? rooms.stats.updatesReceived : 0,
    });
  });

  app.use('/api/auth', authRoutes(store));
  app.use('/api', shareEntryRoute(store));

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
    maxHttpBufferSize: 2 * 1024 * 1024,
  });

  const rooms = new RoomManager(store, io, roomOpts);
  // document routes need rooms (snapshots/rollback) — mount after rooms exists
  app.use('/api/documents', documentRoutes(store, rooms));

  attachSocket(io, store, rooms);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[http]', err.message);
    res.status(500).json({ error: 'internal error' });
  });

  return {
    app,
    httpServer,
    io,
    rooms,
    store,
    start(port = 0) {
      return new Promise((resolve) => {
        httpServer.listen(port, () => resolve(httpServer.address().port));
      });
    },
    async stop() {
      await rooms.shutdown();
      io.close();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}
