import { notFound } from 'next/navigation';
import { C, nameOf, fmtDuration, fmtTokens, fmtUSD } from '../format';
import { ambientTokenOk, getAmbientSummary } from '../../lib/ambient';
import AutoRefresh from './auto-refresh';

export const dynamic = 'force-dynamic';

export default async function Ambient(props) {
  const sp = (await props.searchParams) || {};
  const k = Array.isArray(sp.k) ? sp.k[0] : sp.k;
  const person = (Array.isArray(sp.person) ? sp.person[0] : sp.person) || 'dhruv';
  const compact = sp.w != null;              // ?w=1 → tiny widget layout (fits a small tile/box)
  if (!ambientTokenOk(k)) notFound();         // page is the real auth boundary

  let d = null, err = null;
  try { d = await getAmbientSummary(person); }
  catch (e) { err = String(e?.message || e); }

  if (compact) return <Compact d={d} person={person} err={err} />;
  return <Full d={d} person={person} err={err} />;
}

// ---- Full-screen layout (phone wallpaper / PWA / big display) ----------------
function Full({ d, person, err }) {
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
        <span style={lbl}>{d?.date} · IST</span>
      </div>
      {err ? <div style={{ color: C.orange, fontSize: 22 }}>data unavailable — retrying…</div> : (
        <>
          <Stat label="💻 Laptop" value={fmtDuration(d?.laptop_min)} color={C.blue} />
          <Stat label="📱 Phone" value={fmtDuration(d?.phone_min)} color={C.orange} />
          <Stat label="🔢 Tokens" value={fmtTokens(d?.tokens)} color={C.green} note={`≈ ${fmtUSD(d?.cost)} notional`} />
        </>
      )}
      <AutoRefresh seconds={60} />
    </main>
  );
}

// ---- Compact layout (small widget tile: top-left, tight, all 3 stats fit) ----
function Compact({ d, person, err }) {
  const wrap = {
    minHeight: '100vh', background: C.bg, color: C.ink, display: 'flex',
    flexDirection: 'column', justifyContent: 'flex-start', gap: 7,
    padding: '10px 12px', boxSizing: 'border-box', overflow: 'hidden',
    fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
  };
  const head = { color: C.muted, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, marginBottom: 2 };
  const Row = ({ label, value, color, sub }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, lineHeight: 1.1 }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 800, color }}>{value}</span>
      {sub ? <span style={{ fontSize: 11, color: C.muted }}>{sub}</span> : null}
    </div>
  );
  return (
    <main style={wrap}>
      <div style={head}>{nameOf(person)} · today</div>
      {err ? <div style={{ color: C.orange, fontSize: 13 }}>unavailable…</div> : (
        <>
          <Row label="💻" value={fmtDuration(d?.laptop_min)} color={C.blue} />
          <Row label="📱" value={fmtDuration(d?.phone_min)} color={C.orange} />
          <Row label="🔢" value={fmtTokens(d?.tokens)} color={C.green} sub={`≈ ${fmtUSD(d?.cost)}`} />
        </>
      )}
      <AutoRefresh seconds={60} />
    </main>
  );
}
