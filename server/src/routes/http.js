import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, signUserToken, signGuestToken, requireAuth } from '../auth.js';
import { config } from '../config.js';

export function authRoutes(store) {
  const r = Router();

  r.post('/register', async (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    if (await store.findUserByEmail(email)) return res.status(409).json({ error: 'email already registered' });
    const user = await store.createUser({
      id: store.newId(),
      name,
      email,
      passwordHash: await hashPassword(password),
    });
    res.status(201).json({ token: signUserToken(user), user });
  });

  r.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email, password required' });
    const user = await store.findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const safe = { id: user.id, name: user.name, email: user.email };
    res.json({ token: signUserToken(safe), user: safe });
  });

  r.get('/me', requireAuth, async (req, res) => {
    const user = await store.findUserById(req.user.sub);
    if (!user) return res.status(401).json({ error: 'user not found' });
    res.json({ user });
  });

  return r;
}

// Guest entry: exchange a share-link token for a doc-scoped guest JWT.
// The guest picks a display name client-side (sent as ?name= or body).
export function shareEntryRoute(store) {
  const r = Router();
  r.post('/share/:token', async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'display name required' });
    const share = await store.getShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: 'invalid share link' });
    const guestToken = signGuestToken({ name: name.trim().slice(0, 40), docId: share.document_id });
    res.json({
      document: { id: share.document_id, title: share.document_title },
      guestToken,
    });
  });
  return r;
}

export function documentRoutes(store, rooms) {
  const r = Router();
  r.use(requireAuth);

  const ownerOnly = async (req, res, next) => {
    const doc = await store.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'document not found' });
    if (req.user.role === 'guest' || doc.owner_id !== req.user.sub) {
      return res.status(403).json({ error: 'owner only' });
    }
    req.doc = doc;
    next();
  };

  // Loads the document for any authenticated user (owner). Used for comments
  // where collaborators should also participate. Guest share-link access is
  // handled by the socket layer; REST comments require a logged-in user.
  const docAccess = async (req, res, next) => {
    const doc = await store.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'document not found' });
    req.doc = doc;
    next();
  };

  r.get('/', async (req, res) => {
    if (req.user.role === 'guest') return res.json({ documents: [] });
    const q = (req.query.q || '').trim();
    if (q) {
      res.json({ documents: await store.searchDocuments(req.user.sub, q.slice(0, 100)) });
    } else {
      res.json({ documents: await store.listDocuments(req.user.sub) });
    }
  });

  r.post('/', async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ error: 'guests cannot create documents' });
    const { title } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
    const doc = await store.createDocument({
      id: store.newId(),
      title: title.trim().slice(0, 200),
      ownerId: req.user.sub,
    });
    res.status(201).json({ document: doc });
  });

  r.get('/:id', ownerOnly, async (req, res) => {
    res.json({ document: req.doc });
  });

  r.delete('/:id', ownerOnly, async (req, res) => {
    await rooms.unloadRoom(req.doc.id);
    await store.deleteDocument(req.doc.id);
    res.json({ ok: true });
  });

  // Share link: returns a token the owner can send to collaborators.
  r.post('/:id/share', ownerOnly, async (req, res) => {
    const token = randomBytes(24).toString('hex');
    await store.createShare({ id: store.newId(), documentId: req.doc.id, token });
    res.status(201).json({ token, url: `${config.frontendUrl}/s/${token}` });
  });

  // ---- version history ----
  r.get('/:id/snapshots', ownerOnly, async (req, res) => {
    res.json({ snapshots: await store.listSnapshots(req.doc.id) });
  });

  r.post('/:id/snapshots', ownerOnly, async (req, res) => {
    const { note } = req.body || {};
    const snap = await rooms.createSnapshot(req.doc.id, {
      note: note?.slice(0, 200) || 'manual snapshot',
      createdBy: req.user.sub,
    });
    res.status(201).json({ snapshot: snap });
  });

  r.post('/:id/rollback', ownerOnly, async (req, res) => {
    const { snapshotId } = req.body || {};
    if (!snapshotId) return res.status(400).json({ error: 'snapshotId required' });
    try {
      const { version } = await rooms.rollback(req.doc.id, snapshotId, req.user.sub);
      res.json({ ok: true, version });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Comments: any collaborator with access can read/add; only the author
  // (or doc owner) can resolve/delete. For shared-link guests, req.user may
  // be minimal — allow if they have doc access.
  r.get('/:id/comments', docAccess, async (req, res) => {
    res.json({ comments: await store.listComments(req.doc.id) });
  });

  r.post('/:id/comments', docAccess, async (req, res) => {
    const { text, anchor } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const c = await store.addComment(
      req.doc.id, req.user.sub, req.user.name || 'anonymous',
      text.trim().slice(0, 2000), (anchor || '').slice(0, 300)
    );
    // broadcast to collaborators in the room
    try { rooms.broadcast(req.doc.id, 'comment:new', { comment: c }); } catch {}
    res.status(201).json({ comment: c });
  });

  r.post('/:id/comments/:cid/resolve', ownerOnly, async (req, res) => {
    const resolved = (req.body || {}).resolved !== false;
    const c = await store.resolveComment(req.params.cid, resolved);
    if (!c) return res.status(404).json({ error: 'not found' });
    try { rooms.broadcast(req.doc.id, 'comment:updated', { comment: c }); } catch {}
    res.json({ comment: c });
  });

  r.delete('/:id/comments/:cid', ownerOnly, async (req, res) => {
    await store.deleteComment(req.params.cid);
    try { rooms.broadcast(req.doc.id, 'comment:deleted', { id: req.params.cid }); } catch {}
    res.json({ ok: true });
  });

  return r;
}
