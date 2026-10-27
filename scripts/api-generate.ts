// pnpm api:generate [--swift <path to swift-openapi-generator>] — writes the human API's OpenAPI document to
// packages/api-types/openapi.json (from lib/api/schemas.ts) and, with a Swift generator, the phone's client to
// apps/ios/Generated/. The generator is found from --swift, $SWIFT_OPENAPI_GENERATOR or the PATH; without one
// the Swift files are left alone, and test/api-types.test.ts says they are stale if the document changed.
//
// swift-openapi-generator 1.x does not read `null` in a schema's types: it drops it and decodes the field as
// non-optional, so `"next": null` would fail to decode. The copy it is given therefore turns each nullable
// property into an optional one (Swift's decodeIfPresent reads JSON null as nil); openapi.json itself keeps
// saying the key is always there.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { API_TYPES_DIR, IOS_GENERATED_DIR, openApiText } from '../lib/api/generate';

const { values } = parseArgs({ options: { swift: { type: 'string' } } });

const doc = join(API_TYPES_DIR, 'openapi.json');
const text = openApiText();
writeFileSync(doc, text);
console.log(`wrote ${doc}`);

const generator = values.swift ?? process.env.SWIFT_OPENAPI_GENERATOR ?? which('swift-openapi-generator');
if (!generator) {
  console.warn('no swift-openapi-generator (pass --swift or set SWIFT_OPENAPI_GENERATOR): apps/ios/Generated was not regenerated');
  process.exit(0);
}
// The generator reads the document and its config from one directory and writes Types.swift and Client.swift.
const work = mkdtempSync(join(tmpdir(), 'pbcp-api-'));
try {
  writeFileSync(join(work, 'openapi.json'), JSON.stringify(forSwift(JSON.parse(text))));
  copyFileSync(join(IOS_GENERATED_DIR, 'openapi-generator-config.yaml'), join(work, 'openapi-generator-config.yaml'));
  execFileSync(generator, ['generate', join(work, 'openapi.json'), '--config', join(work, 'openapi-generator-config.yaml'), '--output-directory', IOS_GENERATED_DIR], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(IOS_GENERATED_DIR, 'openapi.sha256'), `${createHash('sha256').update(readFileSync(doc)).digest('hex')}\n`);
console.log(`wrote ${IOS_GENERATED_DIR}`);

function which(cmd: string): string | undefined {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The null-free form of a schema, or undefined when it allows nothing but null. */
function withoutNull(schema: Record<string, unknown>): { schema: Record<string, unknown>; nullable: boolean } {
  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    const rest = schema.type.filter((t) => t !== 'null');
    return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key] as Array<Record<string, unknown>> | undefined;
    if (!options?.some((o) => o.type === 'null')) continue;
    const rest = options.filter((o) => o.type !== 'null');
    const { [key]: _, ...others } = schema;
    return { schema: rest.length === 1 ? { ...others, ...rest[0] } : { ...others, [key]: rest }, nullable: true };
  }
  return { schema, nullable: false };
}

function forSwift(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forSwift);
  if (!node || typeof node !== 'object') return node;
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, forSwift(v)])) as Record<string, unknown>;
  const props = out.properties as Record<string, Record<string, unknown>> | undefined;
  if (props && typeof props === 'object') {
    const nullable: string[] = [];
    for (const [name, schema] of Object.entries(props)) {
      const r = withoutNull(schema);
      props[name] = r.schema;
      if (r.nullable) nullable.push(name);
    }
    if (Array.isArray(out.required)) out.required = out.required.filter((n) => !nullable.includes(n as string));
  }
  return out;
}
