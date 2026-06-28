import 'server-only';

const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // service_role — server-only, bypasses RLS

// Thin PostgREST reader. Always no-store so personal data is never cached/served from a CDN.
export async function sb(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}
