// GET /llms.txt: this head for a language model acting as a producer: what the head is and how a producer talks to it,
// the facts, the three values, a first card, and the links. Public, plain text; the same as /connect (lib/connect.ts).

import { db } from '../../db/client';
import { llmsTxt } from '../../lib/connect';
import { connectFacts, headOrigin } from '../../lib/settings/head';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const origin = headOrigin(req.url);
  return new Response(llmsTxt(await connectFacts(db(), origin), origin), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
