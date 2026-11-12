// The event feed (docs/local-first.md "Sync"; the web's app/(ui)/local/feed.ts): the head's change counter is the log.
// A sync asks GET /api/me/seq first and stops there when nothing moved; otherwise it pages GET /api/me/cards?after=
// and applies each card latest-wins by id. The first sync pulls the days ahead and the retention window a week at a time,
// newest first. When `settings_seq` moves, the floors are fetched and every stored card's effective sensitivity is
// recomputed (RFC 0.9 §9): a floor changes no card, so the feed cannot carry it. Run on launch, on foreground, from
// background refresh and when a push arrives; the outbox drains after every sync that reached the head.

import Foundation
import PBCPModels
import PBCPStore

public actor Sync {
  let store: Store
  let head: any FeedReader
  let outbox: Outbox?
  private var running: Task<Bool, Never>?

  public static let retentionDefault = 90
  static let windowDays = 7
  /// Days ahead the brief can show (two weeks); the first pull includes them.
  static let aheadDays = 14

  public init(store: Store, head: any FeedReader, outbox: Outbox?) {
    self.store = store
    self.head = head
    self.outbox = outbox
  }

  /// One sync; joins one already running. False when the head could not be reached.
  @discardableResult
  public func sync() async -> Bool {
    if let running { return await running.value }
    let task = Task { (try? await self.once()) ?? false }
    running = task
    let ok = await task.value
    running = nil
    if ok { await outbox?.drain() }
    return ok
  }

  private func once() async throws -> Bool {
    let stamp = try await head.getBriefStamp()
    let cursor = try await store.meta(Meta.cursor)
    let retention = try await store.meta(Meta.retention) ?? Sync.retentionDefault
    let archive = try await store.meta(Meta.archive) == true
    let kept = Days.add(stamp.date, -retention)
    let oldest = archive ? (try await store.meta(Meta.oldestDay) ?? kept) : kept

    if try await store.meta(Meta.settingsSeq) != stamp.settingsSeq {
      try await refreshFloors(stamp.settingsSeq)
    }

    if cursor == nil {
      // The first pull: a week at a time from the days ahead back to the edge of retention, newest first.
      var to = Days.add(stamp.date, Sync.aheadDays)
      while to >= kept {
        let from = Days.add(to, -(Sync.windowDays - 1))
        _ = try await pull(from: max(from, kept), to: to, after: nil) { _ in true }
        to = Days.add(from, -1)
      }
      try await store.setMeta(Meta.cursor, stamp.seq)
      try await store.setMeta(Meta.oldestDay, kept)
    }
    // The changes since the cursor: every state, latest-wins. A card older than retention is kept only when the device
    // already has it.
    let from = try await store.meta(Meta.cursor) ?? stamp.seq
    if stamp.seq > from || cursor == nil {
      let stored = Set(try await store.allCards().map(\.id))
      let max = try await pull(from: nil, to: nil, after: from) { archive || $0.day >= oldest || stored.contains($0.id) }
      try await store.setMeta(Meta.cursor, Swift.max(stamp.seq, max))
    }
    // The brief the head composed (its paragraph, folds and lists), kept with the cards.
    let brief = try await store.meta(Meta.brief)
    if brief?.seq != stamp.seq || brief?.date != stamp.date { try await refreshBrief() }
    if !archive { try await store.evict(before: oldest) }
    try await store.setMeta(Meta.syncedAt, Timestamp(Date.now).rawValue)
    return true
  }

  /// Every card of a query, page by page in change_seq order; the highest change_seq seen.
  private func pull(from: String?, to: String?, after: Int?, keep: (MeCard) -> Bool) async throws -> Int {
    var max = 0
    var next = after
    while true {
      let page = try await head.cards(from: from, to: to, after: next)
      let cards = page.cards.filter(keep)
      if !cards.isEmpty { try await store.apply(cards) }
      for c in page.cards { max = Swift.max(max, c.changeSeq) }
      guard let n = page.next else { return max }
      next = n
    }
  }

  /// The owner's floors, and every stored card's effective sensitivity recomputed under them with no card changed.
  private func refreshFloors(_ settingsSeq: Int) async throws {
    let settings = try await head.getSettings()
    let floors = Floors(all: settings.sensitivityFloor, producers: settings.sensitivityFloors.producers, labels: settings.sensitivityFloors.labels)
    try await store.setMeta(Meta.floors, floors)
    try await store.setMeta(Meta.foldPolicies, settings.foldPolicies.labels)
    var changed: [MeCard] = []
    for var card in try await store.allCards() {
      let effective = floors.effective(own: card.sensitivity, producer: card.producer, labels: card.labels ?? [])
      if effective != card.effectiveSensitivity {
        card.effectiveSensitivity = effective
        changed.append(card)
      }
    }
    try await store.apply(changed, force: true)
    // The brief's composition carries effective sensitivities too: the head recomputes it under the new floors.
    try await refreshBrief()
    try await store.setMeta(Meta.settingsSeq, settingsSeq)
  }

  private func refreshBrief() async throws {
    let brief = try await head.getBrief(spoken: nil)
    let fields = try PBCPJSON.decoder().decode([String: JSONValue].self, from: PBCPJSON.encoder().encode(brief))
    let stamped = fields.merging(["fetched_at": .string(Timestamp(Date.now).rawValue)]) { _, new in new }
    try await store.setMeta(Meta.brief, try PBCPJSON.decoder().decode(MetaBrief.self, from: PBCPJSON.encoder().encode(stamped)))
  }
}

/// Local days as YYYY-MM-DD, moved by whole days.
enum Days {
  static func add(_ day: String, _ n: Int) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    let f = Date.ISO8601FormatStyle().year().month().day()
    guard let d = try? f.parse(day), let moved = cal.date(byAdding: .day, value: n, to: d) else { return day }
    return moved.formatted(f)
  }
}
