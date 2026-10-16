// Thin fetch wrapper: uses VITE_API_URL in production (Render backend),
// relative URLs in dev (Vite proxy). Bearer <redacted> attached automatically.
const API_BASE = import.meta.env.VITE_API_URL || '';

export function getToken() {
  return localStorage.getItem('syncdoc_token');
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const url = API_BASE + path;
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token || getToken() ? { authorization: `Bearer ${token || getToken()}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// Socket.IO also needs the backend URL
export function getApiBase() {
  return API_BASE;
}
