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

  const active = Number(act?.laptop_active_min) || 0;
  const phone = Number(act?.phone_min) || 0;
  const tokens = Number(tok?.total_tokens) || 0;
  const cost = Number(tok?.total_cost) || 0;
  const apps = (act?.laptop_apps || []).slice(0, 4);

  const wrap = {
    minHeight: '100vh', background: C.bg, color: C.ink, display: 'flex',
    flexDirection: 'column', justifyContent: 'center', gap: 28,
    padding: 'clamp(24px, 6vw, 80px)', boxSizing: 'border-box',
    fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
  };
  const big = { fontSize: 'clamp(48px, 13vw, 150px)', fontWeight: 800, letterSpacing: -2, lineHeight: 0.95 };
  const lbl = { color: C.muted, fontSize: 'clamp(12px, 2.4vw, 18px)', textTransform: 'uppercase', letterSpacing: 2 };
  const sub = { fontSize: 'clamp(20px, 4.5vw, 44px)', fontWeight: 700 };

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
          <div>
            <div style={lbl}>💻 active</div>
            <div style={{ ...big, color: C.blue }}>{fmtDuration(active)}</div>
          </div>

          <div style={{ display: 'flex', gap: 'clamp(24px, 8vw, 90px)', flexWrap: 'wrap' }}>
            <div>
              <div style={lbl}>📱 phone</div>
              <div style={{ ...sub, color: C.orange }}>{fmtDuration(phone)}</div>
            </div>
            <div>
              <div style={lbl}>🔢 tokens</div>
              <div style={{ ...sub, color: C.green }}>
                {fmtTokens(tokens)} <span style={{ color: C.muted, fontSize: '0.5em', fontWeight: 500 }}>≈ {fmtUSD(cost)} notional</span>
              </div>
            </div>
          </div>

          <div>
            <div style={lbl}>top apps</div>
            <div style={{ fontSize: 'clamp(14px, 2.8vw, 22px)', color: '#c9d1e3', marginTop: 6 }}>
              {apps.length === 0 ? '—' : apps.map((a, i) => (
                <span key={i}>{i > 0 ? '  ·  ' : ''}{a.name} <span style={{ color: C.muted }}>{fmtDuration(a.minutes)}</span></span>
              ))}
            </div>
          </div>
        </>
      )}

      <AutoRefresh seconds={60} />
    </main>
  );
}
