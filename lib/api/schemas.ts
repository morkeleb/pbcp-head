// The human API's contract (docs/mobile-prd.md "Human API"): request and response shapes of every /api/me/
// route and of GET /. The shapes are the model's (model/model.json), generated into ./schemas.generated.ts by Clay
// (`pnpm generate`) and re-exported here; this file keeps only what is not a shape. The routes parse their request
// bodies with these; lib/api/openapi.ts turns them into the OpenAPI document in packages/api-types; and
// test/http/contract.test.ts checks real responses against that document. The card itself is @pbcp/core's.

import type { z } from 'zod';
import { HttpError } from '../http';

export * from './schemas.generated';

/** A request body as `schema` describes it, or 400 `invalid_request` naming what is wrong. */
export function parseRequest<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
  throw new HttpError(400, 'invalid_request', issues.join('; '));
}
