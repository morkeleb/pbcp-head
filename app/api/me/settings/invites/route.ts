// GET /api/me/settings/invites — the requests for an invite from the front door's form, for the deployment's own head
// (lib/invites.ts); another head is 403 not_the_operator.

import { db } from '../../../../../db/client';
import { json } from '../../../../../lib/http';
import { listInvites } from '../../../../../lib/invites';
import { meHandler } from '../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json({ requests: await listInvites(db(), s.headId) }));
