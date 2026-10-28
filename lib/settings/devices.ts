// Enrolling another device: a one-hour link to /signin?enroll=… that lets whoever opens it register a passkey (or link an
// Apple id) on this head (lib/auth/enroll.ts). The settings route and scripts/enroll.ts both make it here.

import { ENROLL_TTL_SECONDS, enrollmentToken } from '../auth/enroll';

export async function enrolmentLink(headId: string, origin: string): Promise<{ url: string; expires_at: string }> {
  const token = await enrollmentToken(headId);
  return {
    url: `${origin}/signin?enroll=${encodeURIComponent(token)}`,
    expires_at: new Date(Date.now() + ENROLL_TTL_SECONDS * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
  };
}
