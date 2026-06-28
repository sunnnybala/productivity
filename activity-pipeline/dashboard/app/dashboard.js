'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

const NAMES = { dhruv: 'Dhruv', cofounder: 'Ria' };
const nameOf = (p) => NAMES[p] || p;

// IST-local yyyy-mm-dd helpers (server buckets days in Asia/Kolkata).
function istToday() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmt(m) {
  m = Math.round(Number(m) || 0);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

const C = {
  bg: '#0e1015', card: '#171a22', ink: '#e8eaf0', muted: '#8b94a7', line: '#262b36',
  blue: '#5b9dff', orange: '#f6b352', chipBg: '#1f2430', accent: '#5b9dff',
};

const PRESETS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 6 },
  { key: '14d', label: '14 days', days: 13 },
  { key: '30d', label: '30 days', days: 29 },
];

export default function Dashboard({ persons }) {
  const today = istToday();
  const [person, setPerson] = useState(persons[0]);
  const [preset, setPreset] = useState('7d');
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reqId = useRef(0); // last-request-wins guard against out-of-order responses

  const applyPreset = (p) => {
    setPreset(p.key);
    setTo(today);
    setFrom(addDays(today, -p.days));
  };

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/data?person=${encodeURIComponent(person)}&from=${from}&to=${to}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(await r.text());
      const json = await r.json();
      if (id !== reqId.current) return;          // a newer request superseded this one
      setData(json);
    } catch (e) {
      if (id !== reqId.current) return;
      setError(String(e.message || e)); setData(null);
    }
    if (id === reqId.current) setLoading(false);
  }, [person, from, to]);

  useEffect(() => { load(); }, [load]);

  const days = data?.days || [];
  const maxDay = Math.max(1, ...days.map((d) => Number(d.laptop) + Number(d.phone)));
  const focused = Number(data?.laptop_min) || 0;
  const active = Number(data?.laptop_active_min) || 0;
  const pctHands = focused > 0 ? Math.round((active / focused) * 100) : 0;
  const total = focused + (Number(data?.phone_min) || 0);

  return (
    <main style={{ minHeight: '100vh', background: C.bg, color: C.ink,
      fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 20px 64px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <h1 style={{ fontSize: 24, margin: 0, letterSpacing: -0.4 }}>Activity Dashboard</h1>
          <span style={{ color: C.muted, fontSize: 13 }}>{from} → {to} · IST</span>
        </div>

        {/* Person tabs */}
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          {persons.map((p) => (
            <button key={p} onClick={() => setPerson(p)} style={{
              padding: '8px 18px', borderRadius: 999, fontSize: 14, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${person === p ? C.accent : C.line}`,
              background: person === p ? C.accent : 'transparent',
              color: person === p ? '#06122b' : C.ink,
            }}>{nameOf(p)}</button>
          ))}
        </div>

        {/* Date controls */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button key={p.key} onClick={() => applyPreset(p)} style={{
              padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${preset === p.key ? C.accent : C.line}`,
              background: preset === p.key ? C.chipBg : 'transparent', color: C.ink,
            }}>{p.label}</button>
          ))}
          <span style={{ color: C.muted, fontSize: 12, marginLeft: 6 }}>custom</span>
          <input type="date" value={from} max={to} onChange={(e) => { setPreset(''); setFrom(e.target.value); }}
            style={inp} />
          <span style={{ color: C.muted }}>–</span>
          <input type="date" value={to} min={from} max={today} onChange={(e) => { setPreset(''); setTo(e.target.value); }}
            style={inp} />
        </div>

        {error && <div style={{ ...panel, borderColor: '#7a1a1a', background: '#2a1212', marginTop: 20 }}>⚠️ {error}</div>}

        {/* KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 20, opacity: loading ? 0.5 : 1 }}>
          <Kpi label="💻 Laptop" value={fmt(focused)} color={C.blue}
            sub={data ? `${fmt(active)} active · ${pctHands}% hands-on` : null} />
          <Kpi label="📱 Phone" value={fmt(data?.phone_min)} color={C.orange} />
          <Kpi label="Σ Total" value={fmt(total)} color={C.ink}
            sub={data ? 'laptop focused + phone' : null} />
        </div>

        {/* Daily chart */}
        <section style={{ ...panel, marginTop: 16 }}>
          <h3 style={h3}>Daily — laptop <span style={{ color: C.blue }}>active</span> /{' '}
            <span style={{ color: C.blue, opacity: 0.45 }}>focused</span> + <span style={{ color: C.orange }}>phone</span></h3>
          {days.length === 0 && !loading ? <Empty /> :
            days.map((d) => {
              const lap = Number(d.laptop);                         // focused
              const act = Number(d.laptop_active) || 0;             // hands-on
              const idle = Math.max(0, lap - act);                  // focused-but-idle
              const ph = Number(d.phone);
              return (
                <div key={d.day} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '7px 0', fontSize: 12 }}>
                  <span style={{ width: 64, color: C.muted }}>{d.day.slice(5)}</span>
                  <div style={{ flex: 1, height: 16, background: '#0a0c11', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
                    <div title={`active ${fmt(act)}`} style={{ width: `${(act / maxDay) * 100}%`, background: C.blue }} />
                    <div title={`focused-only ${fmt(idle)}`} style={{ width: `${(idle / maxDay) * 100}%`, background: C.blue, opacity: 0.4 }} />
                    <div title={`phone ${fmt(ph)}`} style={{ width: `${(ph / maxDay) * 100}%`, background: C.orange }} />
                  </div>
                  <span style={{ width: 130, textAlign: 'right', color: '#c9d1e3' }}>{fmt(lap)} / {fmt(ph)}</span>
                </div>
              );
            })}
        </section>

        {/* Breakdown panels */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 16 }}>
          <RankList title="💻 Websites" subtitle="browser, laptop" rows={data?.sites} color={C.blue} loading={loading} />
          <RankList title="💻 Apps" subtitle="laptop" rows={data?.laptop_apps} color={C.blue} loading={loading} />
          <RankList title="📱 Apps" subtitle="phone" rows={data?.phone_apps} color={C.orange} loading={loading} />
        </div>

        <p style={{ color: '#5b6472', fontSize: 11, marginTop: 26 }}>
          Laptop headline = focused time (a window in foreground). Active = focused minus idle
          (no keyboard/mouse &gt;3 min), so reading, calls and watching show up as the gap. Total =
          laptop focused + phone. Websites are a breakdown of browser time, not added to the total.
          Phone browser sites aren&apos;t captured (app-level only).
        </p>
      </div>
    </main>
  );
}

const inp = { background: C.card, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 8, padding: '5px 8px', fontSize: 13, colorScheme: 'dark' };
const panel = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 };
const h3 = { margin: '0 0 12px', fontSize: 14, fontWeight: 600 };

function Kpi({ label, value, color, sub }) {
  return (
    <div style={{ ...panel, padding: 18 }}>
      <div style={{ color: C.muted, fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, marginTop: 6, color }}>{value}</div>
      <div style={{ color: C.muted, fontSize: 12, marginTop: 4, minHeight: 15 }}>{sub || ''}</div>
    </div>
  );
}

function RankList({ title, subtitle, rows, color, loading }) {
  const list = rows || [];
  const max = Math.max(1, ...list.map((r) => Number(r.minutes)));
  return (
    <section style={{ ...panel }}>
      <h3 style={{ ...h3, marginBottom: 2 }}>{title}</h3>
      <div style={{ color: C.muted, fontSize: 11, marginBottom: 12 }}>{subtitle}</div>
      {loading ? <div style={{ color: C.muted, fontSize: 13 }}>…</div> :
        list.length === 0 ? <Empty /> :
        list.slice(0, 12).map((r, i) => (
          <div key={i} style={{ position: 'relative', padding: '6px 8px', marginBottom: 3, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', inset: 0, width: `${(Number(r.minutes) / max) * 100}%`, background: color, opacity: 0.16 }} />
            <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{r.name}</span>
              <span style={{ color: C.muted, flexShrink: 0 }}>{fmt(r.minutes)}</span>
            </div>
          </div>
        ))}
    </section>
  );
}

function Empty() {
  return <div style={{ color: '#5b6472', fontSize: 13, padding: '8px 0' }}>No data in this range.</div>;
}
