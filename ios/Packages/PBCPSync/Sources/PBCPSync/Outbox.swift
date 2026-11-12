// The command outbox (docs/local-first.md "The outbox"; the web's app/(ui)/local/outbox.ts): the only thing on the
// device that writes to the head. A command settles the card on the device at once and appends a row; one task drains
// the rows in order through the owner routes, which are idempotent on the card, so a replay after a crash is safe.
//
//   2xx                        the row leaves; the head's card replaces the device's
//   409 (decided or replaced)  the head's state wins, the row is dropped
//   403 reauthentication_required (a confirm card)
//                              the row waits, and every row behind it, until the person identifies again (resume)
//   any other 4xx              the row is dropped; the card goes back to the head's state
//   no network, or 5xx         the row stays; tried again after 1 s, 10 s, 1 min, then every 5 min
//
// A row is never reordered: the person decided them in that order. A waiting row survives a relaunch: its status is
// in the store.

import Foundation
import PBCPClient
import PBCPModels
import PBCPStore

public actor Outbox {
  let store: Store
  let head: any OwnerCommands
  private var draining: Task<Void, Never>?
  private var retry: Task<Void, Never>?
  private var attempt = 0
  /// The backoff after a row could not be sent (seconds).
  public static let backoff: [Double] = [1, 10, 60, 300]
  /// What became of each command, by its client id (the model's Outcome), for the control that made it.
  public private(set) var outcomes: [String: Outcome] = [:]

  public init(store: Store, head: any OwnerCommands) {
    self.store = store
    self.head = head
  }

  /// Records a command for `card` and starts the sender: the card settles on the device at once.
  @discardableResult
  public func command(_ command: Command, card: MeCard) async throws -> OutboxRow {
    let row = try await store.enqueue(command, cardID: card.id, title: card.title, seenSeq: card.changeSeq)
    outcomes[row.clientId] = .waiting
    await drain()
    return row
  }

  /// Sends what waits, in order; joins a drain already running. Run on launch, on foreground, after every sync that
  /// reached the head, and when the network returns.
  public func drain() async {
    if let draining { return await draining.value }
    let task = Task { await self.sendAll() }
    draining = task
    await task.value
    draining = nil
  }

  /// The person identified themselves again: the waiting row for this card goes again, then those behind it.
  public func resume(cardID: String) async throws {
    guard var row = try await store.pending().first(where: { $0.cardId == cardID && $0.status == .needsPerson }) else { return }
    row.status = .pending
    try await store.update(row)
    await drain()
  }

  /// The person gave up on a waiting command: it is dropped and the card reverts; the rows behind it may go now.
  public func discard(cardID: String) async throws {
    for row in try await store.pending() where row.cardId == cardID {
      if let seq = row.seq { try await store.remove(seq) }
    }
    await drain()
  }

  private func sendAll() async {
    guard let rows = try? await store.pending() else { return }
    for (i, row) in rows.enumerated() {
      guard let seq = row.seq else { continue }
      if row.status == .needsPerson {
        // The rows behind it wait: they were decided after it.
        for r in rows[(i + 1)...] { outcomes[r.clientId] = .waiting }
        return
      }
      let answer = await send(row)
      switch answer {
      case .offline:
        var tried = row
        tried.tries += 1
        try? await store.update(tried)
        for r in rows[i...] { outcomes[r.clientId] = .waiting }
        scheduleRetry()
        return
      case .sent(let card):
        attempt = 0
        let merged = try? await merge(card)
        try? await store.remove(seq)
        if let merged { outcomes[row.clientId] = .sent(card: merged) }
      case .conflict(let card):
        attempt = 0
        let merged = try? await merge(card)
        try? await store.remove(seq)
        if let merged { outcomes[row.clientId] = .conflict(card: merged, message: nil) }
      case .needsPerson:
        attempt = 0
        var waiting = row
        waiting.status = .needsPerson
        try? await store.update(waiting)
        outcomes[row.clientId] = .needsPerson
        for r in rows[(i + 1)...] { outcomes[r.clientId] = .waiting }
        return
      case .refused(let status, let message):
        attempt = 0
        try? await store.remove(seq)
        outcomes[row.clientId] = .refused(status: status, message: message)
      }
    }
  }

  private func send(_ row: OutboxRow) async -> WriteOutcome<Card> {
    do {
      let command = try PBCPJSON.decoder().decode(Command.self, from: PBCPJSON.encoder().encode(["action": JSONValue.string(row.action.rawValue), "body": .object(row.body)]))
      switch command {
      case .decide(let body): return await head.decide(id: row.cardId, body)
      case .ack: return await head.acknowledge(id: row.cardId)
      case .snooze(let body): return await head.snooze(id: row.cardId, body)
      case .unsnooze: return await head.unsnooze(id: row.cardId)
      }
    } catch {
      return .refused(status: 400, message: "the row could not be read as a command")
    }
  }

  /// The head answers an owner action with the protocol card; the device keeps what the head rendered from its copy.
  private func merge(_ card: Card) async throws -> MeCard? {
    guard let stored = try await store.storedCard(card.id) else { return nil }
    var fields = try PBCPJSON.decoder().decode([String: JSONValue].self, from: PBCPJSON.encoder().encode(stored))
    let head = try PBCPJSON.decoder().decode([String: JSONValue].self, from: PBCPJSON.encoder().encode(card))
    fields.merge(head) { _, new in new }
    let merged = try PBCPJSON.decoder().decode(MeCard.self, from: PBCPJSON.encoder().encode(fields))
    try await store.apply([merged], force: true)
    return merged
  }

  private func scheduleRetry() {
    guard retry == nil else { return }
    let wait = Outbox.backoff[min(attempt, Outbox.backoff.count - 1)]
    attempt += 1
    retry = Task {
      try? await Task.sleep(for: .seconds(wait))
      await self.retried()
    }
  }

  private func retried() async {
    retry = nil
    await drain()
  }
}
