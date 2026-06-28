export const metadata = { title: 'Activity Dashboard' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{
        margin: 0, background: '#0f1117', color: '#e6e8ee',
        fontFamily: '-apple-system, Segoe UI, Roboto, sans-serif',
      }}>
        {children}
      </body>
    </html>
  );
}
