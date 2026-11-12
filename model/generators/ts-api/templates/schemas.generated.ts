// ts-api: lib/api/schemas.generated.ts, the Zod schemas of every /api/me request and response body (and GET /), from
// the model's api-layer types. lib/api/openapi.ts builds the OpenAPI document from them as before, so the document's
// shapes come from the model; core's card is extended by reference (ProducerCardSchema), never copied.

import path from 'node:path';
import { CodeGenerator, type RenderContext } from 'clay-generator/types';
import { comment, HEADER, isSpread, key, layerOf, str, type Field, type Model, type Spec, type Spread, type TypeDef } from '../../lib/model';

const TARGET_DIR = 'lib/api';

export default class extends CodeGenerator {
  render({ data }: RenderContext): string {
    return emit(data as unknown as Model);
  }
}

export function emit(m: Model): string {
  const imports = new Map(m.imports.map((i) => [i.name, i]));
  const used = new Set<string>();
  const scalars = new Set(m.scalars.map((s) => s.name));
  const enums = new Set(m.enums.map((e) => e.name));
  const types = new Map(m.types.map((t) => [t.name, t]));

  /** The identifier a name resolves to in the generated file. */
  const ident = (name: string): string => {
    const imp = imports.get(name);
    if (imp) {
      used.add(name);
      return imp.import;
    }
    if (scalars.has(name) || enums.has(name) || types.has(name)) return name;
    throw new Error(`model: unknown name ${name}`);
  };

  const expr = (s: Spec, indent: string): string => {
    let e: string;
    switch (s.type) {
      case 'string':
        e = 'z.string()';
        if (s.min !== undefined) e += `.min(${s.min})`;
        if (s.pattern !== undefined) e += `.regex(/${s.pattern}/)`;
        break;
      case 'integer':
      case 'number':
        e = s.type === 'integer' ? 'z.number().int()' : 'z.number()';
        if (s.nonnegative) e += '.nonnegative()';
        if (s.positive) e += '.positive()';
        break;
      case 'boolean':
        e = 'z.boolean()';
        break;
      case 'unknown':
        e = 'z.unknown()';
        break;
      case 'literal':
        e = `z.literal(${typeof s.value === 'string' ? str(s.value) : String(s.value)})`;
        break;
      case 'enum':
        e = `z.enum([${(s.values ?? []).map(str).join(', ')}])`;
        break;
      case 'ref':
        e = s.member ? `${ident(s.ref!)}.shape.${s.member}` : ident(s.ref!);
        break;
      case 'array':
        e = `z.array(${expr(s.of!, indent)})`;
        break;
      case 'record':
        e = `z.record(z.string(), ${expr(s.of!, indent)})`;
        break;
      case 'object':
        e = object(s.fields ?? [], s.extends, indent);
        break;
    }
    if (s.nullable) e += '.nullable()';
    if (s.optional) e += '.optional()';
    if (s.describe !== undefined) e += `.describe(${str(s.describe)})`;
    return e;
  };

  const object = (fields: Array<Field | Spread>, base: string | undefined, indent: string): string => {
    const inner = `${indent}  `;
    const body = fields
      .map((f) => (isSpread(f) ? `${inner}...${ident(f.spread)}.shape,\n` : `${comment(f.doc, inner)}${inner}${key(f.name)}: ${expr(f, inner)},\n`))
      .join('');
    return `${base ? `${ident(base)}.extend` : 'z.object'}({\n${body}${indent}})`;
  };

  const typeExpr = (t: TypeDef): string => {
    if (t.alias) return ident(t.alias);
    let e: string;
    if (t.is) e = ident(t.is);
    else if (t.union) e = `z.union([\n${t.union.map((v) => `  ${object(v.fields, undefined, '  ')},\n`).join('')}])`;
    else e = object(t.fields ?? [], t.extends, '');
    if (t.describe !== undefined) e += `.describe(${str(t.describe)})`;
    if (t.atLeastOne) e += `.refine((p) => ${t.atLeastOne.fields.map((f) => `p.${f} !== undefined`).join(' || ')}, ${str(t.atLeastOne.message)})`;
    if (t.registry) {
      const meta = [`id: ${str(t.id ?? t.name)}`, ...(t.description !== undefined ? [`description: ${str(t.description)}`] : [])];
      e += `.register(${t.registry}, { ${meta.join(', ')} })`;
    }
    return e;
  };

  // The body first, so the imports are the ones it used.
  const out: string[] = [];
  out.push('/** Responses: emitted with `additionalProperties: false`, so a field the document does not name is a test failure. */');
  out.push('export const responses = z.registry<{ id: string; description?: string }>();');
  out.push('/** Request bodies: emitted without it; the routes ignore fields they do not know. */');
  out.push('export const requests = z.registry<{ id: string; description?: string }>();');
  out.push('');
  for (const s of m.scalars) out.push(`const ${s.name} = ${expr(s, '')};`);
  for (const en of m.enums.filter((e) => layerOf(e) === 'api')) {
    const doc = comment(en.doc, '');
    if (en.export) {
      out.push(`${doc}export const ${en.export} = [${(en.values ?? []).map(str).join(', ')}] as const;`);
      out.push(`const ${en.name} = z.enum(${en.export});`);
    } else if (en.from) {
      const src = ident(en.from);
      out.push(`${doc}const ${en.name} = z.enum(${en.plus?.length ? `[...${src}, ${en.plus.map(str).join(', ')}]` : src});`);
    } else out.push(`${doc}const ${en.name} = z.enum([${(en.values ?? []).map(str).join(', ')}]);`);
  }
  out.push('');
  for (const t of m.types.filter((t) => layerOf(t) === 'api')) {
    out.push(`${comment(t.doc, '')}${t.export === false ? '' : 'export '}const ${t.name} = ${typeExpr(t)};`);
    out.push('');
  }

  // A constant interpolated in a description (`${PAIRING_CODE_SHAPE}`) is imported like any other name.
  const body = out.join('\n');
  for (const imp of m.imports) if (imp.kind === 'const' && body.includes(`\${${imp.name}}`)) used.add(imp.name);
  const byModule = new Map<string, string[]>();
  for (const name of used) {
    const imp = imports.get(name)!;
    const from = imp.from.startsWith('@') ? imp.from : relative(imp.from);
    byModule.set(from, [...(byModule.get(from) ?? []), imp.import]);
  }
  const head = [...byModule.entries()]
    .sort(([a], [b]) => (a.startsWith('.') ? 1 : 0) - (b.startsWith('.') ? 1 : 0) || a.localeCompare(b))
    .map(([from, names]) => `import { ${[...new Set(names)].sort().join(', ')} } from '${from}';`);
  return `${HEADER('ts-api')}\nimport { z } from 'zod';\n${head.join('\n')}\n\n${body.replace(/\n+$/, '')}\n`;
}

/** A repo-root path as an import from lib/api. */
function relative(from: string): string {
  const r = path.posix.relative(TARGET_DIR, from);
  return r.startsWith('.') ? r : `./${r}`;
}
