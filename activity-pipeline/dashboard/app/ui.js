'use client';
// Shared client UI components. Pure helpers/constants live in ./format (re-exported
// here so existing imports from './ui' keep working).

export * from './format';
import { C, panel, h3 } from './format';

export function Empty() {
  return <div style={{ color: '#5b6472', fontSize: 13, padding: '8px 0' }}>No data in this range.</div>;
}

export function Kpi({ label, value, color, sub }) {
  return (
    <div style={{ ...panel, padding: 18 }}>
      <div style={{ color: C.muted, fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, marginTop: 6, color }}>{value}</div>
      <div style={{ color: C.muted, fontSize: 12, marginTop: 4, minHeight: 15 }}>{sub || ''}</div>
    </div>
  );
}

// Generic ranked list. rows: [{ name, value }]; `format(value)` -> display string.
export function RankList({ title, subtitle, rows, color, loading, format = (v) => v }) {
  const list = rows || [];
  const max = Math.max(1, ...list.map((r) => Number(r.value)));
  return (
    <section style={{ ...panel }}>
      <h3 style={{ ...h3, marginBottom: 2 }}>{title}</h3>
      <div style={{ color: C.muted, fontSize: 11, marginBottom: 12 }}>{subtitle}</div>
      {loading ? <div style={{ color: C.muted, fontSize: 13 }}>…</div> :
        list.length === 0 ? <Empty /> :
        list.slice(0, 12).map((r, i) => (
          <div key={i} style={{ position: 'relative', padding: '6px 8px', marginBottom: 3, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', inset: 0, width: `${(Number(r.value) / max) * 100}%`, background: color, opacity: 0.16 }} />
            <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{r.name}</span>
              <span style={{ color: C.muted, flexShrink: 0 }}>{format(r.value)}</span>
            </div>
          </div>
        ))}
    </section>
  );
}
