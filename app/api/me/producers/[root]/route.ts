// PATCH /api/me/producers/{root} { ceiling?: log | brief | immediate, revoked?: true }.

import { db } from '../../../../../db/client';
import { parseRequest, ProducerPatch } from '../../../../../lib/api/schemas';
import { decodeId, HttpError, json, rawSegment, readObject } from '../../../../../lib/http';
import { listProducers } from '../../../../../lib/me';
import { meHandler } from '../../../../../lib/owner';
import { updateProducer } from '../../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const PATCH = meHandler(async (s, req) => {
  const root = decodeId(rawSegment(req, 4));
  await updateProducer(db(), s.headId, root, parseRequest(ProducerPatch, await readObject(req)));
  const producer = (await listProducers(db(), s.headId)).find((p) => p.root === root);
  if (!producer) throw new HttpError(404, 'not_found', `no producer ${root}`);
  return json(producer);
});
