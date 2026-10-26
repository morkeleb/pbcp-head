// Linking a new identity (a passkey, an Apple id) to a head needs proof that the caller is the owner:
// either a current session, or an enrolment token that whoever runs the head minted with
// `pnpm enroll <head>`. There is no open sign-up: the first identity of a head always comes from the operator.

import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { heads } from '../../db/schema';
import { HttpError } from '../http';
import { authenticateSession, sessionToken, sign, verify } from './session';

export const ENROLL_TTL_SECONDS = 60 * 60;

export const enrollmentToken = (headId: string): Promise<string> => sign('enroll', { sub: headId }, ENROLL_TTL_SECONDS);

/** The head a new identity may be linked to: the session's, or the enrolment token's. */
export async function enrollingHead(db: Db, req: Request, enroll: unknown): Promise<string> {
  if (sessionToken(req) !== null) return (await authenticateSession(db, req)).headId;
  if (typeof enroll === 'string') {
    const claims = await verify('enroll', enroll);
    if (claims && typeof claims.sub === 'string') {
      const [head] = await db.select({ id: heads.id }).from(heads).where(eq(heads.id, claims.sub));
      if (head) return head.id;
    }
  }
  throw new HttpError(401, 'unauthorized', 'linking a new sign-in method needs a session or an enrolment token (pnpm enroll <head>)');
}
