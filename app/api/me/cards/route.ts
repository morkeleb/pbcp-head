// GET /api/me/cards?date=YYYY-MM-DD | since=&until= [&state=] [&after=<change_seq>&limit=] — the Day screen.

import { db } from '../../../../db/client';
import { json } from '../../../../lib/http';
import { listCards } from '../../../../lib/me';
import { meHandler } from '../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s, req) => {
  const q = new URL(req.url).searchParams;
  return json(await listCards(db(), s.headId, { date: q.get('date'), since: q.get('since'), until: q.get('until'), state: q.get('state'), after: q.get('after'), limit: q.get('limit') }));
});
