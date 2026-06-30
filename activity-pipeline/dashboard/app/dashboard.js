'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  C, inp, panel, h3, PRESETS, NAMES, nameOf, istToday, addDays,
  fmtDuration as fmt, Empty, Kpi, RankList,
} from './ui';

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
      if (id !== reqId.current) return;
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
  const pctHands = focused > 0 ? Math.min(100, Math.round((active / focused) * 100)) : 0;
  const total = focused + (Number(data?.phone_min) || 0);
  const toRows = (arr) => (arr || []).map((r) => ({ name: r.name, value: r.minutes }));

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '8px 20px 64px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 24, margin: 0, letterSpacing: -0.4 }}>Activity</h1>
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
        <input type="date" value={from} max={to} onChange={(e) => { setPreset(''); setFrom(e.target.value); }} style={inp} />
        <span style={{ color: C.muted }}>–</span>
        <input type="date" value={to} min={from} max={today} onChange={(e) => { setPreset(''); setTo(e.target.value); }} style={inp} />
      </div>

      {error && <div style={{ ...panel, borderColor: '#7a1a1a', background: '#2a1212', marginTop: 20 }}>⚠️ {error}</div>}

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 20, opacity: loading ? 0.5 : 1 }}>
        <Kpi label="💻 Laptop" value={fmt(focused)} color={C.blue}
          sub={data ? `${fmt(active)} active · ${pctHands}% hands-on` : null} />
        <Kpi label="📱 Phone" value={fmt(data?.phone_min)} color={C.orange} />
        <Kpi label="Σ Total" value={fmt(total)} color={C.ink} sub={data ? 'laptop focused + phone' : null} />
      </div>

      {/* Daily chart */}
      <section style={{ ...panel, marginTop: 16 }}>
        <h3 style={h3}>Daily — laptop <span style={{ color: C.blue }}>active</span> /{' '}
          <span style={{ color: C.blue, opacity: 0.45 }}>focused</span> + <span style={{ color: C.orange }}>phone</span></h3>
        {days.length === 0 && !loading ? <Empty /> :
          days.map((d) => {
            const lap = Number(d.laptop);
            const act = Number(d.laptop_active) || 0;
            const idle = Math.max(0, lap - act);
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
        <RankList title="💻 Websites" subtitle="browser, laptop" rows={toRows(data?.sites)} color={C.blue} loading={loading} format={fmt} />
        <RankList title="💻 Apps" subtitle="laptop" rows={toRows(data?.laptop_apps)} color={C.blue} loading={loading} format={fmt} />
        <RankList title="📱 Apps" subtitle="phone" rows={toRows(data?.phone_apps)} color={C.orange} loading={loading} format={fmt} />
      </div>

      <p style={{ color: '#5b6472', fontSize: 11, marginTop: 26 }}>
        Laptop headline = focused time (a window in foreground). Active = focused minus idle
        (no keyboard/mouse &gt;3 min), so reading, calls and watching show up as the gap. Total =
        laptop focused + phone. Websites are a breakdown of browser time, not added to the total.
        Phone browser sites aren&apos;t captured (app-level only).
      </p>
    </div>
  );
}
