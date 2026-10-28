// The human API's contract is checked in (packages/api-types/openapi.json). It must be regenerated, with
// `pnpm api:generate`, whenever the schemas in lib/api/schemas.ts change, so a change to the API shows up in review
// as a diff in it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_TYPES_DIR, openApiText } from '../lib/api/generate';

const checkedIn = () => readFileSync(join(API_TYPES_DIR, 'openapi.json'), 'utf8');

describe('packages/api-types', () => {
  it('openapi.json is what lib/api/schemas.ts generates (run `pnpm api:generate`)', () => {
    expect(checkedIn()).toBe(openApiText());
  });

  it('documents every /api/me route the head serves, and GET /', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const routes: string[] = [];
    const walk = (dir: string, path: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, `${path}/${name.replace(/^\[(.+)\]$/, '{$1}')}`);
        else if (name === 'route.ts') routes.push(path);
      }
    };
    walk(join(process.cwd(), 'app/api/me'), '/api/me');
    const paths = Object.keys(JSON.parse(checkedIn()).paths);
    expect(paths).toContain('/');
    expect(routes.filter((r) => !paths.includes(r))).toEqual([]);
  });

  it('states the X-Timezone header and the UTC-only snooze rule', () => {
    const doc = JSON.parse(checkedIn());
    expect(doc.components.parameters.XTimezone).toMatchObject({ name: 'X-Timezone', in: 'header', required: false });
    expect(doc.paths['/api/me/brief'].get.parameters).toContainEqual({ $ref: '#/components/parameters/XTimezone' });
    expect(doc.paths['/api/me/cards/{id}/snooze'].post.description).toMatch(/UTC.*invalid_snooze/);
  });
});
