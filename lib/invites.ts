// Invite requests: the front door's form (POST /api/invite) records an address that asks for an invite to the hosted
// head. Nothing is sent to it; the operator reads the list in Settings (GET /api/me/settings/invites) and deletes rows.
// The list is the deployment's, not a head's, so only the deployment's own head sees it: PBCP_HEAD, or its only head
// (lib/heads.ts defaultHead). Another head on the same deployment is refused, so it never sees anyone's address.

import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { inviteRequests } from '../db/schema';
import { iso } from './clock';
import { defaultHead } from './heads';
import { HttpError } from './http';

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;
export const EMAIL_MAX = 254;

/** Records a request for an invite; asking again with the same address changes nothing. */
export async function requestInvite(db: Db, body: { email?: unknown }, userAgent: string | null): Promise<void> {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email.length > EMAIL_MAX || !EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'an email address, please');
  await db
    .insert(inviteRequests)
    .values({ email, userAgent: userAgent?.slice(0, 300) ?? null })
    .onConflictDoNothing(); // the unique index on lower(email)
}

async function operator(db: Db, headId: string): Promise<void> {
  if ((await defaultHead(db)) !== headId) throw new HttpError(403, 'not_the_operator', 'invite requests are for the deployment’s own head');
}

/** GET /api/me/settings/invites: the requests, oldest first. */
export async function listInvites(db: Db, headId: string) {
  await operator(db, headId);
  const rows = await db.select().from(inviteRequests).orderBy(asc(inviteRequests.createdAt), asc(inviteRequests.id));
  return rows.map((r) => ({ id: String(r.id), email: r.email, created_at: iso(r.createdAt), user_agent: r.userAgent }));
}

/** DELETE /api/me/settings/invites/{id}. */
export async function deleteInvite(db: Db, headId: string, id: string): Promise<void> {
  await operator(db, headId);
  const n = /^\d{1,18}$/.test(id) ? Number(id) : NaN;
  const r = Number.isSafeInteger(n) ? await db.delete(inviteRequests).where(eq(inviteRequests.id, n)).returning({ id: inviteRequests.id }) : [];
  if (r.length === 0) throw new HttpError(404, 'not_found', `no invite request ${id}`);
}
