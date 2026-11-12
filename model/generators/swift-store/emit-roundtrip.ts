// swift-store (templates/RoundTrip.generated.swift.ejs loads this): the Swift half of the gauge across languages. Each
// fixture in model/fixtures/ is decoded with the generated model, written to the SQLite store, read back and encoded to
// canonical JSON, which must equal the fixture: a field the web keeps and Swift drops fails here
// (test/model/roundtrip.test.ts is the TypeScript half).

import { isSpread, layerOf, type Model } from '../lib/model';
import { SWIFT_HEADER } from '../lib/swift';

export function emit(m: Model): string {
  const api = new Set(m.types.filter((t) => layerOf(t) === 'api').map((t) => t.name));
  const cases: string[] = [];
  for (const s of m.store.objectStores) {
    if (s.holds === 'MeCard')
      cases.push(`    case "MeCard":
      let card = try PBCPJSON.decoder().decode(MeCard.self, from: value)
      try await store.apply([card])
      return try PBCPJSON.encoder().encode(try #require(try await store.storedCard(card.id)))`);
  }
  const meta = m.types.find((t) => t.name === 'Meta');
  for (const f of meta?.fields ?? []) {
    if (isSpread(f)) continue;
    const entity = f.type === 'ref' ? f.ref : f.type === 'object' ? f.extends : undefined;
    if (!entity || !api.has(entity)) continue;
    const key = f.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const type = f.type === 'object' ? `Meta${key.charAt(0).toUpperCase()}${key.slice(1)}` : entity;
    cases.push(`    case "${entity}":
      try await store.setMeta(Meta.${key}, try PBCPJSON.decoder().decode(${type}.self, from: value))
      return try PBCPJSON.encoder().encode(try #require(try await store.meta(Meta.${key})))`);
  }
  return `${SWIFT_HEADER('swift-store')}
import Foundation
import PBCPModels
import PBCPStore
import Testing

/// model/fixtures/, from this file: ios/Packages/PBCPStore/Tests/PBCPStoreTests → the repo root.
private let fixtures = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  .appending(path: "model/fixtures")

private let names = ((try? FileManager.default.contentsOfDirectory(atPath: fixtures.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()

/// JSON with every object's keys sorted and slashes unescaped: the canonical form both languages compare.
func canonical(_ data: Data) throws -> String {
  let any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  return String(decoding: try JSONSerialization.data(withJSONObject: any, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]), as: UTF8.self)
}

/// Decodes a fixture's value as its entity, stores it where the device keeps that entity, and encodes what comes back.
private func roundTrip(_ entity: String, _ value: Data, _ store: Store) async throws -> Data {
  switch entity {
${cases.join('\n')}
    default:
      Issue.record("no place on the device for \\(entity)")
      return value
  }
}

@Suite("the model round-trips through the store")
struct RoundTrip {
  @Test func hasFixtures() { #expect(!names.isEmpty) }

  @Test(arguments: names)
  func fixture(_ name: String) async throws {
    let file = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appending(path: name))) as? [String: Any]
    let entity = try #require(file?["entity"] as? String)
    let value = try JSONSerialization.data(withJSONObject: try #require(file?["value"]), options: [.withoutEscapingSlashes])
    let dir = FileManager.default.temporaryDirectory.appending(path: "pbcp-roundtrip-\\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try Store(path: dir.appending(path: "store.sqlite").path)
    #expect(try canonical(await roundTrip(entity, value, store)) == canonical(value), "\\(name)")
  }
}
`;
}
