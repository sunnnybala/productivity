'use client';

export default function Error({ error, reset }) {
  return (
    <main style={{ maxWidth: 600, margin: '80px auto', padding: 24 }}>
      <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
      <p style={{ color: '#9aa3b2' }}>{error?.message || 'Failed to load the dashboard.'}</p>
      <button onClick={() => reset()}
        style={{ padding: '8px 16px', borderRadius: 8, border: 0, background: '#6ea8fe', color: '#06122b', fontWeight: 600 }}>
        Retry
      </button>
    </main>
  );
}
