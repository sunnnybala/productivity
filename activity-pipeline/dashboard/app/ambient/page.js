import { notFound } from 'next/navigation';
import { rpc } from '../../lib/db';
import { C, nameOf, fmtDuration, fmtTokens, fmtUSD, istToday } from '../format';
import AutoRefresh from './auto-refresh';

export const dynamic = 'force-dynamic';

// Token guard (Codex #2): unset/short env => deny. Compared again here even though
// middleware already gates /ambient — the page is the real security boundary.
function tokenOk(k) {
  const t = process.env.AMBIENT_TOKEN?.trim();
  return !!t && t.length >= 32 && k === t;
}

export default async function Ambient(props) {
  const sp = (await props.searchParams) || {};
  const k = Array.isArray(sp.k) ? sp.k[0] : sp.k;
  const person = (Array.isArray(sp.person) ? sp.person[0] : sp.person) || 'dhruv';
  if (!tokenOk(k)) notFound();

  const today = istToday();
  let act = null, tok = null, err = null;
  try {
    [act, tok] = await Promise.all([
      rpc('dashboard_summary', { p_person: person, p_from: today, p_to: today }),
      rpc('token_summary', { p_person: person, p_from: today, p_to: today, p_bucket: 'day' }),
    ]);
  } catch (e) {
    err = String(e?.message || e);
  }

  const laptop = Number(act?.laptop_min) || 0;   // time spent (window in foreground)
  const phone = Number(act?.phone_min) || 0;
  const tokens = Number(tok?.total_tokens) || 0;
  const cost = Number(tok?.total_cost) || 0;

  const wrap = {
    minHeight: '100vh', background: C.bg, color: C.ink, display: 'flex',
    flexDirection: 'column', justifyContent: 'center', gap: 'clamp(28px, 6vh, 64px)',
    padding: 'clamp(24px, 6vw, 90px)', boxSizing: 'border-box',
    fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
  };
  const lbl = { color: C.muted, fontSize: 'clamp(13px, 2.4vw, 20px)', textTransform: 'uppercase', letterSpacing: 2 };
  const big = { fontSize: 'clamp(52px, 12vw, 140px)', fontWeight: 800, letterSpacing: -2, lineHeight: 0.95, marginTop: 4 };

  const Stat = ({ label, value, color, note }) => (
    <div>
      <div style={lbl}>{label}</div>
      <div style={{ ...big, color }}>{value}</div>
      {note ? <div style={{ color: C.muted, fontSize: 'clamp(16px, 3vw, 30px)', fontWeight: 600, marginTop: 6 }}>{note}</div> : null}
    </div>
  );

  return (
    <main style={wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ ...lbl, color: C.ink, fontWeight: 700 }}>{nameOf(person)} · today</span>
        <span style={lbl}>{today} · IST</span>
      </div>

      {err ? (
        <div style={{ color: C.orange, fontSize: 22 }}>data unavailable — retrying…</div>
      ) : (
        <>
          <Stat label="💻 Laptop" value={fmtDuration(laptop)} color={C.blue} />
          <Stat label="📱 Phone" value={fmtDuration(phone)} color={C.orange} />
          <Stat label="🔢 Tokens" value={fmtTokens(tokens)} color={C.green} note={`≈ ${fmtUSD(cost)} notional`} />
        </>
      )}

      <AutoRefresh seconds={60} />
    </main>
  );
}
