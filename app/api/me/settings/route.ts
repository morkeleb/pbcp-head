// GET /api/me/settings — the head's id and display name, and its timezone: effective, override, latest device.
// PATCH /api/me/settings { timezone?: <IANA zone> | null, display_name?: string | null } — null clears.

import { db } from '../../../../db/client';
import { parseRequest, SettingsPatch } from '../../../../lib/api/schemas';
import { json, readObject } from '../../../../lib/http';
import { meHandler } from '../../../../lib/owner';
import { settings, updateSettings } from '../../../../lib/settings-me';

export const dynamic = 'force-dynamic';

export const GET = meHandler(async (s) => json(await settings(db(), s.headId)));

export const PATCH = meHandler(async (s, req) => json(await updateSettings(db(), s.headId, parseRequest(SettingsPatch, await readObject(req)))));
