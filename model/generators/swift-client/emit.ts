// swift-client (templates/Operations.generated.swift.ejs loads this): ios/Packages/PBCPClient/Sources/PBCPClient/
// Operations.generated.swift, one async method on HeadClient per /api/me operation, typed on PBCPModels. The operations
// are read from packages/api-types/openapi.json, the document ts-api's schemas build (`pnpm generate` writes it before
// it runs Clay again), so the routes stay the head's and the shapes stay the model's.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Model } from '../lib/model';
import { camel, ident, SWIFT_HEADER } from '../lib/swift';

type Json = { [k: string]: any };

export function emit(m: Model): string {
  const doc = JSON.parse(readFileSync(join(process.cwd(), 'packages/api-types/openapi.json'), 'utf8')) as Json;
  // The document names a component by its id (`Error`); Swift by the model's name (`ErrorBody`).
  const byId = new Map(m.types.map((t) => [t.id ?? t.name, t.name]));
  const typeOfRef = (ref: string) => byId.get(ref.split('/').at(-1)!) ?? ref.split('/').at(-1)!;
  const methods: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths as Json)) {
    if (!path.startsWith('/api/me')) continue;
    for (const [verb, op] of Object.entries(ops as Json)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(verb)) continue;
      const params = ((op.parameters ?? []) as Json[]).filter((p) => !p.$ref);
      const pathParams = params.filter((p) => p.in === 'path');
      const queryParams = params.filter((p) => p.in === 'query');
      const bodyRef: string | undefined = op.requestBody?.content?.['application/json']?.schema?.$ref;
      const [okStatus, ok] = Object.entries(op.responses as Json).find(([s]) => s.startsWith('2'))!;
      const okJson: string | undefined = ok.content?.['application/json']?.schema?.$ref;
      const binary = !okJson && ok.content && Object.keys(ok.content).length > 0;
      const result = okJson ? typeOfRef(okJson) : binary ? 'Data' : 'NoContent';
      const conflictIsCard = op.responses['409']?.content?.['application/json']?.schema?.$ref?.endsWith('/Card') === true;
      const swiftParam = (p: Json) => `${ident(p.name)}: ${p.schema?.type === 'integer' ? 'Int' : 'String'}${p.required ? '' : '? = nil'}`;
      const args = [...pathParams.map(swiftParam), ...(bodyRef ? [`_ body: ${typeOfRef(bodyRef)}`] : []), ...queryParams.map(swiftParam)];
      const route = path.replace(/\{(\w+)\}/g, (_, n: string) => `\\(Self.segment(${ident(n)}))`);
      const query = queryParams.length ? `[${queryParams.map((p) => `("${p.name}", ${ident(p.name)}${p.schema?.type === 'integer' ? '.map(String.init)' : ''})`).join(', ')}]` : '[]';
      const docs = [op.summary, op.description].filter(Boolean).flatMap((d: string) => d.split('\n')).map((d: string) => `  /// ${d}`).join('\n');
      const call = verb === 'get'
        ? `  public func ${camel(op.operationId)}(${args.join(', ')}) async throws -> ${result} {\n    try await read(${result}.self, "${verb.toUpperCase()}", "${route}", query: ${query})\n  }`
        : `  public func ${camel(op.operationId)}(${args.join(', ')}) async -> WriteOutcome<${result}> {\n    await write(${result}.self, "${verb.toUpperCase()}", "${route}", query: ${query}, body: ${bodyRef ? 'body' : 'Optional<NoContent>.none'}, conflictIsCard: ${conflictIsCard}, expect: ${okStatus})\n  }`;
      methods.push(`${docs}\n  /// \`${verb.toUpperCase()} ${path}\`\n${call}`);
    }
  }
  return `${SWIFT_HEADER('swift-client')}
import Foundation
import PBCPModels

extension HeadClient {
${methods.join('\n\n')}
}
`;
}
