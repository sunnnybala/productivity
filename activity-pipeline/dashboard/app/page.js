import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sb } from '../lib/db';
import ViewSwitch from './view-switch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const jar = await cookies();
  const expected = process.env.DASH_TOKEN;
  if (!expected || jar.get('auth')?.value !== expected) redirect('/login');   // fail closed if token unset

  let persons = [];
  try {
    const rows = await sb('devices?select=person');
    persons = [...new Set(rows.map((r) => r.person))].sort();
  } catch {}
  if (!persons.length) persons = ['dhruv'];

  return <ViewSwitch persons={persons} />;
}
