import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { changeCounter, heads } from '../db/schema';

const PERSON_ID = /^[A-Za-z0-9-]+$/;

/** Creates the head and its change counter if they do not exist. The head id is the owner's person id. */
export async function ensureHead(db: Db, headId: string): Promise<void> {
  if (!PERSON_ID.test(headId)) throw new Error(`head id must be letters, digits and -: ${headId}`);
  await db.transaction(async (tx) => {
    await tx.insert(heads).values({ id: headId }).onConflictDoNothing();
    await tx.insert(changeCounter).values({ headId, seq: 0 }).onConflictDoNothing();
  });
}

/**
 * The head a request without credentials is about (GET /). A deployment serves one person unless it is
 * the hosted multi-head setup, so: $PBCP_HEAD if set, otherwise the only head there is.
 */
export async function defaultHead(db: Db): Promise<string | null> {
  const configured = process.env.PBCP_HEAD;
  if (configured) {
    const [row] = await db.select({ id: heads.id }).from(heads).where(eq(heads.id, configured));
    return row?.id ?? null;
  }
  const rows = await db.select({ id: heads.id }).from(heads).orderBy(sql`created_at`).limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}
