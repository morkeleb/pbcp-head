// POST /api/me/settings/enrolment — a one-hour link that lets another device register a passkey on this head.

import { json } from '../../../../../lib/http';
import { meHandler } from '../../../../../lib/owner';
import { enrolmentLink } from '../../../../../lib/settings/devices';
import { headOrigin } from '../../../../../lib/settings/head';

export const dynamic = 'force-dynamic';

export const POST = meHandler(async (s, req) => json(await enrolmentLink(s.headId, headOrigin(req.url)), 201));
