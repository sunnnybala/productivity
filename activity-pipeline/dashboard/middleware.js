import { NextResponse } from 'next/server';

// Gate everything behind the shared password cookie, except the exact login routes + assets.
// NOTE: middleware is an OPTIMISTIC gate only — page.js re-checks auth at the data layer
// (middleware is not a security boundary; see CVE-2025-29927).
// /api/ambient.json checks the token itself in the route handler (the real boundary),
// so middleware just lets it pass — no duplicate token logic here (Codex review).
const PUBLIC = new Set(['/login', '/api/login', '/api/ambient.json']);

// Ambient (wallpaper/PWA) page: token in the URL instead of the login cookie.
// Fail closed — unset/short AMBIENT_TOKEN denies (Codex #2). The page re-checks too.
function ambientAllowed(req) {
  const token = process.env.AMBIENT_TOKEN?.trim();
  if (!token || token.length < 32) return false;
  return req.nextUrl.searchParams.get('k') === token;
}

export function middleware(req) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.has(pathname)) return NextResponse.next();

  if (pathname === '/ambient') {
    if (!ambientAllowed(req)) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.search = '';
      return NextResponse.redirect(url);
    }
    const res = NextResponse.next();
    res.headers.set('Referrer-Policy', 'no-referrer');             // don't leak ?k in Referer
    res.headers.set('Cache-Control', 'private, no-store');
    res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res;
  }

  const auth = req.cookies.get('auth')?.value;
  if (auth && auth === process.env.DASH_TOKEN) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
