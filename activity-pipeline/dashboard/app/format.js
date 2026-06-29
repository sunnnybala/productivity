// Pure helpers + constants — NO 'use client', so both server components (e.g. /ambient)
// and client components (dashboard, tokens) can import and call these.

export const NAMES = { dhruv: 'Dhruv', cofounder: 'Ria' };
export const nameOf = (p) => NAMES[p] || p;

export const C = {
  bg: '#0e1015', card: '#171a22', ink: '#e8eaf0', muted: '#8b94a7', line: '#262b36',
  blue: '#5b9dff', orange: '#f6b352', green: '#6ee7a8', chipBg: '#1f2430', accent: '#5b9dff',
};

export const inp = { background: C.card, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 8, padding: '5px 8px', fontSize: 13, colorScheme: 'dark' };
export const panel = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 };
export const h3 = { margin: '0 0 12px', fontSize: 14, fontWeight: 600 };

export const PRESETS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 6 },
  { key: '14d', label: '14 days', days: 13 },
  { key: '30d', label: '30 days', days: 29 },
];

// IST-local yyyy-mm-dd helpers (server buckets days in Asia/Kolkata).
export function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// minutes -> "1h 5m"
export function fmtDuration(m) {
  m = Math.round(Number(m) || 0);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
// tokens -> "1.70B" / "340.2M" / "12.3K" / "945"
export function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
// dollars -> "$2,169"
export function fmtUSD(n) {
  return `$${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
