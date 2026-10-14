// Centralized, documented configuration. Every knob the server uses is here,
// overridable via environment. Tests inject overrides via createApp().
export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://syncdoc:syncdoc@localhost:5432/syncdoc',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiry: process.env.JWT_EXPIRY || '7d',
  // Guest tokens minted from share links are deliberately short-lived.
  guestExpiry: process.env.GUEST_EXPIRY || '24h',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  // Persistence: updates are appended to Postgres after this quiet period.
  // Larger = fewer writes, more data at risk on crash. 2s is a sane default.
  saveDebounceMs: parseInt(process.env.SAVE_DEBOUNCE_MS || '2000', 10),

  // Presence: a client is considered gone if we haven't seen an
  // awareness heartbeat from its socket for this long. The sweeper runs
  // every presenceSweepMs. (Socket disconnect is handled immediately;
  // the sweeper is the backstop for half-dead connections.)
  presenceTimeoutMs: parseInt(process.env.PRESENCE_TIMEOUT_MS || '45000', 10),
  presenceSweepMs: parseInt(process.env.PRESENCE_SWEEP_MS || '15000', 10),

  // Room lifecycle: an empty room is flushed to Postgres and evicted from
  // memory after this long with no clients.
  idleUnloadMs: parseInt(process.env.IDLE_UNLOAD_MS || '600000', 10),

  // Snapshots: compact the updates log into a full-state snapshot after
  // this many updates accumulate; keep at most maxSnapshots per document.
  snapshotEveryUpdates: parseInt(process.env.SNAPSHOT_EVERY_UPDATES || '200', 10),
  maxSnapshots: parseInt(process.env.MAX_SNAPSHOTS || '30', 10),

  // Safety valve against a malicious/buggy client flooding the room.
  maxUpdateBytes: parseInt(process.env.MAX_UPDATE_BYTES || String(1024 * 1024), 10),
};
