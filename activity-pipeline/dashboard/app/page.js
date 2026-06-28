import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sb } from '../lib/db';

export const dynamic = 'force-dynamic'; // never cache personal data

function lastDays(n) {
  // last n IST dates as yyyy-mm-dd (server may be UTC; shift +5:30, then read UTC fields)
  const out = [];
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(now.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const fmt = (m) => (m >= 60 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}m`);
const num = (x) => Number(x) || 0;

export default async function Page() {
  // Defense in depth: re-check auth at the data layer, not just middleware (CVE-2025-29927).
  const jar = await cookies();
  if (jar.get('auth')?.value !== process.env.DASH_TOKEN) redirect('/login');

  const days = lastDays(7);
  const since = days[0];

  // One failing view must not 500 the whole page.
  const [dailyR, webR, unmappedR] = await Promise.allSettled([
    sb(`v_person_daily?select=person,day,surface,minutes&day=gte.${since}`),
    sb(`v_person_web?select=person,domain,minutes&day=gte.${since}`),
    sb(`v_unmapped_devices?select=device_id`),
  ]);
  const daily = dailyR.status === 'fulfilled' ? dailyR.value : [];
  const web = webR.status === 'fulfilled' ? webR.value : [];
  const unmapped = unmappedR.status === 'fulfilled' ? unmappedR.value : [];
  const loadError = [dailyR, webR, unmappedR].some((r) => r.status === 'rejected');

  // Persons from the UNION of both sources (someone could have web rows but no daily).
  const persons = [...new Set([...daily.map((r) => r.person), ...web.map((r) => r.person)])].sort();

  const byPerson = {};
  for (const p of persons) byPerson[p] = { days: {}, domains: {}, total: 0 };
  for (const r of daily) {
    const b = byPerson[r.person]; if (!b) continue;
    b.days[r.day] = b.days[r.day] || { laptop: 0, phone: 0 };
    b.days[r.day][r.surface] = (b.days[r.day][r.surface] || 0) + num(r.minutes);
    b.total += num(r.minutes);
  }
  for (const r of web) {
    const b = byPerson[r.person]; if (!b) continue;
    b.domains[r.domain] = (b.domains[r.domain] || 0) + num(r.minutes);
  }

  const maxDay = Math.max(1, ...persons.flatMap((p) =>
    days.map((d) => (byPerson[p].days[d]?.laptop || 0) + (byPerson[p].days[d]?.phone || 0))));

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 20px' }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Founder Activity — last 7 days</h1>
      <p style={{ color: '#9aa3b2', marginTop: 0 }}>Laptop = blue, Phone = orange. (IST days.)</p>

      {loadError ? (
        <div style={{ background: '#3a1212', border: '1px solid #7a1a1a', borderRadius: 10,
          padding: '10px 14px', margin: '12px 0', fontSize: 14 }}>
          ⚠️ Some data failed to load — showing partial results.
        </div>
      ) : null}

      {unmapped?.length ? (
        <div style={{ background: '#3a2a12', border: '1px solid #7a5a1a', borderRadius: 10,
          padding: '10px 14px', margin: '12px 0', fontSize: 14 }}>
          ⚠️ Unmapped devices pushing data: {unmapped.map((u) => u.device_id).join(', ')} —
          add them to the <code>devices</code> table.
        </div>
      ) : null}

      {persons.length === 0 ? (
        <p style={{ color: '#9aa3b2' }}>No activity in the last 7 days yet.</p>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${persons.length}, 1fr)`, gap: 20, marginTop: 16 }}>
        {persons.map((p) => {
          const b = byPerson[p];
          const topDomains = Object.entries(b.domains).sort((a, c) => c[1] - a[1]).slice(0, 8);
          return (
            <section key={p} style={{ background: '#181b24', border: '1px solid #2a2f3a', borderRadius: 14, padding: 20 }}>
              <h2 style={{ marginTop: 0, textTransform: 'capitalize' }}>{p}</h2>
              <div style={{ color: '#9aa3b2', fontSize: 13, marginBottom: 12 }}>
                {fmt(b.total)} total this week
              </div>

              {days.map((d) => {
                const lap = b.days[d]?.laptop || 0, ph = b.days[d]?.phone || 0;
                return (
                  <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
                    <span style={{ width: 56, color: '#9aa3b2' }}>{d.slice(5)}</span>
                    <div style={{ flex: 1, height: 14, background: '#0b0d13', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
                      <div style={{ width: `${(lap / maxDay) * 100}%`, background: '#6ea8fe' }} />
                      <div style={{ width: `${(ph / maxDay) * 100}%`, background: '#fbbf24' }} />
                    </div>
                    <span style={{ width: 90, textAlign: 'right', color: '#c9d1e3' }}>
                      {fmt(lap)} / {fmt(ph)}
                    </span>
                  </div>
                );
              })}

              <h3 style={{ fontSize: 14, marginTop: 18, marginBottom: 8 }}>Top laptop sites</h3>
              {topDomains.length ? topDomains.map(([dom, min]) => (
                <div key={dom} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', borderBottom: '1px solid #232838' }}>
                  <span style={{ color: '#c9d1e3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{dom}</span>
                  <span style={{ color: '#9aa3b2' }}>{fmt(min)}</span>
                </div>
              )) : <div style={{ color: '#9aa3b2', fontSize: 13 }}>no web data yet</div>}
            </section>
          );
        })}
      </div>
      )}

      <p style={{ color: '#5b6472', fontSize: 12, marginTop: 28 }}>
        Phone browser sites are not captured yet (app-level only). Laptop minutes = window foreground time.
      </p>
    </main>
  );
}
