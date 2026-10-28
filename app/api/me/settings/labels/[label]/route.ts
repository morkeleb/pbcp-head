// PATCH /api/me/settings/labels/{label} { ceiling: log | brief | immediate | null } — the owner's ceiling on a label (§9).

import { db } from '../../../../../../db/client';
import { LabelPatch, parseRequest } from '../../../../../../lib/api/schemas';
import { decodeId, json, rawSegment, readObject } from '../../../../../../lib/http';
import { meHandler } from '../../../../../../lib/owner';
import { setLabelCeiling } from '../../../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const PATCH = meHandler(async (s, req) => {
  const { ceiling } = parseRequest(LabelPatch, await readObject(req));
  return json(await setLabelCeiling(db(), s.headId, decodeId(rawSegment(req, 5)), ceiling));
});
