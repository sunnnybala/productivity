import { NextResponse } from 'next/server';

// Gate everything behind the shared password cookie, except the exact login routes + assets.
// NOTE: middleware is an OPTIMISTIC gate only — page.js re-checks auth at the data layer
// (middleware is not a security boundary; see CVE-2025-29927).
const PUBLIC = new Set(['/login', '/api/login']);

export function middleware(req) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.has(pathname)) return NextResponse.next();
  const auth = req.cookies.get('auth')?.value;
  if (auth && auth === process.env.DASH_TOKEN) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
