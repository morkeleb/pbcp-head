// POST /api/pair { code, root, name? } — public: a producer trades a pairing code from the owner for its own token
// (lib/settings/pairing.ts). The code is the credential: a request that carries any other (a producer token, a session)
// is refused, so the owner pairs nothing here; the owner's side is Settings. Rate-limited per address. 201
// { token, api, owner, root } once; 400 invalid_code (no other code is touched), 400 invalid_root, 409 root_taken.

import { db } from '../../../db/client';
import { HttpError, handle, json, readObject } from '../../../lib/http';
import { clientAddress, rateLimit } from '../../../lib/rate-limit';
import { pair } from '../../../lib/settings/pairing';
import { headOrigin, producerUrl } from '../../../lib/settings/head';

export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const address = clientAddress(req);
    await rateLimit(db(), 'pair', address);
    if (req.headers.get('authorization') !== null) {
      throw new HttpError(400, 'invalid_request', 'pairing takes no credential: the code is the credential; the owner makes codes in Settings');
    }
    return json(await pair(db(), await readObject(req), address, producerUrl(headOrigin(req.url))), 201);
  });
}
