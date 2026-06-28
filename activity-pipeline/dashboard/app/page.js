import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sb } from '../lib/db';
import Dashboard from './dashboard';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const jar = await cookies();
  if (jar.get('auth')?.value !== process.env.DASH_TOKEN) redirect('/login');

  let persons = [];
  try {
    const rows = await sb('devices?select=person');
    persons = [...new Set(rows.map((r) => r.person))].sort();
  } catch {}
  if (!persons.length) persons = ['dhruv'];

  return <Dashboard persons={persons} />;
}
