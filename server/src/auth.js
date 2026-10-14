// Authentication: bcrypt password hashing + JWT.
//
// Two token kinds share one secret:
//   - user tokens:  { sub: userId, name, email, role: 'user' }
//   - guest tokens: { sub: 'guest:<rand>', name, role: 'guest', docId }
// Guests are minted from share links and are scoped to a single document.
// Socket.IO authenticates via handshake.auth.token; HTTP via Bearer header.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signUserToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, email: user.email, role: 'user' },
    config.jwtSecret,
    { expiresIn: config.jwtExpiry }
  );
}

export function signGuestToken({ name, docId }) {
  // sub is stable per (docId, name) so the client's deterministic color
  // (colorFor(sub)) matches the server's. Two guests with the same name in
  // the same doc share a color — acceptable, names are user-chosen.
  const clean = name.trim().slice(0, 40);
  return jwt.sign(
    { sub: `guest:${docId}:${clean}`, name: clean, role: 'guest', docId },
    config.jwtSecret,
    { expiresIn: config.guestExpiry }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

// Express middleware: 401 unless a valid Bearer JWT is present.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

// Deterministic per-user color from a small palette, so every client
// renders the same color for the same user without coordination.
const PALETTE = [
  '#e11d48', '#7c3aed', '#2563eb', '#059669',
  '#d97706', '#0891b2', '#db2777', '#65a30d',
];
export function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
