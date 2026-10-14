// Thin fetch wrapper: relative URLs (same-origin in prod, Vite proxy in dev),
// Bearer token attached automatically.
export function getToken() {
  return localStorage.getItem('syncdoc_token');
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(path, {
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
