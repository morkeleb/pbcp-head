// The model as Swift declarations (swift-models): one intermediate form, then Swift text. Core's schemas are read by
// reference at generation time (z.toJSONSchema of @pbcp/core's Zod), never copied into the model: the card's
// producer-owned fields and the head fields come from core, the head's own from the model.

import { z } from 'zod';
import * as core from '@pbcp/core';
import { isSpread, layerOf, type EnumDef, type Field, type Model, type Spec, type Spread, type TypeDef } from './model';

export type SType =
  | { kind: 'prim'; swift: 'String' | 'Int' | 'Double' | 'Bool' | 'JSONValue' | 'Timestamp' }
  | { kind: 'named'; name: string }
  | { kind: 'array'; of: SType }
  | { kind: 'dict'; of: SType };

export interface SField {
  json: string;
  swift: string;
  type: SType;
  optional: boolean;
  nullable: boolean;
  docs: string[];
}

export type SDecl =
  | { kind: 'struct'; name: string; fields: SField[]; loose: boolean; docs: string[] }
  | { kind: 'enum'; name: string; values: string[]; docs: string[] }
  | { kind: 'tagged'; name: string; tag: string; cases: Array<{ value: string; fields: SField[]; docs: string[] }>; docs: string[] }
  | { kind: 'untagged'; name: string; cases: Array<{ field: SField }>; docs: string[] }
  | { kind: 'anyOf'; name: string; cases: Array<{ label: string; type: SType }>; docs: string[] }
  | { kind: 'alias'; name: string; target: string; docs: string[] }
  | { kind: 'meta'; name: string; fields: SField[]; docs: string[] };

type Json = { [k: string]: any };

const RESERVED = new Set(['protocol', 'default', 'in', 'is', 'as', 'for', 'class', 'struct', 'enum', 'case', 'func', 'let', 'var', 'return', 'self', 'Self', 'Type', 'init', 'extension', 'operator', 'repeat', 'where', 'while', 'switch', 'import', 'internal', 'public', 'private', 'static', 'subscript', 'super', 'throw', 'throws', 'true', 'false', 'nil', 'try', 'catch', 'do', 'else', 'if', 'guard', 'break', 'continue', 'fallthrough', 'defer', 'associatedtype', 'typealias', 'inout', 'some', 'any', 'deinit', 'fileprivate', 'open', 'extra']);

/** `orders.claim_seq` → `ordersClaimSeq`, `next-week` → `nextWeek`, `PBCP_HEAD_URL` → `pbcpHeadUrl`. */
export function camel(s: string): string {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = parts.map((p, i) => {
    const w = /^[A-Z0-9]+$/.test(p) ? p.toLowerCase() : p;
    return i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1);
  });
  return out.join('') || '_';
}
export const pascal = (s: string) => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};
/** A property or case name, backticked when Swift reserves it (`extra` is the loose types' own). */
export const ident = (s: string) => {
  const c = camel(s);
  return RESERVED.has(c) ? (c === 'extra' ? 'extra_' : `\`${c}\``) : c;
};

/** The owner each core import's inline types are named after (`CardSource`, `CardAction`). */
const CORE_OWNER: Record<string, string> = { ProducerCardSchema: 'Card', HeadFieldsSchema: 'Card', DecisionSchema: 'DecisionRequest', HeadDescriptionSchema: 'HeadDescription' };

export function swiftModel(m: Model): SDecl[] {
  const decls = new Map<string, SDecl>();
  const order: string[] = [];
  const add = (d: SDecl) => {
    if (!decls.has(d.name)) order.push(d.name);
    decls.set(d.name, d);
  };
  const imports = new Map(m.imports.map((i) => [i.name, i]));
  const coreJson = (name: string): Json => {
    const imp = imports.get(name)!;
    return z.toJSONSchema((core as unknown as Record<string, z.ZodType>)[imp.import]!, { io: 'output', unrepresentable: 'any' }) as Json;
  };
  const coreConst = (name: string): readonly string[] => (core as unknown as Record<string, readonly string[]>)[imports.get(name)!.import]!;

  // Enums: the model's by name, every other by its value set (so core's `urgency` and `delivery` are `Urgency`).
  const enumValues = (e: EnumDef) => [...(e.from ? coreConst(e.from) : []), ...(e.values ?? []), ...(e.plus ?? [])];
  const byValues = new Map<string, string>();
  const sig = (vs: readonly string[]) => [...vs].sort().join('|');
  for (const e of m.enums) {
    add({ kind: 'enum', name: e.name, values: enumValues(e), docs: e.doc ? [e.doc] : [] });
    if (!byValues.has(sig(enumValues(e)))) byValues.set(sig(enumValues(e)), e.name);
  }
  const enumFor = (values: readonly string[], name: string): SType => {
    const known = byValues.get(sig(values));
    if (known) return { kind: 'named', name: known };
    byValues.set(sig(values), name);
    add({ kind: 'enum', name, values: [...values], docs: [] });
    return { kind: 'named', name };
  };

  // --- core's JSON Schema → fields ------------------------------------------------------------------------------------
  const fromJson = (js: Json, owner: string, field: string): SType => {
    if (js.const !== undefined) return { kind: 'prim', swift: typeof js.const === 'boolean' ? 'Bool' : 'String' };
    if (js.enum) return enumFor(js.enum, owner + pascal(field));
    if (js.anyOf) {
      const name = owner + pascal(field.replace(/s$/, ''));
      const cases = (js.anyOf as Json[]).map((v) => (v.type === 'object' ? { label: 'object', type: fromJson(v, name, 'object') } : { label: 'string', type: fromJson(v, owner, field) }));
      add({ kind: 'anyOf', name, cases, docs: [] });
      return { kind: 'named', name };
    }
    switch (js.type) {
      case 'string':
        return { kind: 'prim', swift: 'String' };
      case 'integer':
        return { kind: 'prim', swift: 'Int' };
      case 'number':
        return { kind: 'prim', swift: 'Double' };
      case 'boolean':
        return { kind: 'prim', swift: 'Bool' };
      case 'array':
        return { kind: 'array', of: fromJson(js.items ?? {}, owner, field) };
      case 'object': {
        if (!js.properties) return { kind: 'dict', of: { kind: 'prim', swift: 'JSONValue' } };
        const name = owner + pascal(field);
        add({ kind: 'struct', name, fields: jsonFields(js, name), loose: js.additionalProperties !== undefined && js.additionalProperties !== false, docs: [] });
        return { kind: 'named', name };
      }
      default:
        return { kind: 'prim', swift: 'JSONValue' };
    }
  };
  const jsonFields = (js: Json, owner: string, skip: ReadonlySet<string> = new Set()): SField[] =>
    Object.entries(js.properties ?? {}).filter(([k]) => !skip.has(k)).map(([k, v]) => ({
      json: k,
      swift: ident(k),
      type: fromJson(v as Json, owner, k),
      optional: !(js.required ?? []).includes(k),
      nullable: false,
      docs: [(v as Json).description].filter(Boolean),
    }));
  const coreFields = (name: string, skip?: ReadonlySet<string>) => jsonFields(coreJson(name), CORE_OWNER[imports.get(name)!.import] ?? name, skip);
  const coreLoose = (name: string) => {
    const a = coreJson(name).additionalProperties;
    return a !== undefined && a !== false;
  };

  // --- the model → fields ---------------------------------------------------------------------------------------------
  const scalars = new Map(m.scalars.map((s) => [s.name, s]));
  const types = new Map(m.types.map((t) => [t.name, t]));
  const resolved = new Map<string, { fields: SField[]; loose: boolean }>();

  const typeOf = (s: Spec, owner: string, field: string): SType => {
    switch (s.type) {
      case 'string':
        return { kind: 'prim', swift: 'String' };
      case 'integer':
        return { kind: 'prim', swift: 'Int' };
      case 'number':
        return { kind: 'prim', swift: 'Double' };
      case 'boolean':
        return { kind: 'prim', swift: 'Bool' };
      case 'unknown':
        return { kind: 'prim', swift: 'JSONValue' };
      case 'literal':
        return { kind: 'prim', swift: typeof s.value === 'boolean' ? 'Bool' : typeof s.value === 'number' ? 'Int' : 'String' };
      case 'enum':
        return enumFor(s.values ?? [], owner + pascal(field));
      case 'array':
        return { kind: 'array', of: typeOf(s.of!, owner, `${field}Item`) };
      case 'record':
        return { kind: 'dict', of: typeOf(s.of!, owner, `${field}Value`) };
      case 'object': {
        const name = s.name ?? owner + pascal(field);
        const r = objectFields(s.fields ?? [], s.extends, name);
        add({ kind: 'struct', name, fields: r.fields, loose: r.loose, docs: [] });
        return { kind: 'named', name };
      }
      case 'ref': {
        const r = s.ref!;
        if (r === 'Timestamp') return { kind: 'prim', swift: 'Timestamp' };
        const sc = scalars.get(r);
        if (sc) return typeOf({ ...sc, describe: undefined }, owner, field);
        if (s.member) {
          const prop = coreJson(r).properties[s.member];
          return fromJson(prop, CORE_OWNER[imports.get(r)!.import] ?? r, s.member);
        }
        const t = types.get(r);
        if (t?.alias) return { kind: 'named', name: t.alias };
        return { kind: 'named', name: r };
      }
    }
  };

  const field = (f: Field, owner: string): SField => ({
    json: f.name,
    swift: ident(f.name),
    // A field's `name` is its key; an inline object's own name is only ever on an element (`of`).
    type: typeOf({ ...f, name: undefined }, owner, f.name),
    optional: f.optional === true,
    nullable: f.nullable === true,
    docs: [f.describe, f.doc ? `Source: ${f.doc}` : undefined].filter((x): x is string => Boolean(x)),
  });

  /** A field list with its base's fields first (Zod's `extend`: an own field replaces the base's in place). */
  const objectFields = (fs: Array<Field | Spread>, base: string | undefined, owner: string): { fields: SField[]; loose: boolean } => {
    let out: SField[] = [];
    let loose = false;
    if (base) {
      // A core field the model replaces is not resolved at all (core's `kind` has no `order`; the model's does).
      const own = new Set(fs.filter((f): f is Field => !isSpread(f)).map((f) => f.name));
      const b = imports.has(base) ? { fields: coreFields(base, own), loose: coreLoose(base) } : typeFields(base);
      out = b.fields.map((x) => ({ ...x }));
      loose = b.loose;
    }
    for (const f of fs) {
      const add = isSpread(f) ? coreFields(f.spread) : [field(f, owner)];
      for (const a of add) {
        const i = out.findIndex((x) => x.json === a.json);
        if (i >= 0) out[i] = a;
        else out.push(a);
      }
    }
    return { fields: out, loose };
  };

  const typeFields = (name: string): { fields: SField[]; loose: boolean } => {
    const hit = resolved.get(name);
    if (hit) return hit;
    const t = types.get(name)!;
    const r = t.is ? { fields: coreFields(t.is), loose: coreLoose(t.is) } : t.alias ? typeFields(t.alias) : objectFields(t.fields ?? [], t.extends, name);
    resolved.set(name, r);
    return r;
  };

  for (const t of m.types) {
    const docs = [t.description ?? t.describe, t.doc ? `Source: ${t.doc}` : undefined].filter((x): x is string => Boolean(x));
    if (t.name === 'Meta') {
      // The store's meta rows: one typed key per field, not a struct (`Meta.cursor` is a `MetaKey<Int>`).
      const fields = typeFields(t.name).fields;
      add({ kind: 'meta', name: 'Meta', fields, docs });
      continue;
    }
    if (t.alias) {
      add({ kind: 'alias', name: t.name, target: t.alias, docs });
      continue;
    }
    if (t.union) {
      const tag = commonTag(t);
      if (tag)
        add({
          kind: 'tagged',
          name: t.name,
          tag,
          docs,
          cases: t.union.map((v) => ({
            value: String((v.fields.find((f) => !isSpread(f) && f.name === tag) as Field).value),
            fields: v.fields.filter((f): f is Field => !isSpread(f) && f.name !== tag).map((f) => field(f, t.name)),
            docs: [v.describe, v.route].filter((x): x is string => Boolean(x)),
          })),
        });
      else add({ kind: 'untagged', name: t.name, docs, cases: t.union.map((v) => ({ field: field(v.fields[0] as Field, t.name) })) });
      continue;
    }
    const r = typeFields(t.name);
    add({ kind: 'struct', name: t.name, fields: r.fields, loose: r.loose, docs });
  }
  void layerOf;
  return order.map((n) => decls.get(n)!);
}

/** The field every variant of a union names with a literal: its tag (`action`, `kind`); none for SnoozeRequest. */
function commonTag(t: TypeDef): string | undefined {
  const first = t.union![0]!.fields.filter((f): f is Field => !isSpread(f) && f.type === 'literal').map((f) => f.name);
  return first.find((n) => t.union!.every((v) => v.fields.some((f) => !isSpread(f) && f.name === n && f.type === 'literal')));
}

// --- Swift text --------------------------------------------------------------------------------------------------------

export function swiftType(t: SType): string {
  switch (t.kind) {
    case 'prim':
      return t.swift;
    case 'named':
      return t.name;
    case 'array':
      return `[${swiftType(t.of)}]`;
    case 'dict':
      return `[String: ${swiftType(t.of)}]`;
  }
}

/** The stored property's type: optional, nullable (`T?`, written as null), or both (`Nullable<T>?`). */
export function propType(f: SField): string {
  const t = swiftType(f.type);
  if (f.optional && f.nullable) return `Nullable<${t}>?`;
  return f.optional || f.nullable ? `${t}?` : t;
}

const docLines = (docs: string[], indent: string) => docs.flatMap((d) => d.split('\n')).map((d) => `${indent}/// ${d}\n`).join('');

function decodeLine(f: SField, c: string, key: string): string {
  const t = swiftType(f.type);
  if (f.optional && f.nullable) return `try ${c}.decodeNullable(${t}.self, forKey: ${key})`;
  if (f.optional || f.nullable) return `try ${c}.decodeIfPresent(${t}.self, forKey: ${key})`;
  return `try ${c}.decode(${t}.self, forKey: ${key})`;
}
function encodeLine(f: SField, c: string, key: string, value: string): string {
  if (f.optional && f.nullable) return `try ${c}.encodeNullable(${value}, forKey: ${key})`;
  if (f.optional) return `try ${c}.encodeIfPresent(${value}, forKey: ${key})`;
  if (f.nullable) return `try ${c}.encodeOrNull(${value}, forKey: ${key})`;
  return `try ${c}.encode(${value}, forKey: ${key})`;
}

function structText(d: Extract<SDecl, { kind: 'struct' }>): string {
  const i = '    ';
  const props = d.fields.map((f) => `${docLines(f.docs, '  ')}  public var ${f.swift}: ${propType(f)}\n`).join('');
  const extraProp = d.loose ? `  /// Fields this model does not name, kept as they came (the protocol lets producers add their own).\n  public var extra: [String: JSONValue]\n` : '';
  const params = [...d.fields.map((f) => `${f.swift}: ${propType(f)}${f.optional || f.nullable ? ' = nil' : ''}`), ...(d.loose ? ['extra: [String: JSONValue] = [:]'] : [])];
  const assigns = [...d.fields.map((f) => `${i}self.${f.swift.replace(/`/g, '')} = ${f.swift}`), ...(d.loose ? [`${i}self.extra = extra`] : [])];
  const plain = (f: SField) => f.swift.replace(/`/g, '');
  const keys = d.fields.map((f) => `${i}case ${f.swift} = "${f.json}"`);
  const dec = d.fields.map((f) => `${i}self.${plain(f)} = ${decodeLine(f, 'c', `.${f.swift}`)}`);
  const enc = d.fields.map((f) => `${i}${encodeLine(f, 'c', `.${f.swift}`, `self.${plain(f)}`)}`);
  return `${docLines(d.docs, '')}public struct ${d.name}: Codable, Sendable, Equatable {
${props}${extraProp}
  public init(${params.join(', ')}) {
${assigns.join('\n')}
  }

  private enum CodingKeys: String, CodingKey, CaseIterable {
${keys.length ? keys.join('\n') : `${i}case _none = "\\u{0}"`}
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
${dec.join('\n')}${d.loose ? `\n${i}extra = try decoder.extras(known: CodingKeys.allCases.map(\\.rawValue))` : ''}
  }

  public func encode(to encoder: any Encoder) throws {
    ${d.fields.length ? 'var' : '_ ='} c = encoder.container(keyedBy: CodingKeys.self)
${enc.join('\n')}${d.loose ? `\n${i}try encoder.encodeExtras(extra)` : ''}
  }
}
`;
}

function enumText(d: Extract<SDecl, { kind: 'enum' }>): string {
  return `${docLines(d.docs, '')}public enum ${d.name}: String, Codable, Sendable, Equatable, CaseIterable {
${d.values.map((v) => `  case ${ident(v)}${ident(v).replace(/`/g, '') === v ? '' : ` = "${v}"`}`).join('\n')}
}
`;
}

function taggedText(d: Extract<SDecl, { kind: 'tagged' }>): string {
  const caseDecl = d.cases.map((c) => `${docLines(c.docs, '  ')}  case ${ident(c.value)}${c.fields.length ? `(${c.fields.map((f) => `${f.swift.replace(/`/g, '')}: ${propType(f)}`).join(', ')})` : ''}`).join('\n');
  const decCases = d.cases
    .map((c) => {
      const args = c.fields.map((f) => `${f.swift.replace(/`/g, '')}: ${decodeLine(f, 'c', `AnyKey("${f.json}")`)}`).join(', ');
      return `    case "${c.value}": self = .${ident(c.value)}${c.fields.length ? `(${args})` : ''}`;
    })
    .join('\n');
  const encCases = d.cases
    .map((c) => {
      const binds = c.fields.map((f) => `let ${f.swift.replace(/`/g, '')}`).join(', ');
      const body = c.fields.map((f) => `      ${encodeLine(f, 'c', `AnyKey("${f.json}")`, f.swift.replace(/`/g, ''))}`).join('\n');
      return `    case .${ident(c.value)}${c.fields.length ? `(${binds})` : ''}:\n      try c.encode("${c.value}", forKey: AnyKey("${d.tag}"))${body ? `\n${body}` : ''}`;
    })
    .join('\n');
  return `${docLines(d.docs, '')}public enum ${d.name}: Codable, Sendable, Equatable {
${caseDecl}

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let tag = try c.decode(String.self, forKey: AnyKey("${d.tag}"))
    switch tag {
${decCases}
    default: throw DecodingError.dataCorruptedError(forKey: AnyKey("${d.tag}"), in: c, debugDescription: "unknown ${d.tag} \\(tag)")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    switch self {
${encCases}
    }
  }
}
`;
}

function untaggedText(d: Extract<SDecl, { kind: 'untagged' }>): string {
  const cases = d.cases.map((c) => `  case ${c.field.swift.replace(/`/g, '')}(${propType({ ...c.field, optional: false })})`).join('\n');
  const dec = d.cases.map((c) => `    if c.contains(AnyKey("${c.field.json}")) { self = .${c.field.swift.replace(/`/g, '')}(${decodeLine({ ...c.field, optional: false }, 'c', `AnyKey("${c.field.json}")`)}); return }`).join('\n');
  const enc = d.cases.map((c) => `    case .${c.field.swift.replace(/`/g, '')}(let v): ${encodeLine({ ...c.field, optional: false }, 'c', `AnyKey("${c.field.json}")`, 'v')}`).join('\n');
  return `${docLines(d.docs, '')}public enum ${d.name}: Codable, Sendable, Equatable {
${cases}

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
${dec}
    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "${d.name}: none of ${d.cases.map((c) => c.field.json).join(', ')}"))
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    switch self {
${enc}
    }
  }
}
`;
}

function anyOfText(d: Extract<SDecl, { kind: 'anyOf' }>): string {
  return `${docLines(d.docs, '')}public enum ${d.name}: Codable, Sendable, Equatable {
${d.cases.map((c) => `  case ${c.label}(${swiftType(c.type)})`).join('\n')}

  public init(from decoder: any Decoder) throws {
${d.cases.map((c) => `    if let v = try? ${swiftType(c.type)}(from: decoder) { self = .${c.label}(v); return }`).join('\n')}
    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "${d.name}: no variant matched"))
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
${d.cases.map((c) => `    case .${c.label}(let v): try v.encode(to: encoder)`).join('\n')}
    }
  }
}
`;
}

export function declText(d: SDecl): string {
  switch (d.kind) {
    case 'struct':
      return structText(d);
    case 'enum':
      return enumText(d);
    case 'tagged':
      return taggedText(d);
    case 'untagged':
      return untaggedText(d);
    case 'anyOf':
      return anyOfText(d);
    case 'alias':
      return `${docLines(d.docs, '')}public typealias ${d.name} = ${d.target}\n`;
    case 'meta':
      return `${docLines(d.docs, '')}public enum ${d.name} {\n${d.fields.map((f) => `${docLines(f.docs, '  ')}  public static let ${f.swift} = MetaKey<${swiftType(f.type)}>("${f.json}")`).join('\n')}\n}\n`;
  }
}

export const SWIFT_HEADER = (generator: string) =>
  `// GENERATED by Clay from model/model.json (generator ${generator}). Do not edit: change the model and run \`pnpm generate\`.\n// model/README.md says what the model holds and how this file is made.\n`;
