import { NextResponse } from 'next/server';
import { ambientTokenOk, getAmbientSummary, AMBIENT_SEC_HEADERS } from '../../../lib/ambient';

export const dynamic = 'force-dynamic';

// Compact JSON for widgets (Rainmeter on the laptop, KWGT on the phone).
// { person, date, laptop_min, phone_min, tokens, cost }
export async function GET(req) {
  if (!ambientTokenOk(req.nextUrl.searchParams.get('k')))
    return new NextResponse('Not found', { status: 404 });   // fail closed, no redirect
  try {
    const body = await getAmbientSummary(req.nextUrl.searchParams.get('person') || 'dhruv');
    return NextResponse.json(body, { headers: AMBIENT_SEC_HEADERS });
  } catch {
    return NextResponse.json({ error: 'data_unavailable' }, { status: 503, headers: AMBIENT_SEC_HEADERS });
  }
}
