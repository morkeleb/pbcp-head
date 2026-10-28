// pnpm api:generate — writes the human API's OpenAPI document to packages/api-types/openapi.json (from
// lib/api/schemas.ts). That document is the contract: the owner's MCP package generates its types from it
// (packages/owner-mcp: `pnpm api-types`), and a native app, when one starts, generates its client from it
// (docs/mobile-prd.md). test/api-types.test.ts fails when it is stale.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_TYPES_DIR, openApiText } from '../lib/api/generate';

const doc = join(API_TYPES_DIR, 'openapi.json');
writeFileSync(doc, openApiText());
console.log(`wrote ${doc}`);
