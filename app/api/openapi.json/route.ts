// GET /api/openapi.json: the human API's contract (packages/api-types/openapi.json, generated from lib/api/schemas.ts
// by `pnpm api:generate`), public like GET /, so the front door can link to it and tools can read it from the head.

import document from '../../../packages/api-types/openapi.json';

export const dynamic = 'force-static';

export function GET(): Response {
  return Response.json(document, { headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' } });
}
