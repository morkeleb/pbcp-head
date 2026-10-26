// GET /api/me/devices — the signed-in devices; `current` marks the caller.

import { db } from '../../../../db/client';
import { json } from '../../../../lib/http';
import { listDevices } from '../../../../lib/me';
import { meHandler } from '../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json({ devices: await listDevices(db(), s.headId, s.deviceId) }));
