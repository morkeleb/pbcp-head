// Every /api/auth/* request counts against its client address (lib/rate-limit.ts), before anything else.
import { db } from '../../db/client';
import { clientAddress, rateLimit } from '../rate-limit';

export const limitSignIn = (req: Request): Promise<void> => rateLimit(db(), 'auth', clientAddress(req));
