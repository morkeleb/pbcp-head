// POST /api/cards/{id}/decision — decide (RFC §7.3), at the RFC's path.
//
// §7.3: "Head-only … called by the head's own interface on behalf of the person, never by a producer", and
// who may decide is left to the head. So this route takes a human session, not a producer token: a Bearer
// token is 401 here, as a Session is on the producer routes. It is the same operation as
// POST /api/me/cards/{id}/decision.

import { decisionHandler } from '../../../../../lib/owner';

export const dynamic = 'force-dynamic';

export const POST = decisionHandler(3);
