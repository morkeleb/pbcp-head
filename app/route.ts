// GET / (RFC §7.5). Open to anyone; with a producer token it describes that token's head. A browser (text/html
// preferred over application/json) never reaches this: proxy.ts sends it to the front door, app/about.

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { changeCounter } from '../db/schema';
import { authenticateProducer, bearerToken } from '../lib/auth/producer';
import { describeHead } from '../lib/describe';
import { defaultHead } from '../lib/heads';
import { handle, HttpError, json } from '../lib/http';

export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const owner = bearerToken(req) !== null ? (await authenticateProducer(db(), req)).headId : await defaultHead(db());
    if (owner === null) throw new HttpError(404, 'no_head', 'this deployment serves no single head; send a producer token');
    const [counter] = await db().select({ seq: changeCounter.seq }).from(changeCounter).where(eq(changeCounter.headId, owner));
    return json(describeHead(owner, counter?.seq ?? 0), 200, { vary: 'Accept' });
  });
}
