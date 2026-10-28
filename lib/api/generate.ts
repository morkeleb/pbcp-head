// Where the generated contract lives, and the document's exact text (shared by scripts/api-generate.ts and
// the staleness test, so they cannot disagree on formatting).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApiDocument } from './openapi';

export const API_TYPES_DIR = join(process.cwd(), 'packages/api-types');

export function openApiText(): string {
  const { version } = JSON.parse(readFileSync(join(API_TYPES_DIR, 'package.json'), 'utf8')) as { version: string };
  return `${JSON.stringify(openApiDocument(version), null, 2)}\n`;
}
