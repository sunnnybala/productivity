import { cookies } from 'next/headers';
import { rpc } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  // Re-check auth at the data layer (not just middleware).
  const jar = await cookies();
  const expected = process.env.DASH_TOKEN;
  if (!expected || jar.get('auth')?.value !== expected) {   // fail closed if token unset
    return new Response('unauthorized', { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const person = searchParams.get('person') || 'dhruv';
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (!from || !to) return new Response('missing from/to', { status: 400 });

  try {
    const data = await rpc('dashboard_summary', { p_person: person, p_from: from, p_to: to });
    return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    console.error('dashboard_summary failed:', e);   // full error server-side only
    return new Response('Failed to load data', { status: 500 });
  }
}
