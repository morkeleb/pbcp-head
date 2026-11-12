// TypeScript type expressions from the model, for the store layer (ts-store). API types are not restated here: they are
// `z.infer` of ts-api's schemas, so the client's MeCard is exactly what the head serves.

import { comment, isSpread, key, layerOf, type Field, type Model, type Spec, type Spread } from './model';

export function tsTypes(m: Model) {
  const enums = new Map(m.enums.map((e) => [e.name, e]));
  const lit = (v: string | number | boolean) => (typeof v === 'string' ? `'${v}'` : String(v));

  const type = (s: Spec, indent: string): string => {
    let t: string;
    switch (s.type) {
      case 'string':
        t = 'string';
        break;
      case 'integer':
      case 'number':
        t = 'number';
        break;
      case 'boolean':
        t = 'boolean';
        break;
      case 'unknown':
        t = 'unknown';
        break;
      case 'literal':
        t = lit(s.value!);
        break;
      case 'enum':
        t = (s.values ?? []).map(lit).join(' | ');
        break;
      case 'ref':
        t = s.ref!;
        break;
      case 'array': {
        const el = type(s.of!, indent);
        t = /[|&]/.test(el) ? `Array<${el}>` : `${el}[]`;
        break;
      }
      case 'record':
        t = `Record<string, ${type(s.of!, indent)}>`;
        break;
      case 'object': {
        const body = object(s.fields ?? [], `${indent}  `);
        t = s.extends ? `${s.extends} & {\n${body}${indent}}` : `{\n${body}${indent}}`;
        break;
      }
    }
    return s.nullable ? `${t} | null` : t;
  };

  const object = (fields: Array<Field | Spread>, indent: string): string =>
    fields
      .map((f) => {
        if (isSpread(f)) throw new Error('a store type cannot spread an import');
        return `${comment([f.describe, f.doc].filter(Boolean).join(' — ') || undefined, indent)}${indent}${key(f.name)}${f.optional ? '?' : ''}: ${type(f, indent)};\n`;
      })
      .join('');

  /** An enum as a union of its values; one from a core constant reads the constant's element type. */
  const enumType = (name: string): string => {
    const e = enums.get(name)!;
    if (e.from) return [`(typeof ${e.from})[number]`, ...(e.plus ?? []).map(lit)].join(' | ');
    return (e.values ?? []).map(lit).join(' | ');
  };

  const storeEnums = m.enums.filter((e) => layerOf(e) === 'store');
  return { type, object, enumType, storeEnums };
}
