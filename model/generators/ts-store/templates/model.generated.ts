// ts-store: app/(ui)/local/model.generated.ts, the web store's shapes: the card as stored (the API's MeCard, by
// reference), the outbox row, the meta rows by key, and the object stores with their indexes and the schema version.

import { CodeGenerator, type RenderContext } from 'clay-generator/types';
import { apiTypesUsedByStore, comment, HEADER, layerOf, type Model } from '../../lib/model';
import { tsTypes } from '../../lib/ts-types';

export default class extends CodeGenerator {
  render({ data }: RenderContext): string {
    return emit(data as unknown as Model);
  }
}

export function emit(m: Model): string {
  const { object, enumType } = tsTypes(m);
  // Command and Outcome (commands.generated.ts) name their own request types.
  const api = apiTypesUsedByStore(m, { unions: false });
  const enumNames = new Set<string>();
  const out: string[] = [];

  // Enums a store type reads: its own (OutboxAction) and the API's it needs (Sensitivity, from core).
  const needed = new Set<string>();
  const scan = (s: { ref?: string; of?: unknown; fields?: unknown[] } | undefined) => {
    if (!s) return;
    if (s.ref && m.enums.some((e) => e.name === s.ref)) needed.add(s.ref);
    scan(s.of as never);
    (s.fields as never[] | undefined)?.forEach(scan);
  };
  const storeTypes = m.types.filter((t) => layerOf(t) === 'store' && !t.union);
  storeTypes.forEach((t) => t.fields?.forEach((f) => scan(f as never)));
  const coreConsts = new Set<string>();
  for (const e of m.enums.filter((e) => needed.has(e.name))) {
    enumNames.add(e.name);
    if (e.from) coreConsts.add(e.from);
    out.push(`${comment(e.doc, '')}export type ${e.name} = ${enumType(e.name)};`);
  }
  out.push('');
  for (const t of storeTypes) {
    out.push(`${comment(t.doc, '')}export interface ${t.name} {\n${object(t.fields ?? [], '  ')}}`);
    out.push('');
  }
  out.push('/** A meta row\'s key. */');
  out.push('export type MetaKey = keyof Meta;');
  out.push('');
  out.push(`${comment(m.store.doc, '')}export const STORE_VERSION = ${m.store.version};`);
  for (const s of m.store.objectStores) out.push(`export const ${s.const} = '${s.name}';`);
  out.push('');
  out.push('/** Each object store: its key, and the indexes the model states (store.local.ts may add more). */');
  out.push('export const STORES = [');
  for (const s of m.store.objectStores) {
    const idx = (s.indexes ?? []).map((i) => `{ name: '${i.name}', keyPath: '${i.keyPath}' }`).join(', ');
    out.push(`  { name: ${s.const}, keyPath: '${s.keyPath}', autoIncrement: ${s.autoIncrement === true}, indexes: [${idx}] },`);
  }
  out.push('] as const;');

  const imports = [
    `import type { z } from 'zod';`,
    ...(coreConsts.size ? [`import type { ${[...coreConsts].sort().join(', ')} } from '@pbcp/core';`] : []),
    `import type * as Api from '../../../lib/api/schemas.generated';`,
  ];
  const aliases = api.map((n) => `export type ${n} = z.infer<typeof Api.${n}>;`);
  return `${HEADER('ts-store')}\n${imports.join('\n')}\n\n/** The API's shapes the store keeps, exactly as the head serves them (ts-api). */\n${aliases.join('\n')}\n\n${out.join('\n')}\n`;
}
