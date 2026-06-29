import 'server-only';
import { rpc } from './db';
import { istToday, fmtDuration, fmtTokens, fmtUSD } from '../app/format';

// Token guard for the ambient surfaces (/ambient page + /api/ambient.json).
// Fail closed: unset/short AMBIENT_TOKEN denies everything.
export function ambientTokenOk(k) {
  const t = process.env.AMBIENT_TOKEN?.trim();
  return !!t && t.length >= 32 && k === t;
}

export const AMBIENT_SEC_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

// Today's 3 stats for one person — shared by the page and the JSON endpoint (no drift).
export async function getAmbientSummary(person = 'dhruv') {
  const today = istToday();
  const [act, tok] = await Promise.all([
    rpc('dashboard_summary', { p_person: person, p_from: today, p_to: today }),
    rpc('token_summary', { p_person: person, p_from: today, p_to: today, p_bucket: 'day' }),
  ]);
  const laptop_min = Number(act?.laptop_min) || 0;
  const phone_min = Number(act?.phone_min) || 0;
  const tokens = Number(tok?.total_tokens) || 0;
  const cost = Number(tok?.total_cost) || 0;
  return {
    person, date: today,
    laptop_min, phone_min, tokens, cost,
    // preformatted strings so dumb widgets (Rainmeter) can print without math
    laptop_fmt: fmtDuration(laptop_min),
    phone_fmt: fmtDuration(phone_min),
    tokens_fmt: fmtTokens(tokens),
    cost_fmt: fmtUSD(cost),
  };
}
