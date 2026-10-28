// GET /api/me/settings/labels — the labels on the head's cards, with counts and the owner's ceilings (RFC 0.7 §4.1, §9).

import { db } from '../../../../../db/client';
import { json } from '../../../../../lib/http';
import { meHandler } from '../../../../../lib/owner';
import { listLabels } from '../../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json({ labels: await listLabels(db(), s.headId) }));
