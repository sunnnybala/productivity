import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(req) {
  const form = await req.formData();
  const pw = form.get('password');
  if (process.env.DASH_PASSWORD && safeEqual(pw, process.env.DASH_PASSWORD)) {
    const res = NextResponse.redirect(new URL('/', req.url), 303);
    res.cookies.set('auth', process.env.DASH_TOKEN, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 365, // 1 year — stay logged in on this browser
    });
    return res;
  }
  return NextResponse.redirect(new URL('/login?e=1', req.url), 303);
}
