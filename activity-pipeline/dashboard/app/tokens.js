'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  C, inp, panel, h3, PRESETS, nameOf, istToday, addDays,
  fmtTokens, fmtUSD, Empty, Kpi, RankList,
} from './ui';

const BUCKETS = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

export default function Tokens({ persons }) {
  const today = istToday();
  const [person, setPerson] = useState(persons[0]);
  const [preset, setPreset] = useState('30d');
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [bucket, setBucket] = useState('day');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  const applyPreset = (p) => { setPreset(p.key); setTo(today); setFrom(addDays(today, -p.days)); };

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/tokens?person=${encodeURIComponent(person)}&from=${from}&to=${to}&bucket=${bucket}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(await r.text());
      const json = await r.json();
      if (id !== reqId.current) return;
      setData(json);
    } catch (e) {
      if (id !== reqId.current) return;
      setError(String(e.message || e)); setData(null);
    }
    if (id === reqId.current) setLoading(false);
  }, [person, from, to, bucket]);

  useEffect(() => { load(); }, [load]);

  const series = data?.series || [];
  const maxB = Math.max(1, ...series.map((s) => Number(s.tokens)));
  const toRows = (arr) => (arr || []).map((r) => ({ name: r.name, value: r.tokens }));

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '8px 20px 64px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 24, margin: 0, letterSpacing: -0.4 }}>Tokens</h1>
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

      {/* Date + granularity controls */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {PRESETS.filter((p) => p.key !== 'today').map((p) => (
          <button key={p.key} onClick={() => applyPreset(p)} style={{
            padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
            border: `1px solid ${preset === p.key ? C.accent : C.line}`,
            background: preset === p.key ? C.chipBg : 'transparent', color: C.ink,
          }}>{p.label}</button>
        ))}
        <input type="date" value={from} max={to} onChange={(e) => { setPreset(''); setFrom(e.target.value); }} style={inp} />
        <span style={{ color: C.muted }}>–</span>
        <input type="date" value={to} min={from} max={today} onChange={(e) => { setPreset(''); setTo(e.target.value); }} style={inp} />
        <span style={{ color: C.muted, fontSize: 12, marginLeft: 10 }}>by</span>
        {BUCKETS.map((b) => (
          <button key={b.key} onClick={() => setBucket(b.key)} style={{
            padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
            border: `1px solid ${bucket === b.key ? C.accent : C.line}`,
            background: bucket === b.key ? C.chipBg : 'transparent', color: C.ink,
          }}>{b.label}</button>
        ))}
      </div>

      {error && <div style={{ ...panel, borderColor: '#7a1a1a', background: '#2a1212', marginTop: 20 }}>⚠️ {error}</div>}

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 20, opacity: loading ? 0.5 : 1 }}>
        <Kpi label="🔢 Tokens (range)" value={fmtTokens(data?.total_tokens)} color={C.green}
          sub={data ? `${fmtTokens(data?.io_tokens)} input+output (rest cache)` : null} />
        <Kpi label="≈ Notional $" value={fmtUSD(data?.total_cost)} color={C.orange}
          sub="API-equiv · not billed" />
        <Kpi label="∞ All-time" value={fmtTokens(data?.alltime_tokens)} color={C.ink}
          sub={data ? `${fmtUSD(data?.alltime_cost)} notional` : null} />
      </div>

      {/* Series chart: io (solid) + cache (faded) */}
      <section style={{ ...panel, marginTop: 16 }}>
        <h3 style={h3}>By {bucket} — <span style={{ color: C.green }}>input+output</span> /{' '}
          <span style={{ color: C.green, opacity: 0.45 }}>cache</span></h3>
        {series.length === 0 && !loading ? <Empty /> :
          series.map((s) => {
            const tok = Number(s.tokens), io = Number(s.io_tokens) || 0;
            const cache = Math.max(0, tok - io);
            return (
              <div key={s.bucket} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '7px 0', fontSize: 12 }}>
                <span style={{ width: 74, color: C.muted }}>{s.bucket}</span>
                <div style={{ flex: 1, height: 16, background: '#0a0c11', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
                  <div title={`input+output ${fmtTokens(io)}`} style={{ width: `${(io / maxB) * 100}%`, background: C.green }} />
                  <div title={`cache ${fmtTokens(cache)}`} style={{ width: `${(cache / maxB) * 100}%`, background: C.green, opacity: 0.4 }} />
                </div>
                <span style={{ width: 130, textAlign: 'right', color: '#c9d1e3' }}>{fmtTokens(tok)} · {fmtUSD(s.cost)}</span>
              </div>
            );
          })}
      </section>

      {/* Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginTop: 16 }}>
        <RankList title="🛠 By tool" subtitle="Claude Code / Codex" rows={toRows(data?.by_tool)} color={C.green} loading={loading} format={fmtTokens} />
        <RankList title="🧠 By model" subtitle="tokens" rows={toRows(data?.by_model)} color={C.green} loading={loading} format={fmtTokens} />
      </div>

      <p style={{ color: '#5b6472', fontSize: 11, marginTop: 26 }}>
        $ is notional (API list prices); on a Max/Pro plan you pay a flat fee, so this is value
        extracted, not a bill. Most tokens are cache-reads (cheap) — the chart splits input+output
        from cache. OpenClaw is excluded. Days bucketed IST.
      </p>
    </div>
  );
}
