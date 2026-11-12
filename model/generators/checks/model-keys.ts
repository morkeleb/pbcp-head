// A Clay precheck: the model names only the keys model/README.md documents, and every name it refers to exists. A
// typo ("optinal") or a ref to a type that is not there fails before anything is written, naming the place and the keys
// allowed there, so the model stays the fixed reference the generated files are checked against.

import { PreCheck, type PreCheckContext } from 'clay-generator/types';
import { isSpread, type Field, type Model, type Spec, type Spread } from '../lib/model';

const SPEC = ['type', 'of', 'ref', 'member', 'values', 'value', 'fields', 'extends', 'name', 'optional', 'nullable', 'min', 'nonnegative', 'positive', 'pattern', 'describe', 'doc'];
const ALLOWED: Record<string, string[]> = {
  root: ['imports', 'scalars', 'enums', 'types', 'store'],
  import: ['name', 'import', 'from', 'kind', 'doc'],
  scalar: SPEC,
  enum: ['name', 'values', 'from', 'plus', 'export', 'layer', 'doc'],
  type: ['name', 'layer', 'registry', 'id', 'description', 'describe', 'doc', 'export', 'extends', 'fields', 'union', 'is', 'alias', 'atLeastOne'],
  variant: ['fields', 'describe', 'route'],
  field: SPEC,
  spread: ['spread'],
  store: ['version', 'doc', 'objectStores'],
  objectStore: ['const', 'name', 'keyPath', 'autoIncrement', 'holds', 'indexes', 'search'],
};
const TYPES = ['string', 'integer', 'number', 'boolean', 'literal', 'enum', 'ref', 'array', 'record', 'object', 'unknown'];

export function check(m: Model): string[] {
  const errors: string[] = [];
  const keys = (o: object, place: string, kind: keyof typeof ALLOWED) => {
    for (const k of Object.keys(o)) if (!ALLOWED[kind]!.includes(k)) errors.push(`${place}: unknown key "${k}"; allowed: ${ALLOWED[kind]!.join(', ')}`);
  };
  const names = new Set([...m.imports, ...m.scalars, ...m.enums, ...m.types].map((x) => x.name));
  const known = (n: string | undefined, place: string) => {
    if (n !== undefined && !names.has(n)) errors.push(`${place}: "${n}" is not a type, enum, scalar or import of the model`);
  };
  const spec = (s: Spec, place: string) => {
    keys(s, place, 'field');
    if (!TYPES.includes(s.type)) errors.push(`${place}: type "${s.type}"; allowed: ${TYPES.join(', ')}`);
    if (s.type === 'ref') known(s.ref, place);
    known(s.extends, place);
    if ((s.type === 'array' || s.type === 'record') && !s.of) errors.push(`${place}: an ${s.type} needs "of"`);
    if (s.of) spec(s.of, `${place}[]`);
    s.fields?.forEach((f) => field(f, place));
  };
  const field = (f: Field | Spread, place: string) => {
    if (isSpread(f)) {
      keys(f, `${place}.…`, 'spread');
      known(f.spread, place);
    } else spec(f, `${place}.${f.name}`);
  };
  keys(m, 'model', 'root');
  m.imports.forEach((i) => keys(i, `import ${i.name}`, 'import'));
  m.scalars.forEach((s) => spec(s, `scalar ${s.name}`));
  m.enums.forEach((e) => {
    keys(e, `enum ${e.name}`, 'enum');
    known(e.from, `enum ${e.name}`);
  });
  for (const t of m.types) {
    keys(t, `type ${t.name}`, 'type');
    [t.extends, t.is, t.alias].forEach((n) => known(n, `type ${t.name}`));
    t.fields?.forEach((f) => field(f, t.name));
    t.union?.forEach((v, i) => {
      keys(v, `type ${t.name} | ${i}`, 'variant');
      v.fields.forEach((f) => field(f, `${t.name}|${i}`));
    });
    const own = new Set((t.fields ?? []).filter((f): f is Field => !isSpread(f)).map((f) => f.name));
    t.atLeastOne?.fields.forEach((f) => own.has(f) || errors.push(`type ${t.name}: atLeastOne names "${f}", which is not one of its fields`));
  }
  keys(m.store, 'store', 'store');
  m.store.objectStores.forEach((s) => {
    keys(s, `store ${s.name}`, 'objectStore');
    known(s.holds, `store ${s.name}`);
  });
  return errors;
}

export default class extends PreCheck {
  check({ data }: PreCheckContext): string[] {
    return check((data as { model: Model }).model);
  }
}
