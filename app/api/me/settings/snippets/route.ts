// GET /api/me/settings/snippets?root=<root> — how a producer connects (lib/connect.ts): the three values
// (`producerConfig`) and a curl that PUTs a card (`curlSnippet`, @pbcp/client), with this head's api and owner id and the
// placeholder <token>, which the client replaces with the token it just minted; and each connector's setup, by link.
// The curl's card is the §3 example (root hermes), or, for another root, a one-line artifact under that root.

import { db } from '../../../../../db/client';
import { connectLinks, connectSnippets, TOKEN } from '../../../../../lib/connect';
import { HttpError, json } from '../../../../../lib/http';
import { meHandler } from '../../../../../lib/owner';
import { headFacts, headOrigin, producerUrl } from '../../../../../lib/settings/head';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s, req) => {
  const root = new URL(req.url).searchParams.get('root') ?? undefined;
  if (root !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(root)) throw new HttpError(400, 'invalid_root', 'a producer root is letters, digits or - (§5)');
  const origin = headOrigin(req.url);
  const facts = await headFacts(db(), s.headId, producerUrl(origin));
  const { config, curl, curlRoot } = connectSnippets({ api: facts.url, owner: facts.owner }, TOKEN, root);
  return json({ api: facts.url, owner: facts.owner, token: TOKEN, config, curl, curl_root: curlRoot, connectors: connectLinks(origin).connectors.map((l) => ({ name: l.label, url: l.href })) });
});
