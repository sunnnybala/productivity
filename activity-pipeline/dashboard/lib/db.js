import 'server-only';

const BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // service_role — server-only, bypasses RLS

const headers = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}` });

// GET against PostgREST (no-store so personal data is never cached).
export async function sb(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, { headers: headers(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

// Call a Postgres function (server-side aggregation).
export async function rpc(fn, body) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}: ${await res.text()}`);
  return res.json();
}
