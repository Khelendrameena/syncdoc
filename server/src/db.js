// Postgres persistence layer.
//
// Design: the CRDT log is append-only. Every client update lands in
// `document_updates`; periodically we compact into a full-state snapshot
// (`document_snapshots`) and delete the updates it covers. Loading a room =
// latest snapshot + updates after it. This is the standard event-sourcing
// pattern and keeps both write throughput and load time bounded.
//
// The store is a factory over an injected pool so tests can substitute an
// in-memory Postgres (pg-mem) without touching this code.
import { randomUUID } from 'node:crypto';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Binary payloads (Yjs updates, snapshots) are stored as base64 TEXT, not
-- BYTEA. Rationale: the test double (pg-mem) round-trips BYTEA through a
-- lossy text encoding and corrupts arbitrary binary; TEXT+base64 is
-- lossless on both pg-mem and real Postgres. Cost is ~33% larger blobs,
-- irrelevant at this scale. The wire protocol is base64 too, so this is
-- consistent end to end.
CREATE TABLE IF NOT EXISTS document_updates (
  id BIGSERIAL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  update TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_updates_doc ON document_updates(document_id, id);

CREATE TABLE IF NOT EXISTS document_snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version BIGINT NOT NULL,
  state TEXT NOT NULL,
  last_update_id BIGINT NOT NULL DEFAULT 0,
  note TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_doc ON document_snapshots(document_id, version);

CREATE TABLE IF NOT EXISTS document_shares (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export function createStore(pool) {
  return {
    pool,
    newId: () => randomUUID(),

    async init() {
      await pool.query(SCHEMA);
    },

    // ---- users ----
    async createUser({ id, name, email, passwordHash }) {
      const { rows } = await pool.query(
        'INSERT INTO users (id, name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, email, created_at',
        [id, name, email, passwordHash]
      );
      return rows[0];
    },
    async findUserByEmail(email) {
      const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      return rows[0] || null;
    },
    async findUserById(id) {
      const { rows } = await pool.query('SELECT id, name, email, created_at FROM users WHERE id = $1', [id]);
      return rows[0] || null;
    },

    // ---- documents ----
    async createDocument({ id, title, ownerId }) {
      const { rows } = await pool.query(
        'INSERT INTO documents (id, title, owner_id) VALUES ($1,$2,$3) RETURNING *',
        [id, title, ownerId]
      );
      return rows[0];
    },
    async listDocuments(ownerId) {
      const { rows } = await pool.query(
        'SELECT * FROM documents WHERE owner_id = $1 ORDER BY updated_at DESC',
        [ownerId]
      );
      return rows;
    },
    async getDocument(id) {
      const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
      return rows[0] || null;
    },
    async deleteDocument(id) {
      await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    },
    async touchDocument(id) {
      await pool.query('UPDATE documents SET updated_at = now() WHERE id = $1', [id]);
    },

    // ---- update log ----
    // Returns the allocated update ids (BIGSERIAL) in order.
    // `updates` are base64 strings (see schema note on TEXT vs BYTEA).
    async appendUpdates(documentId, updates) {
      if (!updates.length) return [];
      // One multi-row INSERT keeps this a single round-trip.
      const values = updates.map((_, i) => `($1, $${i + 2})`).join(',');
      const params = [documentId, ...updates];
      const { rows } = await pool.query(
        `INSERT INTO document_updates (document_id, update) VALUES ${values} RETURNING id`,
        params
      );
      return rows.map((r) => Number(r.id));
    },
    async getUpdatesAfter(documentId, afterId) {
      const { rows } = await pool.query(
        'SELECT id, update FROM document_updates WHERE document_id = $1 AND id > $2 ORDER BY id ASC',
        [documentId, afterId]
      );
      return rows;
    },
    async countUpdates(documentId) {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM document_updates WHERE document_id = $1',
        [documentId]
      );
      return rows[0].n;
    },
    async deleteUpdatesUpTo(documentId, updateId) {
      await pool.query('DELETE FROM document_updates WHERE document_id = $1 AND id <= $2', [
        documentId,
        updateId,
      ]);
    },

    // ---- snapshots ----
    async createSnapshot({ id, documentId, version, state, lastUpdateId, note, createdBy }) {
      const { rows } = await pool.query(
        `INSERT INTO document_snapshots
           (id, document_id, version, state, last_update_id, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version, note, created_at`,
        [id, documentId, version, state, lastUpdateId, note, createdBy]
      );
      return rows[0];
    },
    async listSnapshots(documentId) {
      const { rows } = await pool.query(
        `SELECT s.id, s.version, s.note, s.created_at,
                COALESCE(u.name, 'guest') AS created_by_name
         FROM document_snapshots s LEFT JOIN users u ON u.id = s.created_by
         WHERE s.document_id = $1 ORDER BY s.version ASC`,
        [documentId]
      );
      return rows;
    },
    async getSnapshot(id) {
      const { rows } = await pool.query('SELECT * FROM document_snapshots WHERE id = $1', [id]);
      return rows[0] || null;
    },
    async pruneSnapshots(documentId, keep) {
      await pool.query(
        `DELETE FROM document_snapshots
         WHERE document_id = $1 AND id NOT IN (
           SELECT id FROM document_snapshots WHERE document_id = $1 ORDER BY version DESC LIMIT $2
         )`,
        [documentId, keep]
      );
    },

    // ---- share links ----
    async createShare({ id, documentId, token }) {
      const { rows } = await pool.query(
        'INSERT INTO document_shares (id, document_id, token) VALUES ($1,$2,$3) RETURNING token, created_at',
        [id, documentId, token]
      );
      return rows[0];
    },
    async getShareByToken(token) {
      const { rows } = await pool.query(
        `SELECT s.*, d.title AS document_title FROM document_shares s
         JOIN documents d ON d.id = s.document_id WHERE s.token = $1`,
        [token]
      );
      return rows[0] || null;
    },
  };
}
