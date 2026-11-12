// The store's foundation: cards applied from a background task while a main-actor observer receives snapshots (values,
// never the database), latest change_seq wins, the outbox laid over a card, search, meta rows and eviction.

import Foundation
import PBCPModels
import PBCPStore
import Testing

func tempStore() throws -> Store {
  let dir = FileManager.default.temporaryDirectory.appending(path: "pbcp-store-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return try Store(path: dir.appending(path: "store.sqlite").path)
}

/// A card from the minimal fixture, changed as the test needs.
func card(_ id: String, day: String = "2026-11-12", seq: Int = 1, title: String = "A card", kind: CardKind = .decision, html: String = "<p>Body</p>") throws -> MeCard {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appending(path: "model/fixtures/card-minimal.json")
  let file = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  var c = try PBCPJSON.decoder().decode(MeCard.self, from: JSONSerialization.data(withJSONObject: file["value"]!))
  c.id = id
  c.day = day
  c.changeSeq = seq
  c.title = title
  c.kind = kind
  c.renderedHtml = html
  return c
}

@MainActor
final class DayModel {
  var cards: [MeCard] = []
}

@Suite struct StoreTests {
  @Test func backgroundAppliesReachAMainActorObserver() async throws {
    let store = try tempStore()
    let model = DayModel()
    let observer = Task { @MainActor in
      for try await snapshot in store.observeDay("2026-11-12") {
        model.cards = snapshot
        if snapshot.count == 20 { return }
      }
    }
    let writer = Task.detached {
      for i in 0..<20 { try await store.apply([try card("mail:inbox:\(i)", seq: i + 1)]) }
    }
    try await writer.value
    try await observer.value
    #expect(await model.cards.count == 20)
  }

  @Test func latestChangeSeqWins() async throws {
    let store = try tempStore()
    try await store.apply([try card("mail:inbox:1", seq: 5, title: "Newer")])
    let changed = try await store.apply([try card("mail:inbox:1", seq: 3, title: "Older")])
    #expect(changed.isEmpty)
    #expect(try await store.storedCard("mail:inbox:1")?.title == "Newer")
    try await store.apply([try card("mail:inbox:1", seq: 3, title: "Forced")], force: true)
    #expect(try await store.storedCard("mail:inbox:1")?.title == "Forced")
  }

  @Test func theOutboxIsLaidOverACard() async throws {
    let store = try tempStore()
    try await store.apply([try card("mail:inbox:1")])
    let row = try await store.enqueue(.decide(body: DecisionRequest(decision: "approve")), cardID: "mail:inbox:1", title: "A card", seenSeq: 1)
    #expect(row.seq != nil)
    #expect(try await store.card("mail:inbox:1")?.state == .decided)
    #expect(try await store.card("mail:inbox:1")?.decision == "approve")
    #expect(try await store.storedCard("mail:inbox:1")?.state == .open)
    try await store.remove(row.seq!)
    #expect(try await store.card("mail:inbox:1")?.state == .open)
  }

  @Test func searchesTitleAndBodyText() async throws {
    let store = try tempStore()
    try await store.apply([try card("mail:inbox:1", title: "Reply to Anna", html: "<p>About the <strong>invoice</strong></p>"), try card("mail:inbox:2", title: "Bins")])
    #expect(try await store.search("anna") == ["mail:inbox:1"])
    #expect(try await store.search("invo") == ["mail:inbox:1"])
    let text = try #require(try await store.text("mail:inbox:1"))
    #expect(String(text.characters) == "About the invoice")
  }

  @Test func metaRowsAndEviction() async throws {
    let store = try tempStore()
    try await store.setMeta(Meta.cursor, 42)
    #expect(try await store.meta(Meta.cursor) == 42)
    #expect(try await store.meta(Meta.retention) == nil)
    try await store.apply([try card("mail:inbox:old", day: "2026-01-01"), try card("mail:inbox:new")])
    #expect(try await store.evict(before: "2026-06-01") == ["mail:inbox:old"])
    #expect(try await store.allCards().map(\.id) == ["mail:inbox:new"])
    #expect(try await store.search("card") == ["mail:inbox:new"])
  }
}
