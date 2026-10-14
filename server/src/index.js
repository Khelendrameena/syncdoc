// Production entrypoint: real Postgres pool, env config, graceful shutdown.
import 'dotenv/config';
import pg from 'pg';
import { config } from './config.js';
import { createStore } from './db.js';
import { createApp } from './app.js';

if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set — using an insecure dev default. Set it in production.');
}

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});
const store = createStore(pool);
await store.init();

const { httpServer, rooms } = createApp({ store, corsOrigin: config.frontendUrl });

httpServer.listen(config.port, () => {
  console.log(`[syncdoc] listening on :${config.port}`);
});

const shutdown = async () => {
  console.log('[syncdoc] shutting down…');
  await rooms.shutdown();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
