// GET /api/me/settings/snippets?root=<root> — ready-to-paste ways to connect a producer (curl, n8n, Hermes), filled
// with this head's URL and owner id and a token placeholder the client replaces with a token it just minted
// (lib/settings/snippets.ts).

import { HttpError, json } from '../../../../../lib/http';
import { meHandler } from '../../../../../lib/owner';
import { headOrigin, producerUrl } from '../../../../../lib/settings/head';
import { snippets, TOKEN_PLACEHOLDER } from '../../../../../lib/settings/snippets';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s, req) => {
  const root = new URL(req.url).searchParams.get('root') ?? 'my-producer';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(root)) throw new HttpError(400, 'invalid_root', 'a producer root is letters, digits or - (§5)');
  return json({ root, token: TOKEN_PLACEHOLDER, ...snippets({ url: producerUrl(headOrigin(req.url)), owner: s.headId, root, token: TOKEN_PLACEHOLDER }) });
});
