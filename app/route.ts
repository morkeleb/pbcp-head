// GET / (RFC §7.5). Open to anyone; with a producer token it describes that token's head.

import { db } from '../db/client';
import { authenticateProducer, bearerToken } from '../lib/auth/producer';
import { describeHead } from '../lib/describe';
import { defaultHead } from '../lib/heads';
import { handle, HttpError, json } from '../lib/http';

export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const owner = bearerToken(req) !== null ? (await authenticateProducer(db(), req)).headId : await defaultHead(db());
    if (owner === null) throw new HttpError(404, 'no_head', 'this deployment serves no single head; send a producer token');
    return json(describeHead(owner));
  });
}
