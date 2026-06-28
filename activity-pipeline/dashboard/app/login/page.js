export default function Login({ searchParams }) {
  const failed = searchParams?.e;
  return (
    <main style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1 style={{ fontSize: 22 }}>Activity Dashboard</h1>
      <p style={{ color: '#9aa3b2' }}>Founders only.</p>
      <form method="post" action="/api/login">
        <input name="password" type="password" placeholder="Password" autoFocus
          style={{ width: '100%', padding: 10, marginBottom: 12, borderRadius: 8,
                   border: '1px solid #2a2f3a', background: '#181b24', color: '#e6e8ee' }} />
        <button type="submit"
          style={{ width: '100%', padding: 10, borderRadius: 8, border: 0,
                   background: '#6ea8fe', color: '#06122b', fontWeight: 600 }}>
          Log in
        </button>
      </form>
      {failed ? <p style={{ color: '#f87171', marginTop: 12 }}>Wrong password.</p> : null}
    </main>
  );
}
