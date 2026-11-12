// ts-store: test/model/roundtrip.test.ts, the gauge across languages. Every fixture in model/fixtures/ is decoded with
// the generated schema, written to the web store (IndexedDB, through db.ts, in fake-indexeddb), read back and encoded
// to canonical JSON, which must equal the fixture. A field the model has and no fixture shows fails it too, so a field
// added to the model needs a sample. A second language's generated test reads the same fixtures.

import { CodeGenerator, type RenderContext } from 'clay-generator/types';
import { HEADER, isSpread, layerOf, type Model } from '../../lib/model';

export default class extends CodeGenerator {
  render({ data }: RenderContext): string {
    return emit(data as unknown as Model);
  }
}

export function emit(m: Model): string {
  // Where each API entity lives on the device: an object store that holds it, or a meta row whose value is it.
  const api = new Set(m.types.filter((t) => layerOf(t) === 'api').map((t) => t.name));
  const places: string[] = [];
  for (const s of m.store.objectStores) if (api.has(s.holds)) places.push(`  ${s.holds}: { store: model.${s.const} },`);
  const meta = m.types.find((t) => t.name === m.store.objectStores.find((s) => s.holds === 'Meta')?.holds);
  for (const f of meta?.fields ?? []) {
    if (isSpread(f)) continue;
    const entity = f.type === 'ref' ? f.ref : f.type === 'object' ? f.extends : undefined;
    if (entity && api.has(entity)) places.push(`  ${entity}: { store: model.META, key: '${f.name}' },`);
  }
  return `${HEADER('ts-store')}
import 'fake-indexeddb/auto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as Api from '../../lib/api/schemas.generated';
import { done, withStore } from '../../app/(ui)/local/db';
import * as model from '../../app/(ui)/local/model.generated';

const DIR = fileURLToPath(new URL('../../model/fixtures/', import.meta.url));
const OWNER = 'fixtures';

/** Where each entity is kept on the device. */
const PLACES: Record<string, { store: string; key?: string }> = {
${places.join('\n')}
};

interface Fixture {
  name: string;
  entity: keyof typeof PLACES;
  value: Record<string, unknown>;
}
const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(DIR + f, 'utf8')) as Omit<Fixture, 'name'>) }));

/** JSON with every object's keys sorted: the canonical form both languages compare. */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sort(v));
}

const schema = (entity: string) => (Api as unknown as Record<string, z.ZodType>)[entity]!;

async function roundTrip(f: Fixture): Promise<unknown> {
  const decoded = schema(f.entity).parse(f.value);
  const place = PLACES[f.entity]!;
  const id = place.key ?? (decoded as { id: string }).id;
  const row = place.key ? { key: place.key, value: decoded } : decoded;
  await withStore(OWNER, [place.store], 'readwrite', (t) => {
    t.objectStore(place.store).put(row);
    return true;
  });
  const back = await withStore(OWNER, [place.store], 'readonly', (t) => done(t.objectStore(place.store).get(id)));
  return place.key ? (back as { value: unknown }).value : back;
}

describe('the model round-trips through the store', () => {
  it('has fixtures', () => expect(fixtures.length).toBeGreaterThan(0));

  for (const f of fixtures) {
    it(\`\${f.name}: decode, store, read back and encode to the same JSON\`, async () => {
      expect(Object.keys(PLACES)).toContain(f.entity);
      expect(canonical(await roundTrip(f))).toBe(canonical(f.value));
    });
  }

  it('every field of every stored entity appears in some fixture', () => {
    for (const entity of new Set(fixtures.map((f) => f.entity))) {
      const shape = (schema(entity) as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      const seen = new Set(fixtures.filter((f) => f.entity === entity).flatMap((f) => Object.keys(f.value)));
      expect(Object.keys(shape).filter((k) => !seen.has(k)), \`fields of \${entity} no fixture shows\`).toEqual([]);
    }
  });
});
`;
}
