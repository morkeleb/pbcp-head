// swift-store (templates/Store.generated.swift.ejs loads this): ios/Packages/PBCPStore/Sources/PBCPStore/Store.generated.swift.
// The SQLite schema from the model's `store` (each object store a table, its key and indexes, a WAL database, an FTS5
// table over the fields the model names for search), the records, and the actor `Store` with the API every screen and
// the sync use. The only DatabasePool in the app is the one inside it (ios/README.md, "The invariant").

import type { Model } from '../lib/model';
import { swiftModel, swiftType, SWIFT_HEADER, type SDecl, type SField } from '../lib/swift';

export function emit(m: Model): string {
  const decls = swiftModel(m);
  const struct = (name: string) => (decls.find((d) => d.kind === 'struct' && d.name === name) as Extract<SDecl, { kind: 'struct' }>).fields;
  const cards = m.store.objectStores.find((s) => s.holds === 'MeCard')!;
  const meta = m.store.objectStores.find((s) => s.holds === 'Meta')!;
  const outbox = m.store.objectStores.find((s) => s.holds === 'OutboxRow')!;
  const card = new Map(struct('MeCard').map((f) => [f.json, f]));
  const col = (k: string): SField => {
    const f = card.get(k);
    if (!f || f.optional) throw new Error(`swift-store: the cards' ${k} must be a required field of MeCard`);
    return f;
  };
  const sqlType = (f: SField) => (swiftType(f.type) === 'Int' ? '.integer' : '.text');
  const indexed = (cards.indexes ?? []).map((i) => col(i.keyPath));
  const key = col(cards.keyPath);
  const search = cards.search ?? [];
  const searchValue = (k: string) => {
    if (k === 'body_text') return 'StoreText.plain(text)';
    const f = card.get(k);
    if (!f) throw new Error(`swift-store: search field ${k} is not a field of MeCard`);
    return f.optional || f.nullable ? `card.${f.swift.replace(/`/g, '')} ?? ""` : `card.${f.swift.replace(/`/g, '')}`;
  };
  const fts = `${cards.name}_fts`;
  const outboxRow = struct('OutboxRow');

  return `${SWIFT_HEADER('swift-store')}
import Foundation
import GRDB
import PBCPModels

// --- records ---------------------------------------------------------------------------------------------------------

/// A row of \`${cards.name}\`: the card as the head served it (JSON, a snapshot replaced whole, latest change_seq wins),
/// the columns the model indexes, and the rendered body as text, converted when the card was applied.
struct CardRecord: Codable, FetchableRecord, PersistableRecord, Sendable {
  static let databaseTableName = "${cards.name}"
  var ${key.swift}: ${swiftType(key.type)}
${indexed.map((f) => `  var ${f.swift}: ${swiftType(f.type)}`).join('\n')}
  var card: Data
  var text: Data?

  enum CodingKeys: String, CodingKey {
    case ${key.swift} = "${key.json}"
${indexed.map((f) => `    case ${f.swift} = "${f.json}"`).join('\n')}
    case card, text
  }
}

/// A row of \`${meta.name}\`: one per meta key (the model's \`Meta\`), its value as JSON.
struct MetaRecord: Codable, FetchableRecord, PersistableRecord, Sendable {
  static let databaseTableName = "${meta.name}"
  var ${meta.keyPath}: String
  var value: Data
}

extension OutboxRow: FetchableRecord, PersistableRecord {
  public static let databaseTableName = "${outbox.name}"
  public mutating func didInsert(_ inserted: InsertionSuccess) { ${outbox.keyPath} = Int(inserted.rowID) }
}
extension OutboxAction: DatabaseValueConvertible {}
extension OutboxStatus: DatabaseValueConvertible {}

// --- the schema ------------------------------------------------------------------------------------------------------

enum Schema {
  /// The model's store version (model/model.json \`store.version\`): one migration per version.
  static let version = ${m.store.version}

  static var migrator: DatabaseMigrator {
    var migrator = DatabaseMigrator()
    migrator.registerMigration("v${m.store.version}") { db in
      try db.create(table: "${cards.name}") { t in
        t.primaryKey("${key.json}", ${sqlType(key)})
${indexed.map((f) => `        t.column("${f.json}", ${sqlType(f)}).notNull().indexed()`).join('\n')}
        t.column("card", .blob).notNull()
        t.column("text", .blob)
      }
      try db.create(table: "${meta.name}") { t in
        t.primaryKey("${meta.keyPath}", .text)
        t.column("value", .blob).notNull()
      }
      try db.create(table: "${outbox.name}") { t in
        t.autoIncrementedPrimaryKey("${outbox.keyPath}")
${outboxRow.filter((f) => f.json !== outbox.keyPath).map((f) => `        t.column("${f.json}", ${swiftType(f.type) === 'Int' ? '.integer' : swiftType(f.type).startsWith('[') ? '.blob' : '.text'})${f.optional || f.nullable ? '' : '.notNull()'}`).join('\n')}
      }
      // Search on the device (docs/local-first.md "The index"): never sent anywhere.
      try db.create(virtualTable: "${fts}", using: FTS5()) { t in
        t.column("${cards.keyPath}").notIndexed()
${search.map((k) => `        t.column("${k}")`).join('\n')}
      }
    }
    return migrator
  }
}

// --- the store -------------------------------------------------------------------------------------------------------

/// The device's copy of the head (docs/local-first.md): cards, meta rows and the outbox in one SQLite database (WAL).
/// Reads and writes run on this actor; what crosses to the main actor is a Sendable value, never a handle.
public actor Store {
  /// The only DatabasePool in the app. Internal: no view or view model can reach it (ios/README.md).
  let pool: DatabasePool

  /// Opens (or creates) the database at \`path\` and migrates it to the model's version.
  public init(path: String) throws {
    var config = Configuration()
    config.foreignKeysEnabled = true
    pool = try DatabasePool(path: path, configuration: config)
    try Schema.migrator.migrate(pool)
  }

  // --- cards ---

  /// Applies snapshots latest-wins by id: a card replaces the stored copy unless that copy is newer (a higher
  /// change_seq); \`force\` replaces regardless. The rendered body is converted to text here, off the main actor, and
  /// kept beside the card; the search index follows. Returns the ids it changed.
  @discardableResult
  public func apply(_ cards: [MeCard], force: Bool = false) throws -> [String] {
    let rows = try cards.map { card -> (MeCard, CardRecord, AttributedString) in
      let text = StoreText.attributed(html: card.renderedHtml)
      let record = CardRecord(${key.swift}: card.${key.swift}, ${indexed.map((f) => `${f.swift}: card.${f.swift}`).join(', ')}, card: try PBCPJSON.encoder().encode(card), text: try? JSONEncoder().encode(text))
      return (card, record, text)
    }
    return try pool.write { db in
      var changed: [String] = []
      for (card, record, text) in rows {
        if !force, let prev = try CardRecord.fetchOne(db, key: record.${key.swift}), prev.changeSeq > record.changeSeq { continue }
        try record.save(db)
        try db.execute(sql: "DELETE FROM ${fts} WHERE ${cards.keyPath} = ?", arguments: [card.${key.swift}])
        try db.execute(sql: "INSERT INTO ${fts} (${[cards.keyPath, ...search].join(', ')}) VALUES (${[cards.keyPath, ...search].map(() => '?').join(', ')})", arguments: [card.${key.swift}, ${search.map(searchValue).join(', ')}])
        changed.append(card.${key.swift})
      }
      return changed
    }
  }

  /// The stored card as the head sent it, without the outbox laid over it.
  public func storedCard(_ id: String) throws -> MeCard? {
    try pool.read { db in try CardRecord.fetchOne(db, key: id).map(Store.decode) }
  }

  /// The card with every unsent command for it laid over, in order: what the person sees.
  public func card(_ id: String) throws -> MeCard? {
    try pool.read { db in try CardRecord.fetchOne(db, key: id).map { try Store.overlay(Store.decode($0), Store.pending(db)) } }
  }

  /// The rendered body as text, converted when the card was applied.
  public func text(_ id: String) throws -> AttributedString? {
    try pool.read { db in try CardRecord.fetchOne(db, key: id)?.text.flatMap { try? JSONDecoder().decode(AttributedString.self, from: $0) } }
  }

  /// Every card whose day (§8) is in [from, to], with the outbox laid over.
  public func cards(from: String, to: String) throws -> [MeCard] {
    try pool.read { db in try Store.cards(db, from: from, to: to) }
  }

  public func allCards() throws -> [MeCard] {
    try pool.read { db in try CardRecord.fetchAll(db).map(Store.decode) }
  }

  /// Removes every card whose day is before \`day\` (retention); returns their ids.
  @discardableResult
  public func evict(before day: String) throws -> [String] {
    try pool.write { db in
      let ids = try String.fetchAll(db, sql: "SELECT ${cards.keyPath} FROM ${cards.name} WHERE day < ?", arguments: [day])
      for id in ids {
        try db.execute(sql: "DELETE FROM ${cards.name} WHERE ${cards.keyPath} = ?", arguments: [id])
        try db.execute(sql: "DELETE FROM ${fts} WHERE ${cards.keyPath} = ?", arguments: [id])
      }
      return ids
    }
  }

  /// Card ids matching every word of \`text\` as a prefix, best first.
  public func search(_ text: String, limit: Int = 50) throws -> [String] {
    guard let pattern = FTS5Pattern(matchingAllPrefixesIn: text) else { return [] }
    return try pool.read { db in
      try String.fetchAll(db, sql: "SELECT ${cards.keyPath} FROM ${fts} WHERE ${fts} MATCH ? ORDER BY rank LIMIT ?", arguments: [pattern, limit])
    }
  }

  // --- the outbox ---

  /// Appends a command for a card (docs/local-first.md "The outbox"): the card settles on the device at once.
  @discardableResult
  public func enqueue(_ command: Command, cardID: String, title: String, seenSeq: Int, at: Date = .now) throws -> OutboxRow {
    let row = OutboxRow(clientId: UUID().uuidString, cardId: cardID, action: command.action, body: try command.bodyJSON(), seenSeq: seenSeq, at: Timestamp(at).rawValue, status: .pending, tries: 0, title: title)
    return try pool.write { db in try row.inserted(db) }
  }

  /// The rows not yet sent, in the order the person made them.
  public func pending() throws -> [OutboxRow] {
    try pool.read { db in try Store.pending(db) }
  }

  public func remove(_ seq: Int) throws {
    _ = try pool.write { db in try OutboxRow.deleteOne(db, key: seq) }
  }

  public func update(_ row: OutboxRow) throws {
    try pool.write { db in try row.update(db) }
  }

  // --- meta ---

  public func meta<V>(_ key: MetaKey<V>) throws -> V? {
    try pool.read { db in try MetaRecord.fetchOne(db, key: key.name).map { try PBCPJSON.decoder().decode(V.self, from: $0.value) } }
  }

  public func setMeta<V>(_ key: MetaKey<V>, _ value: V) throws {
    let data = try PBCPJSON.encoder().encode(value)
    try pool.write { db in try MetaRecord(${meta.keyPath}: key.name, value: data).save(db) }
  }

  // --- observation: one stream per screen, values only ---

  /// A day's cards (§8), with the outbox laid over, every time either changes.
  public nonisolated func observeDay(_ day: String) -> some AsyncSequence<[MeCard], any Error> & Sendable {
    observe { db in try Store.cards(db, from: day, to: day) }
  }

  /// One card, with the outbox laid over.
  public nonisolated func observeCard(_ id: String) -> some AsyncSequence<MeCard?, any Error> & Sendable {
    observe { db in try CardRecord.fetchOne(db, key: id).map { try Store.overlay(Store.decode($0), Store.pending(db)) } }
  }

  /// Open tasks whose day is \`day\` or earlier (RFC 0.9 §8), with the outbox laid over.
  public nonisolated func observeTasks(through day: String) -> some AsyncSequence<[MeCard], any Error> & Sendable {
    observe { db in try Store.cards(db, from: "0000-00-00", to: day).filter { $0.kind == .task && $0.state == .open } }
  }

  /// The orders list as last fetched (a meta row).
  public nonisolated func observeOrders() -> some AsyncSequence<MetaOrders?, any Error> & Sendable {
    observe { db in try MetaRecord.fetchOne(db, key: Meta.orders.name).map { try PBCPJSON.decoder().decode(MetaOrders.self, from: $0.value) } }
  }

  /// How many commands wait to be sent ("N changes waiting to send").
  public nonisolated func observeWaitingCount() -> some AsyncSequence<Int, any Error> & Sendable {
    observe { db in try OutboxRow.fetchCount(db) }
  }

  nonisolated func observe<T: Sendable>(_ fetch: @escaping @Sendable (Database) throws -> T) -> AsyncValueObservation<T> {
    ValueObservation.tracking(fetch).values(in: pool)
  }

  // --- shared reads ---

  static func decode(_ r: CardRecord) throws -> MeCard { try PBCPJSON.decoder().decode(MeCard.self, from: r.card) }

  static func pending(_ db: Database) throws -> [OutboxRow] {
    try OutboxRow.order(Column("${outbox.keyPath}")).fetchAll(db)
  }

  static func cards(_ db: Database, from: String, to: String) throws -> [MeCard] {
    let rows = try CardRecord.filter(Column("day") >= from && Column("day") <= to).fetchAll(db)
    let pending = try Store.pending(db)
    return try rows.map { try overlay(decode($0), pending) }
  }

  static func overlay(_ card: MeCard, _ rows: [OutboxRow]) -> MeCard {
    rows.filter { $0.cardId == card.${key.swift} }.reduce(card) { $0.applying($1) }
  }
}
`;
}
