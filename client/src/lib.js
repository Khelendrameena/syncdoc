// Deterministic per-user color. MUST match server/src/auth.js palette+hash
// so every client renders the same color for the same user id.
const PALETTE = [
  '#e11d48', '#7c3aed', '#2563eb', '#059669',
  '#d97706', '#0891b2', '#db2777', '#65a30d',
];

export function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Chunked base64 helpers: btoa/atob choke on huge single strings, and
// Yjs updates can be large on initial sync.
export function u8ToB64(u8) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function b64ToU8(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
