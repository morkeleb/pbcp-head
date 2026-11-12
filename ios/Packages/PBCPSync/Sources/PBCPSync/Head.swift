// What the outbox and the sync need from the head, as two small protocols: HeadClient conforms, and tests pass a fake.

import Foundation
import PBCPClient
import PBCPModels

/// The owner actions the outbox sends (docs/local-first.md "The outbox"), each answered with a typed outcome.
public protocol OwnerCommands: Sendable {
  func decide(id: String, _ body: DecisionRequest) async -> WriteOutcome<Card>
  func acknowledge(id: String) async -> WriteOutcome<Card>
  func snooze(id: String, _ body: SnoozeRequest) async -> WriteOutcome<Card>
  func unsnooze(id: String) async -> WriteOutcome<Card>
}

/// The reads the sync makes (docs/local-first.md "Sync").
public protocol FeedReader: Sendable {
  func getBriefStamp() async throws -> BriefStamp
  func cards(from: String?, to: String?, after: Int?) async throws -> CardList
  func getSettings() async throws -> Settings
  func getBrief(spoken: String?) async throws -> Brief
}

extension HeadClient: OwnerCommands, FeedReader {
  public func cards(from: String?, to: String?, after: Int?) async throws -> CardList {
    try await listCards(from: from, to: to, after: after, limit: 200)
  }
}
