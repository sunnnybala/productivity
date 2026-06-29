'use client';

import { useState } from 'react';
import { C } from './ui';
import Dashboard from './dashboard';
import Tokens from './tokens';

export default function ViewSwitch({ persons }) {
  const [view, setView] = useState('activity');
  return (
    <main style={{ minHeight: '100vh', background: C.bg, color: C.ink,
      fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 20px 0' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['activity', 'Activity'], ['tokens', 'Tokens']].map(([k, label]) => (
            <button key={k} onClick={() => setView(k)} style={{
              padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${view === k ? C.accent : C.line}`,
              background: view === k ? C.chipBg : 'transparent', color: C.ink,
            }}>{label}</button>
          ))}
        </div>
      </div>
      {view === 'activity' ? <Dashboard persons={persons} /> : <Tokens persons={persons} />}
    </main>
  );
}
