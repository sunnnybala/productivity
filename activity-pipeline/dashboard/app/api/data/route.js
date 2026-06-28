import { cookies } from 'next/headers';
import { rpc } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  // Re-check auth at the data layer (not just middleware).
  const jar = await cookies();
  if (jar.get('auth')?.value !== process.env.DASH_TOKEN) {
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
    return new Response(String(e?.message || e), { status: 500 });
  }
}
