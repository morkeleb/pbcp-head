// The outbox for each of the head's answers (docs/local-first.md's table), and the sync recomputing effective
// sensitivity when the owner's floors moved, with no card changed (RFC 0.9 §9). The head is a fake.

import Foundation
import PBCPClient
import PBCPModels
import PBCPStore
import PBCPSync
import Testing

func tempStore() throws -> Store {
  let dir = FileManager.default.temporaryDirectory.appending(path: "pbcp-sync-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return try Store(path: dir.appending(path: "store.sqlite").path)
}

func fixture<T: Decodable>(_ name: String, as: T.Type) throws -> T {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appending(path: "model/fixtures/\(name)")
  let file = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
  return try PBCPJSON.decoder().decode(T.self, from: JSONSerialization.data(withJSONObject: file["value"]!))
}

/// The protocol card the head answers an owner action with: the stored card's protocol fields.
func protocolCard(_ c: MeCard, decision: String? = nil, state: CardState = .decided) throws -> Card {
  var fields = try PBCPJSON.decoder().decode([String: JSONValue].self, from: PBCPJSON.encoder().encode(c))
  for k in ["rendered_html", "lead", "lead_source", "rendered_lead", "day", "effective_sensitivity"] { fields[k] = nil }
  fields["state"] = .string(state.rawValue)
  if let decision { fields["decision"] = .string(decision) }
  fields["change_seq"] = .int(c.changeSeq + 1)
  return try PBCPJSON.decoder().decode(Card.self, from: PBCPJSON.encoder().encode(fields))
}

actor FakeHead: OwnerCommands, FeedReader {
  var answer: @Sendable (String) -> WriteOutcome<Card>
  var sent: [String] = []
  var stamp = BriefStamp(seq: 10, date: "2026-11-12", settingsSeq: 0)
  var settings: Settings?
  var brief: Brief

  init(brief: Brief, answer: @escaping @Sendable (String) -> WriteOutcome<Card>) {
    self.brief = brief
    self.answer = answer
  }

  func set(answer: @escaping @Sendable (String) -> WriteOutcome<Card>) { self.answer = answer }
  func set(stamp: BriefStamp, settings: Settings) {
    self.stamp = stamp
    self.settings = settings
  }

  func decide(id: String, _ body: DecisionRequest) async -> WriteOutcome<Card> { sent.append("decide \(id)"); return answer(id) }
  func acknowledge(id: String) async -> WriteOutcome<Card> { sent.append("ack \(id)"); return answer(id) }
  func snooze(id: String, _ body: SnoozeRequest) async -> WriteOutcome<Card> { sent.append("snooze \(id)"); return answer(id) }
  func unsnooze(id: String) async -> WriteOutcome<Card> { sent.append("unsnooze \(id)"); return answer(id) }

  func getBriefStamp() async throws -> BriefStamp { stamp }
  func cards(from: String?, to: String?, after: Int?) async throws -> CardList { CardList(cards: [], next: nil, timezone: "UTC") }
  func getSettings() async throws -> Settings { try #require(settings) }
  func getBrief(spoken: String?) async throws -> Brief { brief }
}

@Suite struct OutboxTests {
  let card: MeCard
  let brief: Brief
  init() throws {
    card = try fixture("decision-private.json", as: MeCard.self)
    brief = try fixture("brief-day.json", as: Brief.self)
  }

  func setUp(_ answer: @escaping @Sendable (String) -> WriteOutcome<Card>) async throws -> (Store, FakeHead, Outbox) {
    let store = try tempStore()
    try await store.apply([card])
    let head = FakeHead(brief: brief, answer: answer)
    return (store, head, Outbox(store: store, head: head))
  }

  @Test func sentRemovesTheRowAndKeepsWhatTheHeadRendered() async throws {
    let answer = try protocolCard(card, decision: "send")
    let (store, _, outbox) = try await setUp { _ in .sent(answer) }
    let row = try await outbox.command(.decide(body: DecisionRequest(decision: "send")), card: card)
    #expect(try await store.pending().isEmpty)
    let stored = try #require(try await store.storedCard(card.id))
    #expect(stored.state == .decided && stored.decision == "send" && stored.renderedHtml == card.renderedHtml)
    if case .sent(let c)? = await outbox.outcomes[row.clientId] { #expect(c.decision == "send") } else { Issue.record("not sent") }
  }

  @Test func conflictTakesTheHeadsState() async throws {
    let elsewhere = try protocolCard(card, decision: "dismissed")
    let (store, _, outbox) = try await setUp { _ in .conflict(elsewhere) }
    try await outbox.command(.decide(body: DecisionRequest(decision: "send")), card: card)
    #expect(try await store.pending().isEmpty)
    #expect(try await store.card(card.id)?.decision == "dismissed")
  }

  @Test func needsPersonWaitsWithEveryRowBehindItAndSurvives() async throws {
    let (store, head, outbox) = try await setUp { _ in .needsPerson }
    try await outbox.command(.decide(body: DecisionRequest(decision: "send")), card: card)
    try await outbox.command(.ack(body: [:]), card: card)
    let rows = try await store.pending()
    #expect(rows.count == 2 && rows[0].status == .needsPerson && rows[1].status == .pending)
    #expect(await head.sent == ["decide \(card.id)"])
    // After the step-up the head records it: the waiting row goes, then the one behind it.
    let answer = try protocolCard(card, decision: "send")
    await head.set { _ in .sent(answer) }
    try await outbox.resume(cardID: card.id)
    #expect(try await store.pending().isEmpty)
    #expect(await head.sent == ["decide \(card.id)", "decide \(card.id)", "ack \(card.id)"])
  }

  @Test func refusedDropsTheRowAndTheCardReverts() async throws {
    let (store, _, outbox) = try await setUp { _ in .refused(status: 400, message: "invalid_decision") }
    let row = try await outbox.command(.decide(body: DecisionRequest(decision: "nope")), card: card)
    #expect(try await store.pending().isEmpty)
    #expect(try await store.card(card.id)?.state == .open)
    #expect(await outbox.outcomes[row.clientId] == .refused(status: 400, message: "invalid_decision"))
  }

  @Test func offlineKeepsTheRowAndCountsTheTry() async throws {
    let (store, _, outbox) = try await setUp { _ in .offline }
    let row = try await outbox.command(.snooze(body: .preset(.tomorrow)), card: card)
    let rows = try await store.pending()
    #expect(rows.count == 1 && rows[0].tries == 1 && rows[0].status == .pending)
    #expect(try await store.card(card.id)?.snoozedUntil != nil)
    #expect(await outbox.outcomes[row.clientId] == .waiting)
  }
}

@Suite struct SyncTests {
  @Test func aMovedSettingsSeqRecomputesEffectiveSensitivityWithNoCardChanged() async throws {
    let store = try tempStore()
    let card = try fixture("card-minimal.json", as: MeCard.self)
    try await store.apply([card])
    try await store.setMeta(Meta.cursor, 10)
    try await store.setMeta(Meta.settingsSeq, 0)
    #expect(try await store.storedCard(card.id)?.effectiveSensitivity == .normal)

    let brief = try fixture("brief-day.json", as: Brief.self)
    let head = FakeHead(brief: brief) { _ in .offline }
    let settings = Settings(
      head: "m", displayName: nil, timezone: "UTC", timezoneSource: .default, timezoneOverride: nil, deviceTimezone: nil,
      sensitivityFloor: nil, sensitivityFloors: SettingsSensitivityFloors(producers: [card.producer: .private], labels: [:]),
      foldPolicies: SettingsFoldPolicies(labels: [:]), settingsSeq: 1)
    await head.set(stamp: BriefStamp(seq: 10, date: "2026-11-12", settingsSeq: 1), settings: settings)

    #expect(await Sync(store: store, head: head, outbox: nil).sync())
    let after = try #require(try await store.storedCard(card.id))
    #expect(after.effectiveSensitivity == .private)
    #expect(after.changeSeq == card.changeSeq)
    #expect(try await store.meta(Meta.settingsSeq) == 1)
    #expect(try await store.meta(Meta.floors)?.producers[card.producer] == .private)
  }
}
